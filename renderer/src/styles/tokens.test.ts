// 设计 token 定义锁：tailwind.config 语义映射 + globals.css 明暗双套变量。
// 该测试防止「改了 CSS 变量名却忘了改 Tailwind 映射」的契约漂移。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, 'globals.css'), 'utf-8');

const ALL_VARS = [
  '--bg-canvas', '--surface-1', '--surface-2', '--surface-3', '--surface-active',
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled',
  '--border-subtle', '--border-strong', '--border-focus',
  '--accent-300', '--accent-500', '--accent-600',
  '--status-success', '--status-warning', '--status-error', '--status-violet',
  '--bg-backdrop',
  '--status-success-tint', '--status-warning-tint', '--status-error-tint', '--status-violet-tint',
];

describe('设计 token 定义', () => {
  it('Tailwind 语义 token 映射到 CSS 变量', () => {
    // 类型收窄：config 无 theme.extend 时跳过断言会漏检，这里断言结构本身
    const colors = tailwindConfig.theme.extend.colors;
    expect(colors.canvas).toBe('rgb(var(--bg-canvas) / <alpha-value>)');
    expect(colors.surface[1]).toBe('rgb(var(--surface-1) / <alpha-value>)');
    expect(colors.surface[2]).toBe('rgb(var(--surface-2) / <alpha-value>)');
    expect(colors.surface[3]).toBe('rgb(var(--surface-3) / <alpha-value>)');
    expect(colors.surface.active).toBe('var(--surface-active)');
    expect(colors.primary).toBe('rgb(var(--text-primary) / <alpha-value>)');
    expect(colors.secondary).toBe('rgb(var(--text-secondary) / <alpha-value>)');
    expect(colors.tertiary).toBe('rgb(var(--text-tertiary) / <alpha-value>)');
    expect(colors.disabled).toBe('rgb(var(--text-disabled) / <alpha-value>)');
    expect(colors.inverse).toBe('#ffffff');
    expect(colors.subtle).toBe('rgb(var(--border-subtle) / <alpha-value>)');
    expect(colors.strong).toBe('rgb(var(--border-strong) / <alpha-value>)');
    expect(colors.focus).toBe('rgb(var(--border-focus) / <alpha-value>)');
    expect(colors.accent[300]).toBe('rgb(var(--accent-300) / <alpha-value>)');
    expect(colors.accent[500]).toBe('rgb(var(--accent-500) / <alpha-value>)');
    expect(colors.accent[600]).toBe('rgb(var(--accent-600) / <alpha-value>)');
    expect(colors.status.success).toBe('rgb(var(--status-success) / <alpha-value>)');
    expect(colors.status['success-tint']).toBe('var(--status-success-tint)');
    expect(colors.backdrop).toBe('var(--bg-backdrop)');
  });

  it('旧 token 迁移期共存（P4 才移除）', () => {
    const colors = tailwindConfig.theme.extend.colors;
    expect(colors.bg.primary).toBe('#1a1a1a');
    expect(colors.border.subtle).toBe('#3a3a3a');
    expect(colors.accent.blue).toBe('#3b82f6');
    expect(colors.accent.purple).toBe('#8b5cf6');
  });

  it('globals.css 定义明暗两套完整变量', () => {
    expect(css).toMatch(/^:root\s*\{/m);
    expect(css).toMatch(/^\.dark\s*\{/m);
    for (const name of ALL_VARS) {
      // 按「定义形态」计数（名字后紧跟冒号）：每个 token 必须恰好在 :root 与 .dark 各定义一次。
      // 不能裸 split(name)——使用点（body/.md-*/滚动条）与前缀碰撞（--status-success 是
      // --status-success-tint 的前缀）都会污染计数。
      const count = css.split(`${name}:`).length - 1;
      expect(count, `${name} 应在 :root 与 .dark 各定义一次，实际 ${count}`).toBe(2);
    }
  });

  it('md-body 代码块/行内代码显式设色（强调底气泡可读性）', () => {
    // isSelf 气泡 bg-accent-500 + text-inverse 下，code/pre 若不显式设色
    // 会继承白色文字 → 亮色模式 surface-2 近白底不可见（P2 Task9 终审 Important）
    expect(css).toMatch(/\.md-body pre\s*\{[^}]*color:\s*rgb\(var\(--text-primary\)\)/);
    expect(css).toMatch(/\.md-body :not\(pre\) > code\s*\{[^}]*color:\s*rgb\(var\(--text-primary\)\)/);
    // 同理：accent 底气泡内 a/blockquote 必须 color:inherit 反白——accent-600 链接
    // 与 secondary 引用文字在 accent 底上均不可读（P2 终审 sweep 回归锁）
    expect(css).toMatch(/\.bg-accent-500 \.md-body a\s*\{[^}]*color:\s*inherit/);
    expect(css).toMatch(/\.bg-accent-500 \.md-body blockquote\s*\{[^}]*color:\s*inherit/);
  });

  it('暗黑模式声明 color-scheme（原生控件随主题）', () => {
    expect(css).toMatch(/\.dark\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
  });
});
