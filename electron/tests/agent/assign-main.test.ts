// electron/tests/agent/assign-main.test.ts
//
// assignMainAgent 传递 subAgents + selectedSubDefIds 单元测试。
// 通过 vi.mock 替换 runtime-manager / bot-registrar / matrix 层 / allocation，
// 同时使用真实的 storage/db + keychain + workspace/crud + agent/crud，
// 验证：
//   1. main 实例的 spawnAgent 收到正确的 subAgents 数组（R1 核心修复）；
//   2. selectedSubDefIds 只安装选中的子 agent，未选的不被安装、不出现在 subAgents 中。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';

// mock runtime-manager（捕获 spawnAgent 参数）。
// vi.hoisted 保证 spawnAgentMock 在 vi.mock 工厂（被提升到文件顶部）执行时就绪，
// 避免 ReferenceError: Cannot access 'spawnAgentMock' before initialization。
const { spawnAgentMock } = vi.hoisted(() => ({ spawnAgentMock: vi.fn() }));
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: spawnAgentMock,
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));

// mock bot-registrar（避免真实 Matrix 调用）
vi.mock('../../src/main/agent/bot-registrar', () => ({
  registerAgentBot: vi.fn(async ({ slug }: { slug: string }) => ({
    botUserId: `@${slug}.ws.bot:localhost`,
    botAccessToken: 'fake-token',
    botDeviceId: 'DEV',
  })),
}));

// mock matrix 层
vi.mock('../../src/main/matrix/rooms', () => ({ inviteBotToRoom: vi.fn(async () => {}) }));
vi.mock('../../src/main/matrix/session', () => ({ getOwnerMatrixClient: vi.fn(async () => ({})) }));

// mock allocation（返回空能力合并）
vi.mock('../../src/main/workspace/allocation', () => ({ getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], mcps: [], skills: [] })) }));

const tmpRoot = path.join(os.tmpdir(), `ap-assign-main-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  spawnAgentMock.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('assignMainAgent', () => {
  it('main 实例的 spawnAgent 收到正确的 subAgents 数组', async () => {
    // 准备 main + 2 个 sub 定义
    saveAgentDefinition({
      id: 'main-1', name: 'PM', slug: 'pm', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: '你是 PM',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'PM agent', iconEmoji: '📋',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 'sub-1', name: 'Coder', slug: 'coder', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: '你是程序员',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: '写代码', iconEmoji: '🔗',
      parentAgentId: 'main-1',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 'sub-2', name: 'Analyst', slug: 'analyst', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: '你是分析师',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: '分析需求', iconEmoji: '🔗',
      parentAgentId: 'main-1',
      defaultMcps: [], defaultSkills: [],
    });

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    const { assignMainAgent } = await import('../../src/main/agent/ipc.handlers');
    const results = await assignMainAgent({ workspaceId: ws.id, mainDefId: 'main-1', llmApiKey: 'test-key' });

    // 安装了 3 个 agent（main + 2 subs）
    expect(results).toHaveLength(3);

    // 找到 main 的 spawnAgent 调用
    const mainSpawn = spawnAgentMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { agentType?: string }).agentType === 'main',
    );
    expect(mainSpawn).toBeDefined();
    const mainOpts = mainSpawn![0] as { subAgents?: Array<{ slug: string }> };
    // ★ R1 核心断言：main 收到了 subAgents
    expect(mainOpts.subAgents).toBeDefined();
    expect(mainOpts.subAgents).toHaveLength(2);
    expect(mainOpts.subAgents!.map((s) => s.slug).sort()).toEqual(['analyst', 'coder']);
  });

  it('selectedSubDefIds 只安装选中的子 agent', async () => {
    saveAgentDefinition({
      id: 'main-2', name: 'PM', slug: 'pm2', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: '你是 PM',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'PM', iconEmoji: '📋',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 'sub-a', name: 'A', slug: 'sub-a', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'A',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'A', iconEmoji: '🔗',
      parentAgentId: 'main-2',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 'sub-b', name: 'B', slug: 'sub-b', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'B',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'B', iconEmoji: '🔗',
      parentAgentId: 'main-2',
      defaultMcps: [], defaultSkills: [],
    });

    const ws = await createWorkspace(
      { name: 'w2', description: '', directoryPath: path.join(tmpRoot, 'ws2'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    const { assignMainAgent } = await import('../../src/main/agent/ipc.handlers');
    const results = await assignMainAgent({
      workspaceId: ws.id, mainDefId: 'main-2', llmApiKey: 'k',
      selectedSubDefIds: ['sub-a'],  // 只选 sub-a
    });

    expect(results).toHaveLength(2); // main + sub-a

    const mainSpawn = spawnAgentMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { agentType?: string }).agentType === 'main',
    );
    const mainOpts = mainSpawn![0] as { subAgents?: unknown[] };
    expect(mainOpts.subAgents).toHaveLength(1);
    expect((mainOpts.subAgents![0] as { slug: string }).slug).toBe('sub-a');
  });
});