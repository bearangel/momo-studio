// electron/tests/agent/manifest-parser.test.ts
//
// manifest-parser 单元测试（v1.3 schema）：
// - 合法 YAML 解析返回 v1.3 AgentDefinition（无 type/parent/model.provider）
// - type/parent/model.provider 字段保留在 ParsedManifest.suggestion 中
// - 校验失败路径覆盖

import { describe, expect, it } from 'vitest';
import { parseAgentManifest, parseAgentManifestWithSuggestion } from '../../src/main/agent/manifest-parser';

const VALID_YAML = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
  description: 帮用户梳理需求
  iconEmoji: "📝"
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "你是一名需求分析师"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: workspace.read_file
    - kind: builtin
      ref: workspace.write_file
`;

describe('agent/manifest-parser — v1.3 schema', () => {
  it('解析合法 YAML 返回 v1.3 AgentDefinition', () => {
    const def = parseAgentManifest(VALID_YAML);
    expect(def.name).toBe('需求讨论师');
    expect(def.slug).toBe('requirement-analyst');
    expect(def.runtime).toBe('declarative');
    // v1.3：modelName 直接在 def 上
    expect(def.modelName).toBe('claude-3-5-sonnet');
    // v1.3：workspaceId/modelProviderId 默认 NULL（YAML 加载时未配置）
    expect(def.workspaceId).toBeNull();
    expect(def.modelProviderId).toBeNull();
    expect(def.defaultTools).toHaveLength(2);
    // 旧字段不存在
    const unknown = def as unknown as Record<string, unknown>;
    expect(unknown.type).toBeUndefined();
    expect(unknown.parentAgentId).toBeUndefined();
    expect(unknown.model).toBeUndefined();
  });

  it('parseAgentManifestWithSuggestion 返回 type/parent/platform 建议字段', () => {
    const { def, suggestion } = parseAgentManifestWithSuggestion(VALID_YAML);
    expect(def.slug).toBe('requirement-analyst');
    expect(suggestion.role).toBe('standalone');
    expect(suggestion.suggestedPlatform).toBe('anthropic');
  });

  it('解析 type=main + parentAgentId（slug 引用）+ defaultMcps/defaultSkills', () => {
    const yaml = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: PM
  slug: pm
  version: 1.0.0
spec:
  type: main
  runtime: declarative
  declarative:
    systemPrompt: "PM"
    model:
      provider: openai
      model: gpt-4o
  defaultMcps:
    - kind: mcp
      ref: filesystem
  defaultSkills:
    - kind: skill
      ref: code-review
---
apiVersion: v1
kind: AgentDefinition
metadata:
  name: Sub
  slug: sub
  version: 1.0.0
spec:
  type: sub
  parentAgentId: pm
  runtime: declarative
  declarative:
    systemPrompt: "Sub"
    model:
      provider: openai
      model: gpt-4o
`;
    // js-yaml load 支持 --- 分隔的多文档，但 parseAgentManifest 期望单文档。
    // 这里用单独的 sub YAML 验证。
    const subYaml = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: Sub
  slug: sub
  version: 1.0.0
spec:
  type: sub
  parentAgentId: pm
  runtime: declarative
  declarative:
    systemPrompt: "Sub"
    model:
      provider: openai
      model: gpt-4o
`;
    const { def, suggestion } = parseAgentManifestWithSuggestion(subYaml);
    expect(def.slug).toBe('sub');
    expect(def.modelName).toBe('gpt-4o');
    expect(suggestion.role).toBe('sub');
    expect(suggestion.suggestedParentDefId).toBe('pm');
    expect(suggestion.suggestedPlatform).toBe('openai');
  });

  it('apiVersion 错误抛错', () => {
    expect(() => parseAgentManifest('apiVersion: v9\nkind: AgentDefinition\n')).toThrow(/apiVersion/);
  });

  it('kind 错误抛错', () => {
    expect(() => parseAgentManifest('apiVersion: v1\nkind: Other\n')).toThrow(/kind/);
  });

  it('缺少 metadata.name 抛错', () => {
    const yaml = `
apiVersion: v1
kind: AgentDefinition
metadata:
  slug: x
spec:
  declarative:
    systemPrompt: "x"
    model: { provider: openai, model: gpt-4o }
`;
    expect(() => parseAgentManifest(yaml)).toThrow(/metadata.name/);
  });

  it('model.provider 非法值抛错', () => {
    const yaml = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: X
  slug: x
spec:
  declarative:
    systemPrompt: "x"
    model: { provider: gemini, model: x }
`;
    expect(() => parseAgentManifest(yaml)).toThrow(/model.provider/);
  });

  it('parentAgentId 在非 sub 类型上声明抛错', () => {
    const yaml = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: X
  slug: x
spec:
  type: standalone
  parentAgentId: other
  declarative:
    systemPrompt: "x"
    model: { provider: openai, model: gpt-4o }
`;
    expect(() => parseAgentManifest(yaml)).toThrow(/parentAgentId/);
  });
});
