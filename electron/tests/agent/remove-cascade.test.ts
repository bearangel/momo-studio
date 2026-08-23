// electron/tests/agent/remove-cascade.test.ts
//
// removeAgentAssignment 级联删除测试（v1.3 schema）：
// 当删除一个 role='main' 的 assignment 时，同 workspace 内 parent_instance_id
// 指向它的 subs 应被一并删除。删除 sub 时不影响 main。
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
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

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

function makeDef(id: string): AgentDefinition {
  return {
    id, name: id, slug: id, version: '1.0',
    runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], source: 'builtin',
    description: 'd', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
}

describe('removeAgentAssignment 级联 — v1.3', () => {
  it('删除 main 时级联删除其 subs（按 parent_instance_id）', async () => {
    saveAgentDefinition(makeDef('main-1'));
    saveAgentDefinition(makeDef('sub-1'));
    saveAgentDefinition(makeDef('sub-2'));

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    // v1.3：显式传 role + parentInstanceId 建立关系
    const main = assignAgentToWorkspace(ws.id, 'main-1', '@m:localhost', 'main');
    assignAgentToWorkspace(ws.id, 'sub-1', '@s1:localhost', 'sub', main.instanceId);
    assignAgentToWorkspace(ws.id, 'sub-2', '@s2:localhost', 'sub', main.instanceId);

    expect(listAssignments(ws.id)).toHaveLength(3);

    // 删除 main → 应连带删除 2 个 subs
    const { removeAgentAssignment } = await import('../../src/main/agent/ipc.handlers');
    await removeAgentAssignment(main.instanceId);

    expect(listAssignments(ws.id)).toHaveLength(0);
  });

  it('删除 sub 时不影响 main', async () => {
    saveAgentDefinition(makeDef('main-1'));
    saveAgentDefinition(makeDef('sub-1'));

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    const main = assignAgentToWorkspace(ws.id, 'main-1', '@m:localhost', 'main');
    const sub = assignAgentToWorkspace(ws.id, 'sub-1', '@s:localhost', 'sub', main.instanceId);

    const { removeAgentAssignment } = await import('../../src/main/agent/ipc.handlers');
    await removeAgentAssignment(sub.instanceId);

    // 只删了 sub，main 仍在
    const remaining = listAssignments(ws.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.instanceId).toBe(main.instanceId);
  });

  it('删除 standalone 时不影响其他 assignment', async () => {
    saveAgentDefinition(makeDef('solo-1'));
    saveAgentDefinition(makeDef('solo-2'));

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );

    const solo1 = assignAgentToWorkspace(ws.id, 'solo-1', '@s1:localhost', 'standalone');
    assignAgentToWorkspace(ws.id, 'solo-2', '@s2:localhost', 'standalone');

    const { removeAgentAssignment } = await import('../../src/main/agent/ipc.handlers');
    await removeAgentAssignment(solo1.instanceId);

    const remaining = listAssignments(ws.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.instanceId).not.toBe(solo1.instanceId);
  });
});
