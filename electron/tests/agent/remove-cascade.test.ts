// electron/tests/agent/remove-cascade.test.ts
//
// removeAgentAssignment 级联删除测试：当删除一个 main agent 分配时，
// 同 workspace 内的 sub agent 分配应当被一并删除。删除 sub 时不影响 main。
//
// 用真实 SQLite + in-memory keychain，runtime/matrix 用 mock 替换。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  assignAgentToWorkspace,
  listAssignments,
  getAgentDefinition,
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';

vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: vi.fn(),
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/matrix/rooms', () => ({ inviteBotToRoom: vi.fn() }));
vi.mock('../../src/main/matrix/session', () => ({ getOwnerMatrixClient: vi.fn(async () => ({})) }));
vi.mock('../../src/main/matrix/sync-manager', () => ({ getSyncingClient: vi.fn(() => null) }));
vi.mock('../../src/main/matrix/client', () => ({ createMatrixClient: vi.fn(() => ({})) }));

const tmpRoot = path.join(os.tmpdir(), `ap-cascade-${Date.now()}`);
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
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('removeAgentAssignment 级联', () => {
  it('删除 main 时级联删除其 subs', async () => {
    saveAgentDefinition({
      id: 'm1', name: 'Main', slug: 'main', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'm', iconEmoji: '📋',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 's1', name: 'Sub', slug: 'sub1', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 's', iconEmoji: '🔗',
      parentAgentId: 'm1',
      defaultMcps: [], defaultSkills: [],
    });

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    const mainA = assignAgentToWorkspace(ws.id, 'm1', '@main:localhost');
    const subA = assignAgentToWorkspace(ws.id, 's1', '@sub:localhost');

    // 存假 token 供 makeBotLeaveAllRooms 使用
    memStore.set('bot.@main:localhost.matrix_token', 't');
    memStore.set('bot.@sub:localhost.matrix_token', 't');

    const { removeAgentAssignment } = await import('../../src/main/agent/ipc.handlers');
    await removeAgentAssignment(mainA.instanceId);

    // main + sub 都应被删除
    const remaining = listAssignments(ws.id);
    expect(remaining).toHaveLength(0);
  });

  it('删除 sub 时不影响 main', async () => {
    saveAgentDefinition({
      id: 'm2', name: 'Main', slug: 'main2', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 'm', iconEmoji: '📋',
      defaultMcps: [], defaultSkills: [],
    });
    saveAgentDefinition({
      id: 's2', name: 'Sub', slug: 'sub2', version: '1.0', type: 'sub',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: 's', iconEmoji: '🔗',
      parentAgentId: 'm2',
      defaultMcps: [], defaultSkills: [],
    });

    const ws = await createWorkspace(
      { name: 'w2', description: '', directoryPath: path.join(tmpRoot, 'ws2'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    const mainA = assignAgentToWorkspace(ws.id, 'm2', '@main2:localhost');
    const subA = assignAgentToWorkspace(ws.id, 's2', '@sub2:localhost');
    memStore.set('bot.@sub2:localhost.matrix_token', 't');

    const { removeAgentAssignment } = await import('../../src/main/agent/ipc.handlers');
    await removeAgentAssignment(subA.instanceId);

    const remaining = listAssignments(ws.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.instanceId).toBe(mainA.instanceId);
  });
});
