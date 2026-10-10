// electron/tests/agent/preset-preview.test.ts
// 预置 agent 能力预览契约锁（2026-10-08 预设可见化 + 薄 fork）：
//   - resource:previewBuiltinPreset 的数据源 previewBuiltinPresetAgent 返回形状
//   - 错误路径：坏 slug 抛中文错（readBuiltinManifestBySlug 同语义）
// 使用真实 resources/agents 目录（保真优先——mock 目录会漏掉 YAML 真实形状漂移）。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { previewBuiltinPresetAgent } from '../../src/main/agent/builtin';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('previewBuiltinPresetAgent（预置能力预览，只读不落库）', () => {
  it('真实 YAML 目录：返回 slug/名称/能力三元组/全量 prompt（fork 与展示共用）', () => {
    const preview = previewBuiltinPresetAgent('ui-designer');
    expect(preview.slug).toBe('ui-designer');
    expect(preview.name).toBe('Muse');
    expect(typeof preview.iconEmoji).toBe('string');
    expect(typeof preview.description).toBe('string');
    // 能力三元组：ref 字符串数组（renderer CapabilityTabs 直接消费）
    expect(Array.isArray(preview.tools)).toBe(true);
    expect(preview.tools).toContain('browser_screenshot');
    expect(Array.isArray(preview.mcps)).toBe(true);
    expect(Array.isArray(preview.skills)).toBe(true);
    expect(preview.skills).toContain('design-critique');
    // systemPrompt 全量返回（截断由 renderer 展示层做——fork 需要全量）
    expect(preview.systemPrompt).toContain('设计规范守护者');
  });

  it('真实 YAML 目录：v2.0.0 新增阵容可预览（Hawk 只审不改 / Sherlock 浏览器组 / Momo 通用兜底）', () => {
    const hawk = previewBuiltinPresetAgent('code-reviewer');
    expect(hawk.name).toBe('Hawk');
    expect(hawk.tools).toContain('git_diff');
    expect(hawk.systemPrompt).toContain('从不直接改代码');

    const sherlock = previewBuiltinPresetAgent('researcher');
    expect(sherlock.name).toBe('Sherlock');
    expect(sherlock.tools).toContain('browser_navigate');
    expect(sherlock.tools).toContain('office_read');
    expect(sherlock.systemPrompt).toContain('每个结论都附出处');

    const momo = previewBuiltinPresetAgent('general-assistant');
    expect(momo.name).toBe('Momo');
    expect(momo.tools).toContain('webfetch');
    expect(momo.systemPrompt).toContain('万能小助手');
  });

  it('skills 引用形如 slug 字符串（非 {kind,ref} 对象——出参形状锁）', () => {
    const preview = previewBuiltinPresetAgent('office-assistant');
    for (const s of preview.skills) {
      expect(typeof s, `skill 项应为 string，收到 ${JSON.stringify(s)}`).toBe('string');
    }
    expect(preview.skills).toContain('excel-analysis');
  });

  it('坏 slug → 中文报错（含路径，与启用链同语义）', () => {
    expect(() => previewBuiltinPresetAgent('no-such-preset')).toThrow(/预设 agent 文件不存在/);
  });

  it('空 slug → 同样中文报错（空输入专项）', () => {
    expect(() => previewBuiltinPresetAgent('')).toThrow(/预设 agent 文件不存在/);
  });
});
