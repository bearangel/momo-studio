// electron/tests/agent/fake-runtime-stream.ts
//
// runtime-manager 流式中断传播测试用的假子进程。模拟 runtime-entry 的关键行为：
//   1. 启动时发送 start chunk（可选携带 parentStreamSessionId 模拟子 agent 嵌套）
//   2. 监听 abort IPC 消息，收到后回发 end(interrupted) chunk
//
// 通过环境变量配置（在 spawn 前由测试设置，doSpawnAgent 会把 process.env 透传给子进程）：
//   AP_SESSION_ID  本进程的 streamSessionId（必填）
//   AP_ROOM_ID     start chunk 携带的 roomId（必填）
//   AP_PARENT_ID   父 streamSessionId（可选；设置则模拟子 agent 嵌套场景）

const sessionId = process.env.AP_SESSION_ID;
const roomId = process.env.AP_ROOM_ID;
const parentId = process.env.AP_PARENT_ID;

if (!sessionId || !roomId) {
  process.stderr.write('fake-runtime-stream: 缺少 AP_SESSION_ID / AP_ROOM_ID\n');
  process.exit(1);
}

process.stdout.write(`READY ${sessionId}\n`);

// 发送 start chunk（模拟 runtime-entry 的 sendStreamChunk({ type: 'start', ... })）
// Task 6 字段迁移：roomId→sessionId、botUserId→senderAgentId
const startChunk: Record<string, unknown> = {
  type: 'start',
  streamSessionId: sessionId,
  sessionId: roomId,
  senderAgentId: '@fake-stream:localhost',
};
if (parentId) {
  startChunk.parentStreamSessionId = parentId;
}
process.send?.(startChunk);

// 监听 abort（模拟 runtime-entry 的 abortListener）
process.on('message', (msg: unknown) => {
  const m = msg as { type?: string; streamSessionId?: string };
  if (m.type === 'abort' && m.streamSessionId === sessionId) {
    process.stdout.write(`ABORTED ${sessionId}\n`);
    // 回发 end(interrupted) chunk（模拟 abortController.abort() 触发后的兜底）
    process.send?.({ type: 'end', streamSessionId: sessionId, finishReason: 'interrupted' });
  }
});

process.on('SIGTERM', () => process.exit(0));

// 兜底：8 秒后自行退出，避免测试遗漏 stop 导致僵尸进程
setTimeout(() => process.exit(0), 8000).unref();
