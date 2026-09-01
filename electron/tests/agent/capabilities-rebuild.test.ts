// electron/tests/agent/capabilities-rebuild.test.ts
//
// Task 10B 全链路回归：agent:setMemberDeltas 生产消费闭环（T10 审查移交债务①）
// + agent_definitions 死列修复回归（债务②）。
//
// 链路（真实 handler → 真实落表 → 真实读回合并）：
//   ipcMain.handle 捕获的 'agent:setMemberDeltas' handler（真实注册，非逻辑副本）
//   → setAssignmentDeltas 落 agent_assignment_capabilities（v26 重建 FK 后可写）
//   → capability-merger readAssignmentDeltas 读回
//   → mergeCapabilities 三层合并——与 spawn-helpers.ts 生产消费序列逐字对齐
//
// 债务②回归：beforeEach 真实调用 saveAgentDefinition（v25 已 DROP workspace_id 列，
//   修复前此处抛 "table agent_definitions has no column named workspace_id"）。
//
// Mock 收窄（momo-test-rules #5）：仅进程/重边界（electron ipcMain / keychain /
// runtime spawn 链 / p2p 广播）；DB、crud、assignment-capabilities、capability-merger
// 全真实。成员 instanceId 用真实 addMember 产出的 randomUUID（唯一性保真）。
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// vi.hoisted 保证 ipcHandlers 在 vi.mock 工厂提升前就绪（ipc-stop-start 同法）
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// mock electron：捕获 ipcMain.handle 注册的 handler 供测试直接调用
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

// keychain：进程边界（keytar native），测试内无实际调用
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: vi.fn(async () => null),
  deleteSecret: vi.fn(async () => undefined),
  setSecret: vi.fn(),
  setKeychainImpl: vi.fn(),
}));

// spawn-helpers：runtime spawn 链边界（本测试不触发 agent:start）
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: vi.fn(() => ({})),
  resolveApiKey: vi.fn(async () => 'k'),
  HOMESERVER_URL: 'http://127.0.0.1:8008',
}));

// builtin：YAML 资源加载边界（注册时引用，不触发）
vi.mock('../../src/main/agent/builtin', () => ({
  getBuiltinSuggestionsMap: vi.fn(() => new Map()),
}));

// p2p 广播：网络边界（create/delete def 时 fire-and-forget）
vi.mock('../../src/main/p2p/resource-share', () => ({
  broadcastLocalResourceCatalog: vi.fn(async () => undefined),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  saveAgentDefinition,
  getAgentDefinition,
  listAgentDefinitions,
  addMember,
  generateAgentUserId,
} from '../../src/main/agent/crud';
import {
  readAssignmentDeltas,
  readAllocationLayer,
  mergeCapabilities,
} from '../../src/main/agent/capability-merger';
import type { AgentDefinition } from '../../src/main/agent/types';

let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-capabilities-rebuild-${Date.now()}-${process.pid}`);

const EMPTY_DELTAS = {
  addedTools: [],
  removedTools: [],
  addedMcps: [],
  removedMcps: [],
  addedSkills: [],
  removedSkills: [],
};

function makeDef(): AgentDefinition {
  return {
    id: 'def-1',
    name: 'Tester',
    slug: 'tester',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
  };
}

beforeAll(async () => {
  // 动态 import：vi.mock 提升在静态 import 之前生效
  const mod = await import('../../src/main/agent/ipc.handlers');
  registerAgentHandlers = mod.registerAgentHandlers;
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  const db = getDb();
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test Provider', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run();
  // 债务②回归锚点：真实 save 路径（修复前抛 no column named workspace_id）
  saveAgentDefinition(makeDef());

  ipcHandlers.clear();
  registerAgentHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('setMemberDeltas 全链路（handler → 落表 → merger 读回 → 三层合并）', () => {
  it('真实 handler 写入 → 表行落库 → merger 读回 → spawn-helpers 同序列合并生效', async () => {
    const member = await addMember('ws1', 'def-1', generateAgentUserId('tester'));
    // Layer 2 fixture：workspace 共享能力
    getDb()
      .prepare(
        'INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES (?, ?, ?)',
      )
      .run('ws1', 'tool', 'webfetch');

    const deltas = {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: ['github'],
      removedMcps: [],
      addedSkills: ['code-review'],
      removedSkills: [],
    };
    const handler = ipcHandlers.get('agent:setMemberDeltas') as (
      ...args: unknown[]
    ) => Promise<void>;
    await handler(null, member.instanceId, deltas);

    // 1. 真实落表（表行断言，非 mock 调用计数）
    const rows = getDb()
      .prepare('SELECT capability_type, mode, ref FROM agent_assignment_capabilities WHERE assignment_id = ?')
      .all(member.instanceId) as Array<{ capability_type: string; mode: string; ref: string }>;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { capability_type: 'tool', mode: 'add', ref: 'bash' },
        { capability_type: 'mcp', mode: 'add', ref: 'github' },
        { capability_type: 'skill', mode: 'add', ref: 'code-review' },
      ]),
    );

    // 2. merger 读回 == 写入值
    expect(readAssignmentDeltas(member.instanceId)).toEqual(deltas);

    // 3. 生产消费序列（spawn-helpers.ts:217-219 逐字对齐）
    const def = getAgentDefinition('def-1')!;
    const merged = mergeCapabilities(def, readAllocationLayer('ws1'), readAssignmentDeltas(member.instanceId));
    expect(merged.tools).toEqual(['read_file', 'webfetch', 'bash']);
    expect(merged.mcps).toEqual(['github']);
    expect(merged.skills).toEqual(['code-review']);
  });

  it('getMemberDeltas：无 delta 成员返回全空对象（契约形状）', async () => {
    const member = await addMember('ws1', 'def-1', generateAgentUserId('tester'));
    const handler = ipcHandlers.get('agent:getMemberDeltas') as (
      ...args: unknown[]
    ) => Promise<typeof EMPTY_DELTAS>;
    expect(await handler(null, member.instanceId)).toEqual(EMPTY_DELTAS);
  });

  it('错误路径：不存在的 instanceId 写 delta 被新 FK 拒绝', async () => {
    const handler = ipcHandlers.get('agent:setMemberDeltas') as (
      ...args: unknown[]
    ) => Promise<void>;
    await expect(
      handler(null, 'ghost-inst', {
        addedTools: ['bash'],
        removedTools: [],
        addedMcps: [],
        removedMcps: [],
        addedSkills: [],
        removedSkills: [],
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('级联清理：删除成员行 → delta 自动清空', async () => {
    const member = await addMember('ws1', 'def-1', generateAgentUserId('tester'));
    const handler = ipcHandlers.get('agent:setMemberDeltas') as (
      ...args: unknown[]
    ) => Promise<void>;
    await handler(null, member.instanceId, {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    getDb()
      .prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?')
      .run(member.instanceId);
    expect(readAssignmentDeltas(member.instanceId)).toEqual(EMPTY_DELTAS);
  });

  it('全量替换语义：二次 setMemberDeltas 旧值清空、新值生效', async () => {
    const member = await addMember('ws1', 'def-1', generateAgentUserId('tester'));
    const handler = ipcHandlers.get('agent:setMemberDeltas') as (
      ...args: unknown[]
    ) => Promise<void>;
    await handler(null, member.instanceId, {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    await handler(null, member.instanceId, {
      addedTools: [],
      removedTools: ['git_commit'],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    expect(readAssignmentDeltas(member.instanceId)).toEqual({
      ...EMPTY_DELTAS,
      removedTools: ['git_commit'],
    });
  });
});

describe('agent_definitions 死列修复回归（债务②）', () => {
  it('saveAgentDefinition → getAgentDefinition round-trip 不触碰 workspace_id 死列', () => {
    // beforeEach 已真实 save（修复前在此抛 no column named workspace_id）
    const def = getAgentDefinition('def-1');
    expect(def).not.toBeNull();
    expect(def!.defaultTools).toEqual([{ kind: 'builtin', ref: 'read_file' }]);
    // v25 定义全局化：列已退役，映射恒 null
    expect(def!.workspaceId).toBeNull();
  });

  it('listAgentDefinitions() 返回已保存定义（无 workspace 过滤分支）', () => {
    const defs = listAgentDefinitions();
    expect(defs.map((d) => d.id)).toContain('def-1');
  });
});
