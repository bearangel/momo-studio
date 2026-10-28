// electron/tests/agent/forks-ipc-guard.ts
//
// agent 组 forks 池 IPC 守卫（P3-1 迁池配套，2026-10-28）。
//
// threads 时代 worker 线程无 process.send 属性、vitest RPC 走 worker_threads
// 端口——process 的消息通道（send 属性 + 'message' 事件）是测试与生产监听的
// 独占领地。迁 forks 后该通道归属 vitest/tinypool IPC，裸环境与既有用例语义
// 冲突面有两处：
//
// 1. 发送侧探测：生产代码以 `typeof process.send === 'function'` 判 fork 环境
//   （write-grant-wait 短路 denied、net-trust/process/browser 三桥 NO_SEND 快速
//   reject、logToolCall/sendInternalEvent 可选链静默 no-op）。forks 下探测翻真
//   → 未打桩上行真发污染 runner 协议（"Unexpected call to process.send()"
//   Unhandled Rejection，实测 net-trust-op 与 audit:toolCall 双源，一次杀整跑）
//   + 探测语义漂移致用例假红/挂死。
//   治法：把属性置回 undefined——vitest worker 信使在模块加载时捕获引用
//   （vitest dist utils「Store global APIs in case process is overwritten by
//   tests」，明确预期测试覆写该属性），置 undefined 对其零影响；打桩用例
//   （属性替换收集事件）叠加其上照常生效（组 env 哨兵 MOMO_RUNTIME_CHILD=1
//   已置位，桩函数经 hasChildIpcChannel 放行）。
//
// 2. 接收侧模拟：多个用例以 `process.emit('message', 对象)` 模拟子进程下行
//   消息（runtime-entry-steer / plugin-hook-bridge 等）。threads 下
//   process.on('message') 无 vitest 监听，emit 只达生产监听者；forks 下 vitest
//   的反序列化监听在场，plain object 进 deserialize 必抛 TypeError → 汇成
//   「Errors N」拉非零退出码（实测 30 errors，用例本体 4/4 全过）。
//   不在本守卫处理：vitest 每文件重注册 rpc 监听，监听级包裹覆盖不全（实证
//   有直调裸监听者的路径）——由 tests/agent/child-ipc-sim.ts 的逐监听直投
//   助手在用例侧收口。

type SendFn = (message: unknown) => boolean;

if (typeof process.send === 'function') {
  (process as { send?: SendFn }).send = undefined;
}
