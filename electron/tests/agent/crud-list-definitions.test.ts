// electron/tests/agent/crud-list-definitions.test.ts
// listAgentDefinitions：v25 定义全局化——workspace 过滤语义退役，任何 ws 入参
// 均返回全部定义（agent_definitions.workspace_id 列已 DROP）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  saveAgentDefinition,
  listAgentDefinitions,
} from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-list-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function makeDef(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'def-' + Math.random().toString(36).slice(2),
    name: 'X', slug: 'x', version: '1', runtime: 'declarative',
    systemPrompt: '', defaultTools: [], source: 'custom',
    description: '', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    ...overrides,
  };
}

describe('listAgentDefinitions — v25 定义全局化', () => {
  it('workspaceId=undefined 返回全部', () => {
    saveAgentDefinition(makeDef({ id: 'd1', source: 'builtin' }));
    saveAgentDefinition(makeDef({ id: 'd2', source: 'custom' }));

    const result = listAgentDefinitions();
    expect(result).toHaveLength(2);
  });

  it('带 workspaceId 入参不再过滤：任何 ws 都能看到全部定义（过滤语义退役）', () => {
    saveAgentDefinition(makeDef({ id: 'd1', source: 'builtin' }));
    saveAgentDefinition(makeDef({ id: 'd2', source: 'custom' }));

    const result = listAgentDefinitions('ws-a');
    const ids = result.map((d) => d.id);
    expect(ids).toContain('d1');
    expect(ids).toContain('d2');
  });

  it('rowToDef 正确映射 workspaceId（恒 null）/ modelProviderId / modelName 字段', () => {
    saveAgentDefinition(makeDef({
      id: 'd5', modelProviderId: 'prov-1', modelName: 'gpt-4',
    }));
    const result = listAgentDefinitions();
    const def = result.find((d) => d.id === 'd5');
    expect(def?.workspaceId).toBeNull();
    expect(def?.modelProviderId).toBe('prov-1');
    expect(def?.modelName).toBe('gpt-4');
    // 旧字段不存在
    expect((def as unknown as Record<string, unknown>).type).toBeUndefined();
    expect((def as unknown as Record<string, unknown>).parentAgentId).toBeUndefined();
    expect((def as unknown as Record<string, unknown>).model).toBeUndefined();
  });
});
