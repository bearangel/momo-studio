// electron/tests/agent/crud-list-definitions.test.ts
// listAgentDefinitions(workspaceId?) 过滤：global + 当前 ws scoped + builtin
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

vi.mock('../../src/main/agent/runtime-manager', () => ({
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(),
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

describe('listAgentDefinitions — workspace 过滤', () => {
  it('workspaceId=undefined 返回全部', () => {
    saveAgentDefinition(makeDef({ id: 'd1', source: 'builtin', workspaceId: null }));
    saveAgentDefinition(makeDef({ id: 'd2', source: 'custom', workspaceId: null }));
    saveAgentDefinition(makeDef({ id: 'd3', source: 'custom', workspaceId: 'ws-a' }));
    saveAgentDefinition(makeDef({ id: 'd4', source: 'custom', workspaceId: 'ws-b' }));

    const result = listAgentDefinitions();
    expect(result).toHaveLength(4);
  });

  it('workspaceId=ws-a 返回 global + ws-a scoped + 全部 builtin，不返回 ws-b', () => {
    saveAgentDefinition(makeDef({ id: 'd1', source: 'builtin', workspaceId: null }));
    saveAgentDefinition(makeDef({ id: 'd2', source: 'custom', workspaceId: null }));
    saveAgentDefinition(makeDef({ id: 'd3', source: 'custom', workspaceId: 'ws-a' }));
    saveAgentDefinition(makeDef({ id: 'd4', source: 'custom', workspaceId: 'ws-b' }));

    const result = listAgentDefinitions('ws-a');
    const ids = result.map((d) => d.id);
    expect(ids).toContain('d1'); // builtin
    expect(ids).toContain('d2'); // global custom
    expect(ids).toContain('d3'); // ws-a scoped
    expect(ids).not.toContain('d4'); // ws-b scoped 不可见
  });

  it('rowToDef 正确映射 workspaceId / modelProviderId / modelName 字段', () => {
    saveAgentDefinition(makeDef({
      id: 'd5', workspaceId: 'ws-x', modelProviderId: 'prov-1', modelName: 'gpt-4',
    }));
    const result = listAgentDefinitions('ws-x');
    const def = result.find((d) => d.id === 'd5');
    expect(def?.workspaceId).toBe('ws-x');
    expect(def?.modelProviderId).toBe('prov-1');
    expect(def?.modelName).toBe('gpt-4');
    // 旧字段不存在
    expect((def as unknown as Record<string, unknown>).type).toBeUndefined();
    expect((def as unknown as Record<string, unknown>).parentAgentId).toBeUndefined();
    expect((def as unknown as Record<string, unknown>).model).toBeUndefined();
  });
});
