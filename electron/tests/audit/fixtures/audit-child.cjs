// electron/tests/audit/fixtures/audit-child.cjs
//
// 审计桥 fork 级测试的子进程夹具（纯 JS——由 node 直接执行，不进 vitest 收集）。
//
// 保真度（momo-test-rules）：本文件**不手抄任何线协议形状**——工具审计消息由
// 真实编译产物 audit.js 的 logToolCall 发出（真实 MOMO_RUNTIME_CHILD 哨兵门 +
// 真实 process.send + 真实 'audit:toolCall' 标签 + 真实摘要截断），主进程侧由
// 生产 spawnForAgent messageHandler → insertToolCall 落 temp DB。
//
// 输入（经环境变量，spawnForAgent 的 env 展开继承）：
//   AUDIT_FX_MODULE —— tsc 编译产物 audit.js 绝对路径（setup 期从 src 编译，
//                      与生产 dist 同一编译管线，杜绝夹具与源码形状漂移）
//   AUDIT_FX_CALLS  —— JSON 数组，逐项作为 logToolCall 入参（ToolCallAudit）
//
// 流程：runtime-ready 握手信号 → 逐条 logToolCall → done 消息回调确认 IPC
// 已 flush 后退出（回调保证：done 之前入队的审计消息已送达父进程）。

const calls = JSON.parse(process.env.AUDIT_FX_CALLS ?? '[]');
const audit = require(process.env.AUDIT_FX_MODULE);

// P0 boot 握手契约：先发 runtime-ready（spawnForAgent 等此信号才 resolve）
process.send({ type: 'runtime-ready' });

for (const c of calls) {
  audit.logToolCall(c);
}

// done 消息带回调：回调触发 = 本条之前的 IPC 消息均已送达父进程，此时退出
// 不会截断审计消息；2s 硬兜底防通道异常悬挂子进程。
process.send({ type: 'audit-fx-done' }, () => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
