// electron/tests/agent/crud-custom-def.test.ts
//
// v1.6 Task 9：createCustomDef + updateAgentDefinition 的 defaultTools/Mcps/Skills 入参测试。
// - createCustomDef 缺省 defaultTools = SAFE_MINIMUM_TOOLS（kind='builtin'），mcps/skills = []
// - createCustomDef 显式传 default* 时按传入值落库
// - updateAgentDefinition 入参含 default* 时更新，不含则保留原值（向后兼容）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  getAgentDefinition,
  updateAgentDefinition,
  createCustomDef,
  listAgentDefinitions,
} from '../../src/main/agent/crud';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';
import type { AgentDefinition, ToolRef, McpRef, SkillRef } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-custom-${Date.now()}`);
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

/** 通过 slug 从 listAgentDefinitions 找到刚创建的 def（id 是 randomUUID） */
function findBySlug(slug: string): AgentDefinition {
  const match = listAgentDefinitions().find((d) => d.slug === slug);
  if (!match) throw new Error(`未找到 slug=${slug} 的 def`);
  return match;
}

describe('createCustomDef — v1.6 default* 入参', () => {
  it('缺省时 defaultTools = SAFE_MINIMUM_TOOLS（kind=builtin），mcps/skills = []', () => {
    createCustomDef(null, {
      name: 'A1', slug: 'a1', systemPrompt: 'p',
      modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const created = findBySlug('a1');
    expect(created.defaultTools).toEqual(
      SAFE_MINIMUM_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
    );
    expect(created.defaultMcps).toEqual([]);
    expect(created.defaultSkills).toEqual([]);
  });

  it('显式传 defaultTools/Mcps/Skills 时按传入值落库', () => {
    const customTools: ToolRef[] = [{ kind: 'builtin', ref: 'bash' }];
    const customMcps: McpRef[] = [{ kind: 'mcp', ref: 'github' }];
    const customSkills: SkillRef[] = [{ kind: 'skill', ref: 'code-review' }];

    createCustomDef('ws-1', {
      name: 'A2', slug: 'a2', systemPrompt: 'p',
      modelProviderId: 'prov-1', modelName: 'gpt-4o',
      defaultTools: customTools,
      defaultMcps: customMcps,
      defaultSkills: customSkills,
    });
    const created = findBySlug('a2');
    expect(created.defaultTools).toEqual(customTools);
    expect(created.defaultMcps).toEqual(customMcps);
    expect(created.defaultSkills).toEqual(customSkills);
    expect(created.workspaceId).toBe('ws-1');
  });

  it('source = "custom"，runtime = "declarative"，version = "1.0.0"', () => {
    createCustomDef(null, {
      name: 'A3', slug: 'a3', systemPrompt: 'p',
      modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const created = findBySlug('a3');
    expect(created.source).toBe('custom');
    expect(created.runtime).toBe('declarative');
    expect(created.version).toBe('1.0.0');
  });

  it('iconEmoji / description 缺省时落库为默认值', () => {
    createCustomDef(null, {
      name: 'A4', slug: 'a4', systemPrompt: 'p',
      modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const created = findBySlug('a4');
    expect(created.iconEmoji).toBe('🤖');
    expect(created.description).toBe('');
  });
});

describe('updateAgentDefinition — v1.6 default* 入参', () => {
  it('含 defaultTools 时更新', () => {
    saveAgentDefinition({
      id: 'def-x', name: 'X', slug: 'x', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [{ kind: 'builtin', ref: 'bash' }],
      source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const updated = updateAgentDefinition({
      id: 'def-x',
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }, { kind: 'builtin', ref: 'grep' }],
    });
    expect(updated.defaultTools).toEqual([
      { kind: 'builtin', ref: 'read_file' },
      { kind: 'builtin', ref: 'grep' },
    ]);
  });

  it('不含 defaultTools 时保留原值（向后兼容）', () => {
    const originalTools: ToolRef[] = [{ kind: 'builtin', ref: 'bash' }];
    saveAgentDefinition({
      id: 'def-y', name: 'Y', slug: 'y', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: originalTools,
      source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const updated = updateAgentDefinition({ id: 'def-y', name: 'Y2' });
    expect(updated.defaultTools).toEqual(originalTools);
    expect(updated.name).toBe('Y2');
  });

  it('含 defaultMcps/Skills 时更新', () => {
    saveAgentDefinition({
      id: 'def-z', name: 'Z', slug: 'z', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [],
      source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const updated = updateAgentDefinition({
      id: 'def-z',
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'debugging' }],
    });
    expect(updated.defaultMcps).toEqual([{ kind: 'mcp', ref: 'github' }]);
    expect(updated.defaultSkills).toEqual([{ kind: 'skill', ref: 'debugging' }]);
  });

  it('不传任何 default* 时三者都保留原值', () => {
    saveAgentDefinition({
      id: 'def-w', name: 'W', slug: 'w', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [{ kind: 'builtin', ref: 'bash' }],
      source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [{ kind: 'mcp', ref: 'old-mcp' }],
      defaultSkills: [{ kind: 'skill', ref: 'old-skill' }],
      workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const before = getAgentDefinition('def-w')!;
    const after = updateAgentDefinition({ id: 'def-w', systemPrompt: '新 prompt' });
    expect(after.defaultTools).toEqual(before.defaultTools);
    expect(after.defaultMcps).toEqual(before.defaultMcps);
    expect(after.defaultSkills).toEqual(before.defaultSkills);
    expect(after.systemPrompt).toBe('新 prompt');
  });
});
