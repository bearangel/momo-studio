// electron/tests/agent/agent-start-subagents.test.ts
//
// C1 回归测试（v1.3）：rebuildSubAgents 从 assignment.parent_instance_id 重建 subAgents，
// 保证 main agent 重启时 dispatch:<slug> 工具集不丢失。
//
// v1.3 改造：原 v1.2 测试通过完整 IPC agent:start 流程验证；v1.3 改为直接测 rebuildSubAgents
// （T7 会重写 ipc.handlers.ts，到时再加 agent:start 端到端测试）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import { rebuildSubAgents } from '../../src/main/agent/spawn-helpers';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-manager', () => ({
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-rebuild-subs-${Date.now()}-${process.pid}`);
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

function makeDef(id: string, slug: string, name: string, description: string): AgentDefinition {
  return {
    id, name, slug, version: '1.0',
    runtime: 'declarative', systemPrompt: '...',
    defaultTools: [], source: 'builtin',
    description, iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
}

describe('rebuildSubAgents — v1.3 assignment.parent_instance_id', () => {
  it('main assignment 的 subs 通过 parent_instance_id 关联，返回正确 sub 引用', async () => {
    saveAgentDefinition(makeDef('main-c1', 'pm', 'PM', '主 agent'));
    saveAgentDefinition(makeDef('sub-c1-1', 'coder', 'Coder', '写代码'));
    saveAgentDefinition(makeDef('sub-c1-2', 'qa', 'QA', '测代码'));

    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );

    // v1.3：分配时显式传 role + parentInstanceId 建立关系
    const mainAssignment = assignAgentToWorkspace(ws.id, 'main-c1', 'agent-pm-x1', 'main');
    const sub1 = assignAgentToWorkspace(ws.id, 'sub-c1-1', 'agent-coder-x1', 'sub', mainAssignment.instanceId);
    const sub2 = assignAgentToWorkspace(ws.id, 'sub-c1-2', 'agent-qa-x1', 'sub', mainAssignment.instanceId);

    // 调用 rebuildSubAgents：传 main assignment 的 instanceId
    const subs = rebuildSubAgents(ws.id, mainAssignment.instanceId);

    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.slug).sort()).toEqual(['coder', 'qa']);
    // v2（Task 10）：引用携带 assignmentId（dispatch 路由键），不再携带 Matrix userId
    expect(subs.map((s) => s.assignmentId).sort()).toEqual([sub1.instanceId, sub2.instanceId].sort());
    // description 来自 def
    const coder = subs.find((s) => s.slug === 'coder')!;
    expect(coder.description).toBe('写代码');
  });

  it('main 没有 subs 时返回空数组', async () => {
    saveAgentDefinition(makeDef('lone-main', 'lone', 'Lone', '孤主'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    const main = assignAgentToWorkspace(ws.id, 'lone-main', 'agent-lone-x1', 'main');

    const subs = rebuildSubAgents(ws.id, main.instanceId);
    expect(subs).toHaveLength(0);
  });

  it('不同 ws 的同 defId assignment 不串扰（parentInstanceId 只在本 ws 内有效）', async () => {
    saveAgentDefinition(makeDef('main-c1', 'pm', 'PM', '主'));
    saveAgentDefinition(makeDef('sub-c1', 'coder', 'Coder', '子'));

    const ws1 = await createWorkspace(
      { name: 'w1', description: '', directoryPath: path.join(tmpRoot, 'w1'), iconEmoji: '📁' },
      '@o:localhost',
    );
    const ws2 = await createWorkspace(
      { name: 'w2', description: '', directoryPath: path.join(tmpRoot, 'w2'), iconEmoji: '📁' },
      '@o:localhost',
    );

    // ws1: main + sub 关联
    const main1 = assignAgentToWorkspace(ws1.id, 'main-c1', 'agent-m1-x1', 'main');
    assignAgentToWorkspace(ws1.id, 'sub-c1', 'agent-s1-x1', 'sub', main1.instanceId);

    // ws2: 只有 main，无 sub
    const main2 = assignAgentToWorkspace(ws2.id, 'main-c1', 'agent-m2-x1', 'main');

    // ws2 的 main 不应看到 ws1 的 sub（assignment 隔离）
    const subs2 = rebuildSubAgents(ws2.id, main2.instanceId);
    expect(subs2).toHaveLength(0);
  });
});
