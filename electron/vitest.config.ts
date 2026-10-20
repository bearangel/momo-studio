// electron/vitest.config.ts
import { defineConfig } from 'vitest/config';

// 双池分治（vitest 3 projects 内联——替代 1.x 的 poolMatchGlobs，后者在 run 模式从未生效）：
//
// 1. agent-threads：tests/agent 用 threads（worker 线程）。forks（子进程）下该目录必崩——
//    生产内部事件桥（agent 运行时经 process.send 回传 momo-internal-event）在 forks worker
//    里是真实通道（连着 vitest 的 tinypool IPC），消息污染 runner 协议 →
//    "Unexpected call to process.send()" Unhandled Rejection（2026-10-20 vitest 3 错误信息
//    实证定位，2026-09-27 记载的「序列化卡死」同根）。threads 池无 process.send（可选链
//    安全跳过）。治本方向＝dispatch 族测试 mock process.send 边界（momo-test-rules P0-1
//    同族），记为后续独立债，不在升级任务内扩面。
// 2. main-forks：其余全部目录用 forks。better-sqlite3 原生句柄在 worker 线程退出清理时
//    存在 NAPI 竞态，密集建库/关库的测试偶发 SIGSEGV（进程级崩溃，summary 都打不出来）；
//    forks 子进程隔离后全绿（2026-09-27/09-30 两轮实证，tests/task 4 跑 3~4 崩 → forks 全绿）。
// 1. agent-threads：tests/agent 用 threads（worker 线程）。其余目录一律 forks：
//    进程内 runtime 事件桥（process.send 回传 momo-internal-event）已由
//    MOMO_RUNTIME_CHILD 哨兵治本（internal-event.ts——仅 spawner fork 的真实子进程
//    持有发送权；2026-10-20 forks 池污染实证后的修复），threads 仅保留给 agent
//    目录以维持历史跑法（fake timers × gather 族在该目录另有 threads 下的既验证语义）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    projects: [
      {
        test: {
          name: 'agent-threads',
          include: ['tests/agent/**/*.test.ts'],
          environment: 'node',
          pool: 'threads',
          // 哨兵置位（生产=spawner env，见 internal-event.ts hasChildIpcChannel）：
          // threads 下与哨兵前置语义完全等价——无 stub 时 process.send=undefined 照旧静默，
          // 有 stub 时（属性替换）照旧送达。迟到异步事件在 stub 还原后因通道缺失自然哑火
          env: { MOMO_RUNTIME_CHILD: '1' },
        },
      },
      {
        test: {
          name: 'main-forks',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/agent/**'],
          environment: 'node',
          pool: 'forks',
          // 同上：foks worker 内 stub 依赖哨兵送达；无 stub 的发送因通道归 vitest 而被
          // 哨兵拦截（迟到事件防污染——integration 两文件另有 beforeEach/afterEach 作用域哨兵）
          env: { MOMO_RUNTIME_CHILD: '1' },
        },
      },
    ],
  },
});
