// electron/tests/agent/create-from-yaml.test.ts
//
// createFromYaml IPC handler 的 slug → UUID 解析测试。
// 关注点：sub agent 的 parentAgentId 在 YAML 中以 slug 字符串声明，
// IPC handler 持久化前必须把 slug 解析为已注册父 agent 的 UUID，
// 这样后续 assignMainAgent 才能正确按 UUID 查找 main 下的 sub。
//
// 捕获方式：mock electron.ipcMain.handle，把 handler 按 channel 存入 Map，
// 测试直接调用捕获的 handler，验证最终落库记录的 parentAgentId 是 UUID。

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

// 捕获 ipcMain.handle 的注册回调（vi.hoisted 在 vi.mock 工厂之前生效）
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// runtime-manager 模块在 ipc.handlers.ts 中被 import，需要 mock 防止拉起 electron 子进程
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: vi.fn(),
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));

// 参照 provider-ipc-handlers.test.ts 的捕获模式：mock electron 把 handler 存进 hoisted Map
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-yaml-${Date.now()}-${process.pid}`);
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

// YAML 必须放在模块顶层——避免被函数缩进影响 parser 解析顶层键
const YAML_SUB_WITH_PARENT = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 程序员
  slug: yaml-coder
  version: '1.0'
  description: 写代码
spec:
  type: sub
  parentAgentId: pm-yaml
  declarative:
    systemPrompt: 你是程序员
    model:
      provider: openai
      model: gpt-4o
`;

const YAML_SUB_UNKNOWN_PARENT = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 孤儿
  slug: orphan-sub
  version: '1.0'
  description: 测试
spec:
  type: sub
  parentAgentId: nonexistent-parent
  declarative:
    systemPrompt: 你是孤儿
    model:
      provider: openai
      model: gpt-4o
`;

const YAML_STANDALONE = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 独立 agent
  slug: lone-1
  version: '1.0'
  description: 测试
spec:
  type: standalone
  declarative:
    systemPrompt: 独立
    model:
      provider: openai
      model: gpt-4o
`;

/** 构造一个 main agent 定义并落库（用于 sub 的 parent） */
const seedMainAgent = (): void => {
  const def: AgentDefinition = {
    id: 'main-uuid-1',
    name: 'PM',
    slug: 'pm-yaml',
    version: '1.0',
    type: 'main',
    runtime: 'declarative',
    systemPrompt: '你是 PM',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [],
    source: 'builtin',
    description: 'PM agent',
    iconEmoji: '📋',
    defaultMcps: [],
    defaultSkills: [],
  };
  saveAgentDefinition(def);
};

/** 调用捕获的 createFromYaml handler，返回解析后的 def */
const invokeCreateFromYaml = async (yaml: string): Promise<AgentDefinition> => {
  const handler = handlers.get('agent:createFromYaml');
  expect(handler).toBeDefined();
  // ipcMain.handle 内部回调签名是 (event, ...args)；直接调用需传占位 event
  const handlerFn = handler as (evt: unknown, yaml: string) => Promise<AgentDefinition>;
  return handlerFn({}, yaml);
};

describe('createFromYaml IPC handler — parentAgentId slug → UUID 解析', () => {
  it('sub agent 的 parentAgentId slug 被解析为已注册 main 的 UUID 后落库', async () => {
    // 先注册 main agent（UUID='main-uuid-1', slug='pm-yaml'）
    seedMainAgent();

    const returnedDef = await invokeCreateFromYaml(YAML_SUB_WITH_PARENT);

    // 验证 handler 返回值：parentAgentId 已被解析为 UUID
    expect(returnedDef.parentAgentId).toBe('main-uuid-1');
    expect(returnedDef.parentAgentId).not.toBe('pm-yaml');

    // ★ R3 核心断言：持久化的 parentAgentId 必须是 main 的 UUID（不是 slug）
    const saved = getAgentDefinition(returnedDef.id);
    expect(saved).not.toBeNull();
    expect(saved!.parentAgentId).toBe('main-uuid-1');
    expect(saved!.parentAgentId).not.toBe('pm-yaml');
  });

  it('parentAgentId 指向不存在的 slug 时落库为 undefined（不抛错）', async () => {
    const returnedDef = await invokeCreateFromYaml(YAML_SUB_UNKNOWN_PARENT);

    // 找不到匹配 slug 的父 agent → parentAgentId 清空（undefined）
    expect(returnedDef.parentAgentId).toBeUndefined();
    const saved = getAgentDefinition(returnedDef.id);
    expect(saved!.parentAgentId).toBeUndefined();
  });

  it('standalone agent（无 parentAgentId）的处理保持原行为', async () => {
    const returnedDef = await invokeCreateFromYaml(YAML_STANDALONE);

    expect(returnedDef.parentAgentId).toBeUndefined();
    const saved = getAgentDefinition(returnedDef.id);
    expect(saved!.parentAgentId).toBeUndefined();
  });
});
