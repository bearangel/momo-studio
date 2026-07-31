// electron/tests/agent/auto-start.test.ts
//
// autoStartAgents 单元测试。
// 通过 vi.mock 替换 runtime-manager / allocation，
// 同时使用真实的 storage/db + keychain + workspace/crud + agent/crud，
// 验证：
//   1. 重启后 main agent 的 spawnAgent 收到正确的 subAgents 数组（R2 核心修复）；
//   2. subAgents 根据 definition.parentAgentId 和 workspace 的 assignment 关系重建。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';

// vi.hoisted 保证 spawnAgentMock 在 vi.mock 工厂（被提升到文件顶部）执行时就绪，
// 避免 ReferenceError: Cannot access 'spawnAgentMock' before initialization。
const { spawnAgentMock } = vi.hoisted(() => ({ spawnAgentMock: vi.fn() }));
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: spawnAgentMock,
  isAgentRunning: vi.fn(() => false),
}));

vi.mock('../../src/main/workspace/allocation', () => ({ getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], skills: [], mcps: [] })) }));

const tmpRoot = path.join(os.tmpdir(), `ap-auto-start-${Date.now()}`);
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

describe('autoStartAgents', () => {
  it('main 实例从 DB 重建正确的 subAgents', async () => {
    // 创建 main + 2 subs 定义
    saveAgentDefinition({
      id: 'm1', name: 'Main', slug: 'main', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'main', iconEmoji: '📋',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 's1', name: 'Sub1', slug: 'sub1', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'sub1', iconEmoji: '🔗',
      parentAgentId: 'm1',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 's2', name: 'Sub2', slug: 'sub2', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'sub2', iconEmoji: '🔗',
      parentAgentId: 'm1',
      defaultMcps: [], defaultSkills: [],
    });

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    // 分配 main + subs 到 workspace
    assignAgentToWorkspace(ws.id, 'm1', '@main:localhost');
    assignAgentToWorkspace(ws.id, 's1', '@sub1:localhost');
    assignAgentToWorkspace(ws.id, 's2', '@sub2:localhost');

    // 模拟 keychain 中有 token 和 apiKey
    memStore.set('agent.@main:localhost-something.llm_api_key', 'key'); // 占位
    // auto-start 读 keychain 的 key 是 agent.<instanceId>.llm_api_key 和 bot.<userId>.matrix_token
    // 需要知道 instanceId — assignAgentToWorkspace 生成随机的，所以直接预填
    // 更简单：mock keychain 返回非 null
    const originalGetSecret = memKeychain.getSecret;
    memKeychain.getSecret = async () => 'fake-secret';

    const { autoStartAgents } = await import('../../src/main/agent/auto-start');
    await autoStartAgents();

    // 找到 main 的 spawnAgent 调用
    const mainSpawn = spawnAgentMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { agentType?: string }).agentType === 'main',
    );
    expect(mainSpawn).toBeDefined();
    const mainOpts = mainSpawn![0] as { subAgents?: Array<{ slug: string; botUserId: string }> };
    // ★ R2 核心断言：重启后 main 仍然有 2 个 subAgents
    expect(mainOpts.subAgents).toBeDefined();
    expect(mainOpts.subAgents).toHaveLength(2);
    expect(mainOpts.subAgents!.map((s) => s.slug).sort()).toEqual(['sub1', 'sub2']);

    memKeychain.getSecret = originalGetSecret;
  });
});
