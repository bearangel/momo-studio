// eslint.config.mjs
// ESLint 9 flat config。v2.0.0 P3 收尾：移除 matrix-js-sdk 后切到 typescript-eslint 8 flat。
// 子进程 lint 只跑 src（不含 tests/，tests/ 走 vitest 跑单测不强制 lint）。
// react-hooks 规则通过 renderer .tsx 的 files 块单独开启——plugin 在 renderer devDeps，
// pnpm 严格 node_modules 布局下根 workspace 也能 resolve 到软链副本（import 验证通过）。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'resources/conduit/conduit-*'],
  }
);
