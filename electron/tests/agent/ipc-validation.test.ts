// electron/tests/agent/ipc-validation.test.ts
//
// createCustom + updateDefinition IPC handler 的 type/parentAgentId 校验测试。
// 关注点：handler 接受 type（standalone/main/sub）与 parentAgentId，并在持久化前
// 执行校验规则：
//   - sub 必须指定一个 type='main' 的父 agent（不存在/非 main 均拒绝）
//   - sub 的父 agent 不能是自己
//   - main 降级为 standalone/main 以外类型时，若仍有 sub 挂靠则拒绝（避免孤儿 sub）
//
// 捕获方式：mock electron.ipcMain.handle，把 handler 按 channel 存入 Map，
// 测试直接调用捕获的 handler —— 验证的是真实生产代码（而非逻辑副本）。

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  getAgentDefinition,
} from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// 捕获 ipcMain.handle 注册的回调（vi.hoisted 在 vi.mock 工厂之前生效）
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// runtime-manager 在 ipc.handlers.ts 中被 import，mock 防止拉起 electron 子进程
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: vi.fn(),
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));

// 参照 create-from-yaml.test.ts 的捕获模式：mock electron 把 handler 存进 hoisted Map
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-ipc-val-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeAll(async () => {
  // 一次性导入模块并取出 registerAgentHandlers，便于每个 case 重注册
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
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** createCustom handler 的入参类型（与 handler 内联声明一致） */
interface CreateCustomInput {
  name: string;
  slug: string;
  description: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  iconEmoji?: string;
  type?: 'standalone' | 'main' | 'sub';
  parentAgentId?: string;
}

/** updateDefinition handler 的入参类型（与 handler 内联声明一致） */
interface UpdateDefinitionInput {
  id: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  modelProvider?: string;
  modelName?: string;
  modelBaseUrl?: string;
  iconEmoji?: string;
  type?: 'standalone' | 'main' | 'sub';
  parentAgentId?: string;
}

/** 调用捕获的 createCustom handler */
async function invokeCreateCustom(input: CreateCustomInput): Promise<AgentDefinition> {
  const handler = handlers.get('agent:createCustom');
  expect(handler).toBeDefined();
  const fn = handler as (evt: unknown, input: CreateCustomInput) => Promise<AgentDefinition>;
  return fn({}, input);
}

/** 调用捕获的 updateDefinition handler */
async function invokeUpdateDefinition(
  input: UpdateDefinitionInput,
): Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }> {
  const handler = handlers.get('agent:updateDefinition');
  expect(handler).toBeDefined();
  const fn = handler as (
    evt: unknown,
    input: UpdateDefinitionInput,
  ) => Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }>;
  return fn({}, input);
}

/** 构造一个 agent 定义并落库，返回持久化后的对象 */
const seedDef = (over: Partial<AgentDefinition> & Pick<AgentDefinition, 'id' | 'slug' | 'type'>): AgentDefinition => {
  const def: AgentDefinition = {
    name: over.slug,
    version: '1.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [],
    source: 'custom',
    description: 'd',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    ...over,
  } as AgentDefinition;
  saveAgentDefinition(def);
  return getAgentDefinition(def.id)!;
};

const baseCreateInput = (over: Partial<CreateCustomInput> = {}): CreateCustomInput => ({
  name: 'X',
  slug: 'x',
  description: '',
  systemPrompt: '',
  modelProvider: 'openai',
  modelName: 'gpt-4o',
  ...over,
});

describe('createCustom handler — type + parentAgentId 校验', () => {
  it('默认 type 为 standalone 且无 parentAgentId（向后兼容）', async () => {
    const def = await invokeCreateCustom(baseCreateInput());
    expect(def.type).toBe('standalone');
    expect(def.parentAgentId).toBeUndefined();
  });

  it('type=sub 但未指定 parentAgentId → 抛错', async () => {
    await expect(
      invokeCreateCustom(baseCreateInput({ type: 'sub' })),
    ).rejects.toThrow('必须指定父主 agent');
  });

  it('type=sub 且 parentAgentId 指向不存在的 agent → 抛错', async () => {
    await expect(
      invokeCreateCustom(baseCreateInput({ type: 'sub', parentAgentId: 'nonexistent' })),
    ).rejects.toThrow('父 agent 不存在');
  });

  it('type=sub 且 parentAgentId 指向非 main 类型 → 抛错', async () => {
    seedDef({ id: 'standalone-1', slug: 'sa', type: 'standalone' });
    await expect(
      invokeCreateCustom(baseCreateInput({ type: 'sub', parentAgentId: 'standalone-1' })),
    ).rejects.toThrow('不是 main 类型');
  });

  it('type=sub 且 parentAgentId 指向合法 main → 成功落库并带 parentAgentId', async () => {
    seedDef({ id: 'main-1', slug: 'main', type: 'main' });
    const def = await invokeCreateCustom(
      baseCreateInput({ type: 'sub', parentAgentId: 'main-1' }),
    );
    expect(def.type).toBe('sub');
    expect(def.parentAgentId).toBe('main-1');
    // 落库保真
    const saved = getAgentDefinition(def.id)!;
    expect(saved.type).toBe('sub');
    expect(saved.parentAgentId).toBe('main-1');
  });

  it('type=main 不需要 parentAgentId（即使误传也不持久化）', async () => {
    const def = await invokeCreateCustom(
      baseCreateInput({ type: 'main', parentAgentId: 'main-1' }),
    );
    expect(def.type).toBe('main');
    expect(def.parentAgentId).toBeUndefined();
  });
});

describe('updateDefinition handler — type + parentAgentId 校验', () => {
  it('main 降级为 standalone 且仍有 sub 挂靠 → 抛错', async () => {
    seedDef({ id: 'main-1', slug: 'main', type: 'main' });
    seedDef({ id: 'sub-1', slug: 'sub', type: 'sub', parentAgentId: 'main-1' });

    await expect(
      invokeUpdateDefinition({ id: 'main-1', type: 'standalone' }),
    ).rejects.toThrow('请先解除');
  });

  it('main 降级为 standalone 但无 sub 挂靠 → 成功', async () => {
    seedDef({ id: 'main-1', slug: 'main', type: 'main' });
    const { definition } = await invokeUpdateDefinition({ id: 'main-1', type: 'standalone' });
    expect(definition.type).toBe('standalone');
    expect(definition.parentAgentId).toBeUndefined();
  });

  it('改 type=sub 但 parentAgentId 不存在 → 抛错', async () => {
    seedDef({ id: 'def-1', slug: 'd1', type: 'standalone' });
    await expect(
      invokeUpdateDefinition({ id: 'def-1', type: 'sub', parentAgentId: 'nope' }),
    ).rejects.toThrow('父 agent 不存在');
  });

  it('改 type=sub 但 parentAgentId 指向非 main → 抛错', async () => {
    seedDef({ id: 'sa-1', slug: 'sa', type: 'standalone' });
    seedDef({ id: 'def-1', slug: 'd1', type: 'standalone' });
    await expect(
      invokeUpdateDefinition({ id: 'def-1', type: 'sub', parentAgentId: 'sa-1' }),
    ).rejects.toThrow('不是 main 类型');
  });

  it('改 type=sub 且 parentAgentId 指向自己 → 抛错', async () => {
    seedDef({ id: 'main-1', slug: 'main', type: 'main' });
    await expect(
      invokeUpdateDefinition({ id: 'main-1', type: 'sub', parentAgentId: 'main-1' }),
    ).rejects.toThrow('不能将自身设为父 agent');
  });

  it('改 type=sub 指向合法 main → 成功落库', async () => {
    seedDef({ id: 'main-1', slug: 'main', type: 'main' });
    seedDef({ id: 'def-1', slug: 'd1', type: 'standalone' });
    const { definition } = await invokeUpdateDefinition({
      id: 'def-1',
      type: 'sub',
      parentAgentId: 'main-1',
    });
    expect(definition.type).toBe('sub');
    expect(definition.parentAgentId).toBe('main-1');
  });
});
