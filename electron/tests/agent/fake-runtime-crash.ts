// electron/tests/agent/fake-runtime-crash.ts
//
// 模拟崩溃/退出的 agent 子进程，供 circuit breaker 单测使用。
//   - AP_FAKE_EXIT_CODE（默认 1）：退出码。1=崩溃（触发重启），0=正常退出
//   - AP_FAKE_DELAY_MS（默认 0）：退出前存活毫秒数。>0 时 SIGTERM 也以指定码退出
//     （用于测试 stopAgent 后即使 code≠0 也不重启的 stoppedManually 路径）

const code = parseInt(process.env.AP_FAKE_EXIT_CODE ?? '1', 10);
const delay = parseInt(process.env.AP_FAKE_DELAY_MS ?? '0', 10);

if (delay > 0) {
  process.on('SIGTERM', () => process.exit(code));
  setTimeout(() => process.exit(code), delay);
} else {
  process.exit(code);
}
