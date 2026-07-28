// electron/tests/agent/capability-merger.test.ts
//
// 验证三层能力叠加合并逻辑（纯单元测试，不依赖 SQLite）：
//   - default + workspace 并集
//   - 相同 ref 去重
//   - 三种能力类型（tool/mcp/skill）独立合并
//   - 空态：allocation 全空时结果等于 def 默认能力

import { describe, it, expect } from 'vitest';
import { mergeCapabilities } from '../../src/main/agent/capability-merger';
import type { AgentDefinition } from '../../src/main/agent/types';
import type { WorkspaceAllocation } from '../../src/main/workspace/allocation';

function makeDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'def-1',
    name: '测试 agent',
    slug: 'test',
    version: '1.0.0',
    type: 'standalone',
    runtime: 'declarative',
    systemPrompt: '',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    parentAgentId: undefined,
    defaultMcps: [],
    defaultSkills: [],
    ...overrides,
  };
}

function makeAllocation(overrides?: Partial<WorkspaceAllocation>): WorkspaceAllocation {
  return { workspaceId: 'ws-1', tools: [], mcps: [], skills: [], ...overrides };
}

describe('agent/capability-merger', () => {
  it('default + workspace 并集', () => {
    const def = makeDef({
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'code-review' }],
    });
    const alloc = makeAllocation({
      tools: ['write_file'],
      mcps: ['postgres'],
      skills: ['deploy'],
    });
    const merged = mergeCapabilities(def, alloc);
    expect(merged.tools).toEqual(['read_file', 'write_file']);
    expect(merged.mcps).toEqual(['github', 'postgres']);
    expect(merged.skills).toEqual(['code-review', 'deploy']);
  });

  it('相同 ref 去重', () => {
    const def = makeDef({
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'code-review' }],
    });
    const alloc = makeAllocation({
      tools: ['read_file'],
      mcps: ['github'],
      skills: ['code-review'],
    });
    const merged = mergeCapabilities(def, alloc);
    expect(merged.tools).toEqual(['read_file']);
    expect(merged.mcps).toEqual(['github']);
    expect(merged.skills).toEqual(['code-review']);
  });

  it('allocation 全空时结果等于 def 默认能力', () => {
    const def = makeDef({
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'code-review' }],
    });
    const merged = mergeCapabilities(def, makeAllocation());
    expect(merged.tools).toEqual(['read_file']);
    expect(merged.mcps).toEqual(['github']);
    expect(merged.skills).toEqual(['code-review']);
  });

  it('def 无默认能力时结果等于 allocation', () => {
    const def = makeDef();
    const alloc = makeAllocation({
      tools: ['write_file'],
      mcps: ['postgres'],
      skills: ['deploy'],
    });
    const merged = mergeCapabilities(def, alloc);
    expect(merged.tools).toEqual(['write_file']);
    expect(merged.mcps).toEqual(['postgres']);
    expect(merged.skills).toEqual(['deploy']);
  });

  it('全空时返回空数组', () => {
    const merged = mergeCapabilities(makeDef(), makeAllocation());
    expect(merged).toEqual({ tools: [], mcps: [], skills: [] });
  });
});
