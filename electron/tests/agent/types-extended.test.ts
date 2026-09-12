// electron/tests/agent/types-extended.test.ts
//
// M2 类型扩展单元测试：
//   1. McpRef / SkillRef 形状正确
//   2. AgentDefinition 支持新字段 parentAgentId + defaultMcps + defaultSkills
//   3. 不破坏 M1 已有字段
//
// 这是纯类型层面的断言（编译期 + 运行期 shape 检查），不涉及 SQLite。

import { describe, it, expect } from 'vitest';
import type { AgentDefinition, McpRef, SkillRef } from '../../src/main/agent/types';

describe('agent/types M2 扩展', () => {
  it('McpRef 包含 kind + ref', () => {
    const mcp: McpRef = { kind: 'mcp', ref: 'filesystem', versionRange: '^1.0.0' };
    expect(mcp.kind).toBe('mcp');
    expect(mcp.ref).toBe('filesystem');
    expect(mcp.versionRange).toBe('^1.0.0');
  });

  it('McpRef.versionRange 可选', () => {
    const mcp: McpRef = { kind: 'mcp', ref: 'github' };
    expect(mcp.versionRange).toBeUndefined();
  });

  it('SkillRef 包含 kind + ref', () => {
    const skill: SkillRef = { kind: 'skill', ref: 'code-review-workflow' };
    expect(skill.kind).toBe('skill');
    expect(skill.ref).toBe('code-review-workflow');
    expect(skill.versionRange).toBeUndefined();
  });

  it('AgentDefinition 现行形态（v1.3 起 type/parentAgentId/model 退役，provider 引用制）', () => {
    const def: AgentDefinition = {
      id: 'test',
      name: '测试',
      slug: 'test',
      version: '1.0.0',
      runtime: 'declarative',
      systemPrompt: 'test',
      defaultTools: [],
      source: 'builtin',
      description: '',
      iconEmoji: '🤖',
      workspaceId: null,
      modelProviderId: 'prov-1',
      modelName: 'gpt-4o',
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'code-review' }],
    };
    expect(def.defaultMcps).toHaveLength(1);
    expect(def.defaultSkills).toHaveLength(1);
    expect(def.modelProviderId).toBe('prov-1');
    // 退役字段不再是 AgentDefinition 一部分（运行时对象上自然不存在）
    expect('parentAgentId' in def).toBe(false);
    expect('type' in def).toBe(false);
  });
});
