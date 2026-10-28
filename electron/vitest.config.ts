// electron/vitest.config.ts
import { defineConfig } from 'vitest/config';

// 双池分治 → 全量 forks（vitest 3 projects 内联——替代 1.x 的 poolMatchGlobs，后者在 run 模式从未生效）：
//
// 历史脉络（三阶段）：
//   1) 最初 agent 目录用 threads：forks（子进程）下该目录必崩——生产内部事件桥（agent
//      运行时经 process.send 回传 momo-internal-event）在 forks worker 里是真实通道（连着
//      vitest 的 tinypool IPC），消息污染 runner 协议 → "Unexpected call to process.send()"
//      Unhandled Rejection（2026-10-20 vitest 3 错误信息实证定位，2026-09-27 记载的
//      「序列化卡死」同根）。
//   2) 2026-10-20 MOMO_RUNTIME_CHILD 哨兵治本（internal-event.ts——仅 spawner fork 的真实
//      子进程持有发送权），forks 污染面消除；当时 threads 仅保留给 agent 目录以维持历史跑法
//      （fake timers × gather 族在该目录另有 threads 下的既验证语义）。
//   3) 2026-10-28 agent 目录也迁 forks：threads 池 worker 线程退出清理存在 better-sqlite3
//      NAPI 析构竞态，全量负载下 agent 组 4/5 次崩（SIGSEGV，进程级、summary 打不出来）——
//      与 tests/task 当年迁 forks 同族（见下条）。迁移以「用例计数/断言前后零差」对照验收
//      （threads 基线 182 文件 / 1892 用例）；哨兵 env 该组照旧保留（forks 下 stub 依赖
//      哨兵送达，语义见 main-forks 注释）。
// 其余全部目录自 2026-09-27 起就用 forks：better-sqlite3 原生句柄在 worker 线程退出清理时
// 存在 NAPI 竞态，密集建库/关库的测试偶发 SIGSEGV；forks 子进程隔离后全绿
// （2026-09-27/09-30 两轮实证，tests/task 4 跑 3~4 崩 → forks 全绿）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // forks 冷 worker 的 transform + 63 条迁移成本、真实子进程用例（git/spawn/沙箱）
    // 在全量负载下常超 vitest 默认 5s（2026-10-20 终验实证，隔离恒绿）——统一 15s
    testTimeout: 15_000,
    // hookTimeout 默认 10s：git-tools-repo 等真 fixture 用例 beforeEach 多次 execSync
    // git init（双仓 ×3 命令），全量负载下偶发超限 flaky（2026-10-28 P3-2 实证）——
    // 上调 30s 只放宽慢 hook 容忍度，不动用例语义
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    projects: [
      {
        test: {
          // 名字保留 agent-threads（历史名，无脚本依赖；引用面仅 CHANGELOG 与本文件）
          name: 'agent-threads',
          include: ['tests/agent/**/*.test.ts'],
          environment: 'node',
          // 2026-10-28 自 threads 迁入（P3-1）：threads worker 线程退出清理的 NAPI 析构
          // 竞态在全量负载下 4/5 次崩该组（SIGSEGV）——与 tests/task 当年同族，forks 隔离
          pool: 'forks',
          testTimeout: 15_000,
          // forks 下 process.send 是 vitest tinypool 真通道：守卫把属性置回
          // undefined，按构造复刻 threads「无桥」环境（探测/桥语义/打桩链全一致）
          // ——见 tests/setup/forks-ipc-guard.ts 头注
          setupFiles: ['./tests/setup/forks-ipc-guard.ts'],
          // 哨兵置位（生产=spawner env，见 internal-event.ts hasChildIpcChannel）：
          // 打了桩的用例（属性替换 process.send）经哨兵放行照常送达测试收集器；
          // 未打桩的上行（含 audit:toolCall / momo-internal-event）由 setupFiles
          // 守卫拦截，不会漏进 runner IPC
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
          testTimeout: 15_000,
          // 同上 + 与 agent-threads 同一条守卫（M2.4 T6 补挂）：env 哨兵为 1 时生产侧
          // 多处只判 env 就发（audit/stream-chunk/write-grant 等），forks 下 process.send
          // 真是 tinypool 通道 → 未打桩上行会漏进 vitest reporter。守卫置 send=undefined
          // 把这些上行收口为 NO_SEND no-op；打桩用例（属性替换）不受影响。
          setupFiles: ['./tests/setup/forks-ipc-guard.ts'],
          // 同上：foks worker 内 stub 依赖哨兵送达（迟到事件防污染——integration 两文件
          // 另有 beforeEach/afterEach 作用域哨兵）
          env: { MOMO_RUNTIME_CHILD: '1' },
        },
      },
    ],
  },
});
