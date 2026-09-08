// electron/tests/agent/tools/task-tools-delegation.test.ts
//
// 任务委派信息闭环回归锁（spec 2026-09-08）：
// agent 此前无工具发现可指派目标——create_task 留空指派落 draft 死局。
// 本文件锁 list_delegation_targets 的三类清单 / isSelf·isCurrent 标记 /
// workspace 收窄 / 空类目提示。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import { __setTodosForTest } from '../../../src/main/agent/tools/todo-tools';
import { saveAgentDefinition, addMember, generateAgentUserId } from '../../../src/main/agent/crud';
import { createTeam, removeTeamMember } from '../../../src/main/agent/team';
import type { AgentDefinition } from '../../../src/main/agent/types';
import type { ToolContext } from '../../../src/main/agent/tools/types';

/** 构造最小可用 AgentDefinition（模式取自 capabilities-rebuild.test.ts makeDef） */
function makeDef(id: string, name: string, description: string): AgentDefinition {
  return {
    id,
    name,
    slug: id,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description,
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
  };
}

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-delegation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let REAL_WORKSPACE_ID = '';

function seedCtx(wsId: string, roomId: string): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: wsId,
    workspaceDir: '/tmp/ws',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ss-1',
    roomId,
    sendStreamChunk: () => undefined,
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '@real-owner:home',
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // 清空 todoStore——todoStore 是模块级单例，前序测试残留 user 挂靠会污染后续断言（spec §5.3 软门禁）
  __setTodosForTest('ss-1', []);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  __setTodosForTest('ss-1', []);
});

describe('list_delegation_targets（委派信息闭环）', () => {
  const tools = new TaskTools();

  it('工具已注册且无必填参数（workspaceId 走 ctx 注入）', () => {
    const def = tools.getDefs().find((d) => d.name === 'list_delegation_targets');
    expect(def).toBeDefined();
    expect(def!.inputSchema.required ?? []).toHaveLength(0);
    expect(tools.handles('list_delegation_targets')).toBe(true);
  });

  it('返回三类清单：agents 带 name 与 isSelf、teams 带 leaderName、sessions 带 isCurrent 且按最近活跃排序截 20', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const { insertSession, addSessionMember } = await import('../../../src/main/storage/sessions/repo');

    const ws = await createWorkspace(
      { name: 'T', directoryPath: '/tmp/ws-delegation', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    REAL_WORKSPACE_ID = ws.id;

    saveAgentDefinition(makeDef('def-exec', '测试执行者', '测试用 agent'));
    saveAgentDefinition(makeDef('def-z-aux', '辅助者', '辅助用 agent'));
    // createTeam 强制 ≥2 唯一成员；断言要求 memberCount=1——加第二成员过校验后 removeTeamMember 踢出，team.members.length 落 1。
    // 命名 def-z-aux 而非 def-aux：listMembers 经 idx_wam_unique(workspace_id, agent_definition_id) 返回按 def id 字典序，
    // 让 def-exec 排在 def-z-aux 前，确保 agents[0] = 测试执行者。
    const member = await addMember(REAL_WORKSPACE_ID, 'def-exec', generateAgentUserId('test-executor'));
    const aux = await addMember(REAL_WORKSPACE_ID, 'def-z-aux', generateAgentUserId('test-aux'));
    const session = insertSession({ workspaceId: REAL_WORKSPACE_ID, title: '当前会话', kind: 'chat' });
    addSessionMember(session.id, member.instanceId);
    const team = createTeam(
      REAL_WORKSPACE_ID,
      '执行团队',
      '👥',
      [member.instanceId, aux.instanceId],
      member.instanceId,
    );
    removeTeamMember(team.id, aux.instanceId);

    const result = JSON.parse(await tools.execute('list_delegation_targets', {}, seedCtx(REAL_WORKSPACE_ID, session.id)));

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]).toMatchObject({ instanceId: member.instanceId, name: '测试执行者', description: '测试用 agent', isSelf: true });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({ name: '执行团队', memberCount: 1, leaderName: '测试执行者' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: session.id, title: '当前会话', kind: 'chat', isCurrent: true });
    expect(result.notes).toHaveLength(0);
  });

  it('workspace 收窄：成员属于本 ws 才出现；空类目带提示', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const { insertSession } = await import('../../../src/main/storage/sessions/repo');

    const wsA = await createWorkspace(
      { name: 'A', directoryPath: '/tmp/ws-a', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    saveAgentDefinition(makeDef('def-a', 'A 的成员', ''));
    await addMember(wsA.id, 'def-a', generateAgentUserId('ws-a-member'));

    // 在另一个 workspace 视角查询：agents 应为空 + 有提示
    const wsB = await createWorkspace(
      { name: 'B', directoryPath: '/tmp/ws-b', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    const otherSession = insertSession({ workspaceId: wsB.id, title: 'B 会话', kind: 'chat' });

    const result = JSON.parse(await tools.execute('list_delegation_targets', {}, seedCtx(wsB.id, otherSession.id)));
    expect(result.agents).toHaveLength(0);
    expect(result.notes).toContain('本工作空间暂无 agent 成员，无法指派 assigneeAgentId');
    expect(result.notes).toContain('本工作空间暂无团队');
  });
});

describe('create_task 无指派 warning（委派信息闭环）', () => {
  const tools = new TaskTools();

  it('无指派创建 → 返回 TaskRow 字段仍在顶层 + warning 字段说明死局与出路', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'W', directoryPath: '/tmp/ws-warn', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    const result = JSON.parse(
      await tools.execute('create_task', { title: '无目标任务' }, seedCtx(ws.id, 'room-x')),
    );
    // 形状向后兼容：TaskRow 字段仍在顶层
    expect(result.id).toMatch(/^T-/);
    expect(result.status).toBe('draft');
    // warning 存在且包含关键事实
    expect(result.warning).toContain('没有自动指派机制');
    expect(result.warning).toContain('list_delegation_targets');
    expect(result.warning).toContain('draft');
  });

  it('有指派创建 + 有 user 挂靠 → 无 warning 字段 + 落 assigned（K1 决策表对齐——否则 executor 不消费，死局换形态）', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'W2', directoryPath: '/tmp/ws-warn2', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    saveAgentDefinition(makeDef('def-warn', '执行者', ''));
    const member = await addMember(ws.id, 'def-warn', generateAgentUserId('warn-executor'));
    // 种 user 挂靠 todo——避免触发软门禁（spec §5.3），单独验证 K1 路径无 warning
    __setTodosForTest('ss-1', [
      { id: 'todo-u1', subject: '用户要求的主任务', status: 'in_progress', source: 'user' },
    ]);
    const result = JSON.parse(
      await tools.execute(
        'create_task',
        { title: '有目标任务', assigneeAgentId: member.instanceId },
        seedCtx(ws.id, 'room-y'),
      ),
    );
    expect(result.id).toMatch(/^T-/);
    expect(result.status).toBe('assigned');
    expect(result.warning).toBeUndefined();
  });

  it('空串 assigneeAgentId="" 归一为无目标 → draft + warning（终审 N1：谓词分叉双重新话回归锁）', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'W3', directoryPath: '/tmp/ws-empty', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    const result = JSON.parse(
      await tools.execute('create_task', { title: '空串目标任务', assigneeAgentId: '' }, seedCtx(ws.id, 'room-z')),
    );
    expect(result.status).toBe('draft');
    expect(result.warning).toContain('没有自动指派机制');
  });
});
