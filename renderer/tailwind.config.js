// renderer/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    // v2.1 P4：colors 独占定义（原 extend.colors）——完全替换 Tailwind 默认色阶，
    // 裸色号类（bg-gray-800 / text-neutral-500 等）自此在编译层不生成任何 CSS。
    // transparent / current 本属默认色阶成员，替换后不会被内建保留，须显式声明
    //（src 有 border-transparent 等消费）。
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      /* ===== v2.1 语义 token（规范见 docs/dev/design-system.md） ===== */
      canvas: 'rgb(var(--bg-canvas) / <alpha-value>)',
      surface: {
        1: 'rgb(var(--surface-1) / <alpha-value>)',
        2: 'rgb(var(--surface-2) / <alpha-value>)',
        3: 'rgb(var(--surface-3) / <alpha-value>)',
        active: 'var(--surface-active)', // 形式二：完整值，禁 /nn 修饰符
      },
      primary: 'rgb(var(--text-primary) / <alpha-value>)',
      secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
      tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
      disabled: 'rgb(var(--text-disabled) / <alpha-value>)',
      inverse: '#ffffff',
      subtle: 'rgb(var(--border-subtle) / <alpha-value>)',
      strong: 'rgb(var(--border-strong) / <alpha-value>)',
      focus: 'rgb(var(--border-focus) / <alpha-value>)',
      accent: {
        300: 'rgb(var(--accent-300) / <alpha-value>)',
        500: 'rgb(var(--accent-500) / <alpha-value>)',
        600: 'rgb(var(--accent-600) / <alpha-value>)',
      },
      status: {
        success: 'rgb(var(--status-success) / <alpha-value>)',
        warning: 'rgb(var(--status-warning) / <alpha-value>)',
        error: 'rgb(var(--status-error) / <alpha-value>)',
        violet: 'rgb(var(--status-violet) / <alpha-value>)',
        'success-tint': 'var(--status-success-tint)',
        'warning-tint': 'var(--status-warning-tint)',
        'error-tint': 'var(--status-error-tint)',
        'violet-tint': 'var(--status-violet-tint)',
      },
      backdrop: 'var(--bg-backdrop)',
    },
  },
  plugins: [],
};
