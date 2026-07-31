// electron/tests/agent/agent-start-subagents.test.ts
//
// C1 回归测试：main agent 通过 agent:start 手动重启后，
// spawnAgent 仍能收到正确的 subAgents 数组（dispatch 工具不丢失）。
//
// 捕获方式：mock electron.ipcMain.handle 捕获 agent:start 回调，直接调用。
// runtime-manager 被 mock（避免 fork 真实子进程）；allocation 被 mock 返回空分配；
// matrix 层被 mock（模块加载需要）；其余走真实实现（DB + keychain + crud）。

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// 捕获 ipcMain.handle 注册的回调
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
// runtime-manager mock 引用
const { spawnAgentMock } = vi.hoisted(() => ({ spawnAgentMock: vi.fn() }));

vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: spawnAgentMock,
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));

// mock allocation：返回空分配
vi.mock('../../src/main/workspace/allocation', () => ({
  getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], skills: [], mcps: [] })),
}));

// mock matrix 层（ipc.handlers 模块加载需要这些导入存在）
vi.mock('../../src/main/matrix/rooms', () => ({ inviteBotToRoom: vi.fn() }));
vi.mock('../../src/main/matrix/session', () => ({ getOwnerMatrixClient: vi.fn() }));
vi.mock('../../src/main/matrix/sync-manager', () => ({ getSyncingClient: vi.fn() }));
vi.mock('../../src/main/matrix/client', () => ({ createMatrixClient: vi.fn() }));
vi.mock('../../src/main/agent/bot-registrar', () => ({ registerAgentBot: vi.fn() }));

// mock electron：捕获 ipcMain.handle 注册的 handler
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-start-subs-${Date.now()}-${process.pid}`);
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
  const mod = await import('../../src/main/agent/ipc.handlers');
  registerAgentHandlers = mod.registerAgentHandlers;
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  handlers.clear();
  registerAgentHandlers();
  spawnAgentMock.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造 main agent 定义（带 2 个 sub）并落库 */
function setupMainWithSubs(): {
  mainDef: AgentDefinition;
  mainAssignment: { instanceId: string; agentDefinitionId: string; botMatrixUserId: string };
} {
  const mainDef: AgentDefinition = {
    id: 'main-c1', name: 'PM', slug: 'pm-c1', version: '1.0', type: 'main',
    runtime: 'declarative', systemPrompt: '你是 PM',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [], source: 'builtin', description: 'PM agent', iconEmoji: '📋',
    defaultMcps: [], defaultSkills: [],
  };
  const sub1: AgentDefinition = {
    id: 'sub-c1-1', name: 'Coder', slug: 'coder-c1', version: '1.0', type: 'sub',
    runtime: 'declarative', systemPrompt: '你是程序员',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [], source: 'builtin', description: '写代码', iconEmoji: '🔗',
    parentAgentId: 'main-c1',
    defaultMcps: [], defaultSkills: [],
  };
  const sub2: AgentDefinition = {
    id: 'sub-c1-2', name: 'QA', slug: 'qa-c1', version: '1.0', type: 'sub',
    runtime: 'declarative', systemPrompt: '你是测试',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [], source: 'builtin', description: '测代码', iconEmoji: '🔗',
    parentAgentId: 'main-c1',
    defaultMcps: [], defaultSkills: [],
  };
  saveAgentDefinition(mainDef);
  saveAgentDefinition(sub1);
  saveAgentDefinition(sub2);
  return { mainDef, mainAssignment: { instanceId: '', agentDefinitionId: '', botMatrixUserId: '' } };
}

describe('agent:start — main agent 重启后 subAgents 不丢失（C1）', () => {
  it('main agent 通过 agent:start 手动启动 → spawnAgent 收到正确 subAgents', async () => {
    setupMainWithSubs();

    const ws = await createWorkspace(
      { name: 'w-c1', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!team-c1:localhost',
    );

    // 分配 main + 2 subs 到 workspace（模拟 assignMain 已安装的场景）
    const mainAssignment = assignAgentToWorkspace(ws.id, 'main-c1', '@pm-c1:localhost');
    assignAgentToWorkspace(ws.id, 'sub-c1-1', '@coder-c1:localhost');
    assignAgentToWorkspace(ws.id, 'sub-c1-2', '@qa-c1:localhost');

    // 预填 keychain：agent:start 需要从中恢复 apiKey 和 bot token
    memStore.set(`agent.${mainAssignment.instanceId}.llm_api_key`, 'llm-key');
    memStore.set('bot.@pm-c1:localhost.matrix_token', 'mx-token');

    // 调用 agent:start handler
    const handler = handlers.get('agent:start')!;
    await handler({}, {
      assignment: mainAssignment,
      workspaceId: ws.id,
      teamRoomId: ws.teamRoomId!,
    });

    // ★ C1 核心断言：spawnAgent 收到了 main 的 subAgents
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const opts = spawnAgentMock.mock.calls[0]![0] as {
      agentType?: string;
      subAgents?: Array<{ slug: string; botUserId: string }>;
    };
    expect(opts.agentType).toBe('main');
    expect(opts.subAgents).toBeDefined();
    expect(opts.subAgents).toHaveLength(2);
    expect(opts.subAgents!.map((s) => s.slug).sort()).toEqual(['coder-c1', 'qa-c1']);
    // botUserId 来自 DB assignment 记录
    expect(opts.subAgents!.map((s) => s.botUserId).sort()).toEqual([
      '@coder-c1:localhost',
      '@qa-c1:localhost',
    ]);
  });
});
