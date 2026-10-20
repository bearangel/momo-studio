// electron/tests/agent/capability-merger-layer3.test.ts
//
// 验证 Layer 3（per-assignment deltas）合并逻辑（纯单元测试，不依赖 SQLite）：
//   - 向后兼容：不传 deltas 时行为 = v1.5
//   - 传空 deltas 等价于不传
//   - addedTools / addedMcps / addedSkills 把新能力加入合并集合
//   - removedTools / removedMcps / removedSkills 把能力移除（含 def 默认 + alloc）
//   - 冲突规则：同 ref 同时 added + removed 时 removed 胜出（保守语义）
//   - 顺序：先 union added，再 subtract removed（这个顺序天然保证 remove 胜出）
//
// 另：直接测试导出的 union / subtract helper（独立可测）。

import { describe, it, expect } from 'vitest';
import {
  mergeCapabilities,
  union,
  subtract,
} from '../../src/main/agent/capability-merger';
import type { AgentDefinition } from '../../src/main/agent/types';
import type { WorkspaceAllocation } from '../../src/main/workspace/allocation';
import type { AssignmentDeltas } from '../../src/main/agent/assignment-capabilities';

const mockDef: AgentDefinition = {
  id: 'd1',
  name: 'T',
  slug: 't',
  version: '1',
  runtime: 'declarative',
  systemPrompt: '',
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
  defaultMcps: [{ kind: 'mcp', ref: 'fs' }],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: null,
  modelName: 'm',
};

const mockAlloc: WorkspaceAllocation = {
  workspaceId: 'ws1',
  tools: ['bash'],
  mcps: [],
  skills: [],
};

const emptyDeltas: AssignmentDeltas = {
  addedTools: [],
  removedTools: [],
  addedMcps: [],
  removedMcps: [],
  addedSkills: [],
  removedSkills: [],
  addedPluginTools: [],
  removedPluginTools: [],
};

describe('mergeCapabilities Layer 3', () => {
  it('不传 deltas 时行为 = v1.5（向后兼容）', () => {
    const r = mergeCapabilities(mockDef, mockAlloc);
    expect(r.tools).toEqual(['read_file', 'bash']);
    expect(r.mcps).toEqual(['fs']);
    expect(r.skills).toEqual([]);
  });

  it('传空 deltas 等价于不传', () => {
    const r1 = mergeCapabilities(mockDef, mockAlloc);
    const r2 = mergeCapabilities(mockDef, mockAlloc, emptyDeltas);
    expect(r2).toEqual(r1);
  });

  it('deltas.addedTools 把新工具加入合并集合', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      addedTools: ['webfetch', 'grep'],
    });
    expect(r.tools).toEqual(['read_file', 'bash', 'webfetch', 'grep']);
  });

  it('deltas.removedTools 把工具移除（包括 def 默认 + workspace allocation）', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      removedTools: ['bash'],
    });
    expect(r.tools).toEqual(['read_file']); // bash 被 remove
  });

  it('同 ref 同时出现在 added 和 removed 时 remove 胜出（保守语义）', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      addedTools: ['git_commit'],
      removedTools: ['git_commit'],
    });
    expect(r.tools).not.toContain('git_commit');
  });

  it('deltas.addedMcps / addedSkills 同样生效', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      addedMcps: ['github'],
      addedSkills: ['code-review'],
    });
    expect(r.mcps).toEqual(['fs', 'github']);
    expect(r.skills).toEqual(['code-review']);
  });

  it('deltas.removedMcps / removedSkills 同样生效', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      removedMcps: ['fs'],
    });
    expect(r.mcps).toEqual([]);
  });

  it('deltas 与 Layer 1+2 的并集后再减（顺序：先 union add，再 subtract remove）', () => {
    const r = mergeCapabilities(mockDef, mockAlloc, {
      ...emptyDeltas,
      addedTools: ['grep'],
      removedTools: ['read_file', 'bash'],
    });
    expect(r.tools).toEqual(['grep']); // add grep, remove read_file+bash
  });
});

describe('capability-merger helpers', () => {
  it('union 去重并保留首次出现的顺序', () => {
    expect(union(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(union([], [])).toEqual([]);
    expect(union(['x'], ['x', 'x'])).toEqual(['x']);
  });

  it('subtract 从第一参数中移除第二参数列出的元素', () => {
    expect(subtract(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    // 移除不存在的元素是 no-op
    expect(subtract(['a'], ['z'])).toEqual(['a']);
    expect(subtract([], ['a'])).toEqual([]);
  });

  it('subtract 在 added ∪ removed 冲突时保证 removed 胜出', () => {
    // 模拟 mergeCapabilities 内部对冲突 ref 的处理：先 union 再 subtract
    const merged = subtract(union(['base'], ['conflict']), ['conflict']);
    expect(merged).not.toContain('conflict');
    expect(merged).toEqual(['base']);
  });
});

// ── 功能全面性规则案例：插件工具成员级覆盖（deniedTools 第 4 输出）──
// 铁律 5 验收锚点：builtin（只读定义）经成员 deltas 管理插件工具的存量场景。
const EMPTY_ALLOC: WorkspaceAllocation = { workspaceId: 'ws-x', tools: [], mcps: [], skills: [] };
const EMPTY: AssignmentDeltas = {
  addedTools: [], removedTools: [], addedMcps: [], removedMcps: [], addedSkills: [], removedSkills: [],
  addedPluginTools: [], removedPluginTools: [],
};

describe('mergeCapabilities deniedTools（成员级插件工具覆盖）', () => {
  it('基线：无 deltas → 输出 = def.deniedTools（builtin 默认无 = []）', () => {
    const out = mergeCapabilities(mockDef, EMPTY_ALLOC);
    expect(out.deniedTools).toEqual([]);
    const defDeny = { ...mockDef, deniedTools: ['plugin:codegraph/*'] };
    expect(mergeCapabilities(defDeny, EMPTY_ALLOC).deniedTools).toEqual(['plugin:codegraph/*']);
  });

  it('成员 remove 追加禁用；add 覆盖 def 级禁用（重新启用）', () => {
    const out = mergeCapabilities(mockDef, EMPTY_ALLOC, {
      ...EMPTY, removedPluginTools: ['plugin:cg/explore'],
    });
    expect(out.deniedTools).toEqual(['plugin:cg/explore']);
    const defDeny = { ...mockDef, deniedTools: ['plugin:cg/*', 'plugin:other/x'] };
    const re = mergeCapabilities(defDeny, EMPTY_ALLOC, {
      ...EMPTY, addedPluginTools: ['plugin:cg/*'],
    });
    expect(re.deniedTools).toEqual(['plugin:other/x']); // cg 整插件被成员重新启用
  });

  it('冲突：同模式 add + removed → removed（禁用）胜出——与 tools 保守语义对齐', () => {
    const out = mergeCapabilities(mockDef, EMPTY_ALLOC, {
      ...EMPTY, addedPluginTools: ['plugin:cg/*'], removedPluginTools: ['plugin:cg/*'],
    });
    expect(out.deniedTools).toEqual(['plugin:cg/*']);
  });

  it('旧 deltas（无 plugin 字段）容错——undefined 按 empty 处理（前向兼容）', () => {
    const legacy = {
      addedTools: [], removedTools: [], addedMcps: [], removedMcps: [], addedSkills: [], removedSkills: [],
    } as unknown as AssignmentDeltas;
    expect(mergeCapabilities({ ...mockDef, deniedTools: ['plugin:a/*'] }, EMPTY_ALLOC, legacy).deniedTools)
      .toEqual(['plugin:a/*']);
  });
});
