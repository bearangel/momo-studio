// electron/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // storage 目录用 forks（子进程）而非默认 threads（worker 线程）：
    // better-sqlite3 原生句柄在 worker 线程退出清理时存在 NAPI 竞态，密集
    // 建库/关库的 storage 测试会偶发 SIGSEGV（进程级崩溃，summary 都打不出来，
    // CI 直接红）。实测 threads 下同文件 5 跑 3 崩，forks 下 6 跑 0 崩
    //（2026-09-27 看板重构 Task 1）。其余目录维持 threads——forks 的 JSON
    // 序列化会卡部分测试的非标准 error 对象（vitest 1.6 已知限制）。
    pool: 'threads',
    poolMatchGlobs: [['tests/storage/**', 'forks']],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});