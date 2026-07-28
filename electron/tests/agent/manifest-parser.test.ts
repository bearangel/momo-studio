// electron/tests/agent/manifest-parser.test.ts
//
// manifest-parser 单元测试：覆盖合法解析 + 3 个校验失败路径。

import { describe, expect, it } from 'vitest';
import { parseAgentManifest } from '../../src/main/agent/manifest-parser';

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

describe('agent/manifest-parser', () => {
  it('解析合法 YAML 返回 AgentDefinition', () => {
    const def = parseAgentManifest(VALID_YAML);
    expect(def.name).toBe('需求讨论师');
    expect(def.slug).toBe('requirement-analyst');
    expect(def.runtime).toBe('declarative');
    expect(def.model.provider).toBe('anthropic');
    expect(def.model.model).toBe('claude-3-5-sonnet');
    expect(def.defaultTools).toHaveLength(2);
    expect(def.defaultTools[0]!.ref).toBe('workspace.read_file');
  });

  it('缺少 apiVersion 时抛错', () => {
    expect(() =>
      parseAgentManifest(
        'kind: AgentDefinition\nmetadata:\n  name: test\n  slug: test\nspec:\n  declarative:\n    systemPrompt: "test"\n    model:\n      provider: openai\n      model: gpt-4',
      ),
    ).toThrow('apiVersion');
  });

  it('不支持的 provider 抛错', () => {
    const yaml = VALID_YAML.replace('anthropic', 'gemini');
    expect(() => parseAgentManifest(yaml)).toThrow('gemini');
  });

  it('缺少 systemPrompt 抛错', () => {
    const yaml = VALID_YAML.replace('systemPrompt: "你是一名需求分析师"', '');
    expect(() => parseAgentManifest(yaml)).toThrow('systemPrompt');
  });
});
