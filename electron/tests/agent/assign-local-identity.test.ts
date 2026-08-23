// electron/tests/agent/assign-local-identity.test.ts
//
// v2（Task 10）：agent 分配流程去 Matrix。
//   1. generateAgentUserId 生成本地身份 'agent-<slug>-<6位随机后缀>'
//   2. agent:addToWorkspace 流程：不再调 registerAgentBot / inviteBotToRoom，
//      assignment.agent_user_id 为本地身份，且自动写入团队会话成员表
//      （session_members）——取代原"注册 bot + 邀请进团队群"
//
// 通过 mock electron.ipcMain.handle 捕获真实注册的 handler 直接调用
// （与 ipc-stop-start.test.ts 同一约定）。

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// vi.hoisted 保证 ipcHandlers 在 vi.mock 工厂提升前就绪
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// v1 runtime 机器 mock（本测试不启动真实子进程）
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

// runtime-registry：保留真实 Maps，只把 startAgentRuntime 替成 spy
vi.mock('../../src/main/agent/runtime-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/runtime-registry')>();
  return {
    ...actual,
    startAgentRuntime: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/main/agent/builtin', () => ({
  getBuiltinSuggestionsMap: vi.fn(() => ({})),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, generateAgentUserId } from '../../src/main/agent/crud';
import { listSessionMembers } from '../../src/main/storage/sessions/repo';
import { startAgentRuntime } from '../../src/main/agent/runtime-registry';
import type { AgentDefinition } from '../../src/main/agent/types';

let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-assign-local-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
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
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test', 'https://api.test.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  // resolveApiKey 走 keychain：预置 provider key
  memStore.set('provider.prov-1.api_key', 'test-llm-key');
  ipcHandlers.clear();
  vi.mocked(startAgentRuntime).mockClear();
  registerAgentHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

function makeDef(id: string, slug: string): AgentDefinition {
  const def: AgentDefinition = {
    id, name: slug, slug, version: '1.0',
    runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], source: 'custom',
    description: 'd', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    taskDriven: true,
  };
  saveAgentDefinition(def);
  return def;
}

describe('generateAgentUserId — 本地身份生成', () => {
  it('格式为 agent-<slug>-<6位随机后缀>', () => {
    const id = generateAgentUserId('requirement-analyst');
    expect(id).toMatch(/^agent-requirement-analyst-[A-Za-z0-9_-]{6}$/);
  });

  it('slug 规范化：大写折叠小写、非法字符折叠短横线', () => {
    const id = generateAgentUserId('My Agent!Bot');
    expect(id).toMatch(/^agent-my-agent-bot-[A-Za-z0-9_-]{6}$/);
  });

  it('多次调用生成不同身份（随机后缀）', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateAgentUserId('coder')));
    expect(ids.size).toBe(50);
  });
});

describe('agent:addToWorkspace — 分配即入团队会话（去 Matrix）', () => {
  it('生成本地 agent_user_id 并写入 session_members（不注册 bot / 不邀请房间）', async () => {
    const ws = await createWorkspace(
      { name: 'W', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    makeDef('def-1', 'coder-bot');

    const handler = ipcHandlers.get('agent:addToWorkspace');
    expect(handler).toBeDefined();

    const assignment = (await handler!(null, {
      workspaceId: ws.id,
      agentDefinitionId: 'def-1',
      role: 'standalone',
    })) as { instanceId: string; agentUserId: string };

    // 本地身份格式
    expect(assignment.agentUserId).toMatch(/^agent-coder-bot-[A-Za-z0-9_-]{6}$/);

    // 团队会话成员表：assignment 自动加入 workspace 团队会话
    const members = listSessionMembers(ws.teamSessionId);
    expect(members.map((m) => m.assignmentId)).toContain(assignment.instanceId);

    // runtime 启动收到新形状 opts：携带本地身份 + 团队会话 ID，无 Matrix 凭据
    expect(startAgentRuntime).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startAgentRuntime).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.agentUserId).toBe(assignment.agentUserId);
    expect(opts.teamSessionId).toBe(ws.teamSessionId);
    expect(opts).not.toHaveProperty('botUserId');
    expect(opts).not.toHaveProperty('botAccessToken');
    expect(opts).not.toHaveProperty('homeserverUrl');
  });
});
