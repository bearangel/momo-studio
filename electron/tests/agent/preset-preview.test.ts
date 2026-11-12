// electron/tests/agent/preset-preview.test.ts
// 预置 agent 能力预览契约锁（2026-10-08 预设可见化 + 薄 fork）：
//   - resource:previewBuiltinPreset 的数据源 previewBuiltinPresetAgent 返回形状
//   - 错误路径：坏 slug 抛中文错（readBuiltinManifestBySlug 同语义）
// 使用真实 resources/agents 目录（保真优先——mock 目录会漏掉 YAML 真实形状漂移）。
// 2026-11-02 内置资源极简化：唯一预置 = general-assistant（Momo）；
// 已下架 slug 一律走「预设 agent 文件不存在」缺文件路径。
import { describe, it, expect } from 'vitest';
import { previewBuiltinPresetAgent } from '../../src/main/agent/builtin';

describe('previewBuiltinPresetAgent（预置能力预览，只读不落库）', () => {
  it('真实 YAML 目录：返回 slug/名称/能力三元组/全量 prompt（fork 与展示共用）', () => {
    const preview = previewBuiltinPresetAgent('general-assistant');
    expect(preview.slug).toBe('general-assistant');
    expect(preview.name).toBe('Momo');
    expect(typeof preview.iconEmoji).toBe('string');
    expect(typeof preview.description).toBe('string');
    // 能力三元组：ref 字符串数组（renderer CapabilityTabs 直接消费）
    expect(Array.isArray(preview.tools)).toBe(true);
    expect(preview.tools).toContain('webfetch');
    expect(Array.isArray(preview.mcps)).toBe(true);
    // 2026-11-09 资源创建：defaultSkills 恢复——挂资源创建技能
    // （与 builtin.test.ts 引用一致性锁同名单；原 3 册写作技能不回潮）
    // 2026-11-12 会话内能力管理：+manage-agent（4 → 5）
    expect([...preview.skills].sort()).toEqual(['build-team', 'create-agent', 'create-mcp', 'create-skill', 'manage-agent']);
    // systemPrompt 全量返回（截断由 renderer 展示层做——fork 需要全量）
    expect(preview.systemPrompt).toContain('万能小助手');
    // 内联写作纪律在位（原技能承载的行为不应随技能下架丢失）
    expect(preview.systemPrompt).toContain('长文先骨架确认后分节展开');
    expect(preview.systemPrompt).toContain('没验证的明说未验证');
  });

  it('坏 slug → 中文报错（含路径，与启用链同语义）', () => {
    expect(() => previewBuiltinPresetAgent('no-such-preset')).toThrow(/预设 agent 文件不存在/);
  });

  it('已下架的旧预置 slug → 同样中文报错（极简化回归锁，防文件悄悄回潮）', () => {
    expect(() => previewBuiltinPresetAgent('coder')).toThrow(/预设 agent 文件不存在/);
    expect(() => previewBuiltinPresetAgent('pm-agent')).toThrow(/预设 agent 文件不存在/);
  });

  it('空 slug → 同样中文报错（空输入专项）', () => {
    expect(() => previewBuiltinPresetAgent('')).toThrow(/预设 agent 文件不存在/);
  });
});
