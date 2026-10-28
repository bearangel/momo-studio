import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 单测贴源存放规范：仅收集 src/ 下与源码同目录的测试文件（见 AGENTS.md「单元测试文件存放规范」）。
    // 显式 include 与 electron workspace 对齐——放到 src/ 之外的测试不会被收集执行。
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // monaco 相关测试在全量并行跑时 hook 内加载 editor 全量模块，默认 10s hook
    // 超时不够（P2 实测：裸跑红、CLI --hookTimeout=60000 全绿）——固化到配置，
    // CI 与本地零 CLI 参数一致（M3.0 T3）。
    hookTimeout: 60000,
  },
});
