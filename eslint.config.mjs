// eslint.config.mjs
// ESLint 9 flat config。v2.0.0 P3 收尾：移除 matrix-js-sdk 后切到 typescript-eslint 8 flat。
// 子进程 lint 只跑 src（不含 tests/，tests/ 走 vitest 跑单测不强制 lint）。
// react-hooks 规则通过 renderer .tsx 的 files 块单独开启——plugin 在 renderer devDeps，
// pnpm 严格 node_modules 布局下根 workspace 也能 resolve 到软链副本（import 验证通过）。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// v2.1 设计系统机械约束（docs/dev/design-system.md）：
// 1) 禁 className 中标准 Tailwind 色阶类 → 用语义 token
// 2) 禁 inline style 硬编码 hex/rgb 颜色 → 用语义 token class
// 3) 禁 JSX 文本/属性字符串 emoji → 用 lucide-react 图标
// v2.1 P4 全局 error 化（renderer/src 全覆盖；ui/ 与 task-status 冗余子块随之删除）。
const UI_RESTRICTED_SYNTAX = [
  {
    selector:
      "JSXAttribute[name.name='className'] Literal[value=/\\b(?:text|bg|border|ring|divide|placeholder|from|to)-(?:neutral|gray|zinc|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\\b/]",
    message:
      '禁止标准 Tailwind 色阶类：使用语义 token（bg-surface-1 / text-secondary / border-subtle 等，规范见 docs/dev/design-system.md）',
  },
  {
    selector: "JSXAttribute[name.name='style'] Literal[value=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(/]",
    message: '禁止 inline style 硬编码颜色：使用语义 token class（Avatar 的 hsl 动态派生为例外）',
  },
  {
    selector: 'JSXText[value=/\\p{Extended_Pictographic}/u]',
    message: '禁止 JSX 文本中的 emoji 图标：使用 lucide-react 线条图标',
  },
  {
    // 字符串属性形态：aria-label="⚙️ 设置"、title={'🤖'} 等
    selector: 'JSXAttribute[value.value=/\\p{Extended_Pictographic}/u]',
    message: '禁止 JSX 属性字符串中的 emoji：使用 lucide-react 线条图标（属性值请用文字）',
  },
  {
    // 表达式容器内的字符串字面量：attr={'⚙️'}
    selector: 'JSXExpressionContainer Literal[value=/\\p{Extended_Pictographic}/u]',
    message: '禁止 JSX 属性表达式中的 emoji 字符串：使用 lucide-react 线条图标（属性值请用文字）',
  },
];

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // '_' 前缀 = 故意不消费（API 形状对齐/解构剔除），args 与 vars 同约定
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // react-hooks 仅对 renderer 的 .ts/.tsx 生效（主进程不写 React 组件）
  {
    files: ['renderer/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  // 全局 error：v2.1 P4 收官——存量与新代码同等约束
  {
    files: ['renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...UI_RESTRICTED_SYNTAX],
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'resources/conduit/conduit-*'],
  }
);
