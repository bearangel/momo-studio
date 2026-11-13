// electron/tests/agent/tools/task-tools-routing.test.ts
//
// create_task 路由分支 + list_workgroups 契约（1.10.1 agent 路由面补齐——
// 病灶会话「文件已建任务指派受阻」：agent 词汇表无工作组域，用户意图无法表达）。
// 保真纪律：走真实 submitRoutedTask 全链，仅替身 hub 边界（listGroups/delegate）；
// createRemoteTask/deriveBlockedBy/updateDelegationLink 用真实现（DB 落行可断言）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { createTask, listWorkgroups } from '../../../src/main/agent/tools/task-tools';
import { createHubConfigStore } from '../../../src/main/hub/config-store';
import type { DispatchSubmitPorts } from '../../../src/main/hub/dispatch-submit';
import { insertTaskWithRelations } from '../../../src/main/task/relations';
import { deriveBlockedBy } from '../../../src/main/storage/tasks/dependencies-repo';
import { updateTask } from '../../../src/main/storage/tasks/repo';
import type { DelegationTaskBrief } from '../../../src/main/hub/dispatch-submit';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tmpRoot = path.join(os.tmpdir(), `ap-task-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SELF = 'self-node';

/** 组夹具：peer 组（平衡节点）+ lf 组（研发组） */
function fixtureGroups() {
  return [
    {
      groupId: 'g-peer',
      groupName: '平衡节点',
      mode: 'peer' as const,
      leaderNodeId: SELF,
      members: [
        { nodeId: SELF, name: 'xxx-1', online: true },
        { nodeId: 'n-2', name: 'yyyy-1', online: true, protoVer: '1.10.0', bound: true, boundWorkspaceName: '123' },
      ],
    },
    {
      groupId: 'g-lf',
      groupName: '研发组',
      mode: 'leader-follower' as const,
      leaderNodeId: SELF,
      members: [
        { nodeId: SELF, name: 'xxx-1', online: true },
        { nodeId: 'n-3', name: 'zzz-1', online: true, protoVer: '1.10.0' },
      ],
    },
  ];
}

/** 假端口：hub 边界（listGroups/delegate）替身，DB 面全真 */
function makePorts(opts: { delegateOk?: boolean; groups?: ReturnType<typeof fixtureGroups> } = {}): {
  ports: DispatchSubmitPorts;
  briefs: DelegationTaskBrief[];
} {
  const briefs: DelegationTaskBrief[] = [];
  const ports: DispatchSubmitPorts = {
    listGroups: async () => opts.groups ?? fixtureGroups(),
    getTeamSnapshot: () => ({ name: 'ws2团队', members: [{ agentName: 'Architect', isLeader: true }] }),
    hubProtoVer: () => '1.10.0',
    listDelegations: async () => [],
    // lf 组内调度按镜像登记过滤候选（n-3 已镜像本工作空间）
    listMirrorRegistry: () => [{ groupId: 'g-lf', targetNodeId: 'n-3', workspaceName: '研发空间' }],
    delegate: async (brief) => {
      if (opts.delegateOk === false) throw new Error('[forbidden] test 拒绝');
      briefs.push(brief);
      return { taskId: 'del-1' };
    },
    createLocalTask: (input) => insertTaskWithRelations({
      workspaceId: input.workspaceId, title: input.title, creatorUserId: 'owner',
      status: 'draft', description: input.description ?? '', groupId: input.groupId,
    }, { dependsOn: input.dependsOn ?? [] }),
    createRemoteTask: (input) => insertTaskWithRelations({
      workspaceId: input.workspaceId, title: input.title, creatorUserId: 'owner',
      status: input.status, description: input.description, groupId: input.groupId,
      routing: input.routing, targetTeamId: input.targetTeamId ?? null,
      ...(input.draft === true ? { origin: 'peer_draft' as const } : {}),
    }, { dependsOn: input.dependsOn ?? [] }),
    deriveBlockedBy: (taskId) => deriveBlockedBy([taskId]).get(taskId) ?? [],
    // 生产同构（dispatch-ports.ts）：P1 降级守卫行戳随 delegation_id 一并落行
    updateDelegationLink: (taskId, delegationId, routing, p1Stamp) => { updateTask(taskId, { delegationId, routing, ...p1Stamp }); },
  };
  return { ports, briefs };
}

/** 原始 DB 行（snake_case 列名——测试直读库，不经 repo 的 camel 映射） */
function taskRow(id: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', '研发空间', '/tmp/ws1', '@owner:home');
  createHubConfigStore(getDb()).write({
    hubUrl: 'https://hub.example.com:8787', nodeName: 'xxx-1', nodeId: SELF,
    deviceToken: 'tok-x', createdAt: Date.now(),
  } as Parameters<ReturnType<typeof createHubConfigStore>['write']>[0]);
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('list_workgroups', () => {
  it('返回组清单：模式标签/成员绑定态——peer 与 lf 两形态齐全', async () => {
    const { ports } = makePorts();
    const groups = await listWorkgroups({ ports });
    const peer = groups.find((g) => g.groupId === 'g-peer')!;
    expect(peer.modeLabel).toBe('平行模式');
    expect(peer.members.find((m) => m.nodeId === 'n-2')).toMatchObject({ name: 'yyyy-1', online: true, bound: true, boundWorkspaceName: '123' });
    expect(groups.find((g) => g.groupId === 'g-lf')!.modeLabel).toBe('主从模式');
  });

  it('hub 未连接 → 人话错误（错误路径专项）', async () => {
    const { ports } = makePorts();
    ports.listGroups = async () => { throw new Error('connection refused'); };
    await expect(listWorkgroups({ ports })).rejects.toThrow('hub 未连接');
  });
});

describe('create_task 路由分支', () => {
  it('peer 组指定节点 → draft 白名单载荷（仅 title/prompt/priority）+ 行 origin=peer_draft + delegationId 回写', async () => {
    const { ports, briefs } = makePorts();
    const result = await createTask({
      workspaceId: 'ws1', title: 'yyy-任务分配测试', creatorUserId: '@owner:home',
      description: '写 test.txt', priority: 5,
      routing: { mode: 'node', groupId: 'g-peer', targetNodeId: 'n-2' },
    }, { ports });
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('n-2');
    expect(briefs).toHaveLength(1);
    const payload = briefs[0]!.task as Record<string, unknown>;
    expect(payload['draft']).toBe(true);
    expect(payload['priority']).toBe(5);
    expect(payload['team']).toBeUndefined();
    expect(payload['permissionTier']).toBeUndefined();
    const row = taskRow(result.id);
    expect(row?.status).toBe('pending');
    expect(row?.origin).toBe('peer_draft');
    expect(row?.['delegation_id']).toBe('del-1');
  });

  it('lf 组内调度 → 编排载荷（permissionTier=confirm）+ 行 pending', async () => {
    const { ports, briefs } = makePorts();
    const result = await createTask({
      workspaceId: 'ws1', title: '调研任务', creatorUserId: '@owner:home',
      routing: { mode: 'group', groupId: 'g-lf' },
    }, { ports });
    expect(result.dispatched).toBe(true);
    const payload = briefs[0]!.task as Record<string, unknown>;
    expect(payload['draft']).toBeUndefined();
    expect(payload['permissionTier']).toBe('confirm');
    expect(taskRow(result.id)?.status).toBe('pending');
  });

  it('互斥键早拒（人话）：assigneeAgentId / peer+team / peer+dependsOn / peer+组内调度 / 组不存在 / 非组长', async () => {
    const { ports } = makePorts();
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      assigneeAgentId: 'agent-1', routing: { mode: 'group', groupId: 'g-lf' },
    }, { ports })).rejects.toThrow('互斥');
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u', targetTeamId: 'team-1',
      routing: { mode: 'node', groupId: 'g-peer', targetNodeId: 'n-2' },
    }, { ports })).rejects.toThrow('团队执行编排');
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u', dependsOn: ['T-001'],
      routing: { mode: 'node', groupId: 'g-peer', targetNodeId: 'n-2' },
    }, { ports })).rejects.toThrow('dependsOn');
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-peer' },
    }, { ports })).rejects.toThrow('指定节点');
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-none' },
    }, { ports })).rejects.toThrow('list_workgroups');
    // 非组长：组长是别的节点 → 早拒（delegate leader-only 黑洞防线）
    const memberGroups = fixtureGroups().map((g) => ({ ...g, leaderNodeId: 'other-node' }));
    const memberSide = makePorts({ groups: memberGroups });
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-lf' },
    }, { ports: memberSide.ports })).rejects.toThrow('组长');
  });

  it('hub 未连接 → 人话（可回退本机）（错误路径专项）', async () => {
    const { ports } = makePorts();
    ports.listGroups = async () => { throw new Error('connection refused'); };
    await expect(createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-lf' },
    }, { ports })).rejects.toThrow('本机执行');
  });

  it('delegate 瞬断 → 行照落 pending、dispatched=false（RM-M21-5 兜底零变化）', async () => {
    const { ports } = makePorts({ delegateOk: false });
    const result = await createTask({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-lf' },
    }, { ports });
    expect(result.dispatched).toBe(false);
    const row = taskRow(result.id);
    expect(row?.status).toBe('pending');
    expect(row?.['delegation_id']).toBeNull();
  });

  it('无 routing → 既有本机路径零变化（draft + warning 由 execute 层负责）', async () => {
    const { ports, briefs } = makePorts();
    const result = await createTask({
      workspaceId: 'ws1', title: '本机任务', creatorUserId: 'u',
    }, { ports });
    expect(result.status).toBe('draft');
    expect(result.dispatched).toBeUndefined();
    expect(briefs).toHaveLength(0);
  });
});
