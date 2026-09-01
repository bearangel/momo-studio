// workspace:setDefaultAgent 自动重启单测（v25 重写）
//
// 验证：设定默认会话 agent 后，若该实例正在运行，主进程自动停止并重启——
// 重启产出的 AGENT_CONFIG 按会话快照重新计算（spec §4.7）。
// v1 语义（重启注入 isCoordinator=true）已随 v25 退役：默认 agent 标志不再进
// 线协议，isLeader/subAgents 改由 buildDispatchSnapshot 会话快照计算。
//
// 捕获方式：mock electron.ipcMain.handle，把 workspace:setDefaultAgent 回调存入 Map，
// 测试直接调用捕获的回调 —— 验证的是真实生产 handler（而非逻辑副本），与
// agent/ipc-validation.test.ts 同一约定。
//
// runtime-status / runtime-registry 被 mock（避免真实子进程）；allocation 被 mock 返回空分配；
// 其余（storage/db + keychain + workspace/crud + agent/crud.addMember + sessions/repo）走真实实现。
// agent_definitions 用 raw SQL seed（v25 已删 workspace_id 列；saveAgentDefinition 尚未对齐，
// 属独立清理项，不在此处牵入）。

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { addMember } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';

// 捕获 ipcMain.handle 注册的回调（vi.hoisted 保证在 vi.mock 工厂提升前就绪）
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
// runtime mock 引用需要 hoisted
const { stopAgentMock, spawnAgentMock, isAgentRunningMock } = vi.hoisted(() => ({
  stopAgentMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  isAgentRunningMock: vi.fn(() => false),
}));

// mock runtime-status：通过 isAgentRunningMock 控制运行状态
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: isAgentRunningMock,
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: (opts: unknown) => spawnAgentMock(opts),
  stopAgentRuntime: async (id: string) => stopAgentMock(id),
}));

// mock allocation：避免依赖 workspace_allocations 表，返回空分配即可
vi.mock('../../src/main/workspace/allocation', () => ({
  getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], skills: [], mcps: [] })),
}));

// mock electron：捕获 ipcMain.handle 注册的 handler 供测试直接调用
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

let registerWorkspaceHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-coord-restart-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) {
    memStore.set(k, v);
  },
  async getSecret(k) {
    return memStore.get(k) ?? null;
  },
  async deleteSecret(k) {
    memStore.delete(k);
  },
};

beforeAll(async () => {
  const mod = await import('../../src/main/workspace/ipc.handlers');
  registerWorkspaceHandlers = mod.registerWorkspaceHandlers;
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES ('prov-1', 'Test Provider', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1, 'openai')`,
  ).run();
  handlers.clear();
  registerWorkspaceHandlers();
  stopAgentMock.mockClear();
  spawnAgentMock.mockClear();
  isAgentRunningMock.mockImplementation(() => false);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** raw SQL 落一个最小 agent 定义（v25 列；saveAgentDefinition 尚带已删列不可用） */
function seedDef(defId: string, slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', '🤖', 'prov-1', 'gpt-4o', 1)`,
    )
    .run(defId, slug, slug);
}

/** 建 workspace + 成员实例，预填 keychain；返回 { wsId, instanceId, agentUserId } */
async function seedRunningMember(
  wsName: string, defId: string, slug: string,
): Promise<{ wsId: string; instanceId: string; agentUserId: string }> {
  const ws = await createWorkspace(
    { name: wsName, description: '', directoryPath: path.join(tmpRoot, wsName), iconEmoji: '📁' },
    '@o:localhost',
  );
  const member = await addMember(ws.id, defId, `agent-${slug}-ab12`);
  memStore.set('provider.prov-1.api_key', 'llm-key');
  return { wsId: ws.id, instanceId: member.instanceId, agentUserId: member.agentUserId };
}

describe('setDefaultAgent 自动重启（v25）', () => {
  it('实例运行中：设定默认 agent 后自动停止并以会话快照配置重启', async () => {
    seedDef('def-1', 'a');
    const { wsId, instanceId, agentUserId } = await seedRunningMember('w', 'def-1', 'a');
    isAgentRunningMock.mockImplementation(() => true);

    const handler = handlers.get('workspace:setDefaultAgent')!;
    await handler({}, wsId, instanceId);

    expect(stopAgentMock).toHaveBeenCalledTimes(1);
    expect(stopAgentMock).toHaveBeenCalledWith(instanceId);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const opts = spawnAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.instanceId).toBe(instanceId);
    expect(opts.agentUserId).toBe(agentUserId);
    expect(opts.workspaceId).toBe(wsId);
    // v25 过渡态：团队会话列已退役，线协议保持空串
    expect(opts.teamSessionId).toBe('');
    // 无会话快照 → 非 leader，不带 dispatch 工具
    expect(opts.isLeader).toBe(false);
    expect(opts.subAgents).toEqual([]);
  });

  it('实例未运行：只写 defaultAgentInstanceId，不 stop/spawn', async () => {
    seedDef('def-2', 'b');
    const { wsId, instanceId } = await seedRunningMember('w2', 'def-2', 'b');

    const handler = handlers.get('workspace:setDefaultAgent')!;
    await handler({}, wsId, instanceId);

    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('清空默认 agent（instanceId=null）：不触发重启', async () => {
    seedDef('def-3', 'c');
    const { wsId } = await seedRunningMember('w3', 'def-3', 'c');
    isAgentRunningMock.mockImplementation(() => true);

    const handler = handlers.get('workspace:setDefaultAgent')!;
    await handler({}, wsId, null);

    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('多成员会话 leader 重启 → spawn 收到快照 subAgents（C1 精神 v25 版）', async () => {
    seedDef('def-pm', 'pm');
    seedDef('def-coder', 'coder');
    const { wsId, instanceId } = await seedRunningMember('w-main', 'def-pm', 'pm');
    const db = getDb();
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES ('inst-coder-main', ?, 'def-coder', 'agent-coder-ab12')`,
    ).run(wsId);
    const session = insertSession({ workspaceId: wsId, title: 'T' });
    addSessionMember(session.id, instanceId, true);
    addSessionMember(session.id, 'inst-coder-main', false);

    isAgentRunningMock.mockImplementation(() => true);
    const handler = handlers.get('workspace:setDefaultAgent')!;
    await handler({}, wsId, instanceId);

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const opts = spawnAgentMock.mock.calls[0]![0] as {
      isLeader?: boolean;
      subAgents?: Array<{ slug: string; assignmentId: string }>;
    };
    // 重启路径保 dispatch 快照：leader + 除自己外的成员名单
    expect(opts.isLeader).toBe(true);
    expect(opts.subAgents).toHaveLength(1);
    expect(opts.subAgents![0]!.slug).toBe('coder');
    expect(opts.subAgents![0]!.assignmentId).toBe('inst-coder-main');
  });
});
