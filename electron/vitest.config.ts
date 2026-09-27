// electron/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // DB 重度目录用 forks（子进程）而非默认 threads（worker 线程）：
    // better-sqlite3 原生句柄在 worker 线程退出清理时存在 NAPI 竞态，密集
    // 建库/关库的测试偶发 SIGSEGV（进程级崩溃，summary 都打不出来，CI 直接红）。
    // 实测（2026-09-27 看板重构 Task 1）：tests/task 在 threads 下 4 跑 3~4 崩
    // （与本任务代码无关，卸掉 migration 047 后 4 跑 4 崩复现），forks 下 18 文件
    // 134 用例全绿；storage 全量 forks 下 3 跑 0 崩。其余目录维持 threads——
    // 全局 forks 会被 vitest 1.6 的 JSON 序列化卡死（tests/agent 某用例的
    // error 载荷不可序列化，runner 级 Unhandled Rejection，待后续任务收敛）。
    pool: 'threads',
    poolMatchGlobs: [
      ['tests/storage/**', 'forks'],
      ['tests/task/**', 'forks'],
      ['tests/memory/**', 'forks'],
      ['tests/journal/**', 'forks'],
      ['tests/upgrade/**', 'forks'],
      ['tests/integration/**', 'forks'],
      ['tests/audit/**', 'forks'],
      ['tests/compaction/**', 'forks'],
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});