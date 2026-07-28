// electron/tests/agent/fake-runtime.ts
//
// runtime-manager 单测用的假子进程入口：模拟真实 runtime-entry 的存活行为。
// 启动后写一行 READY 到 stdout，然后保持存活直到收到 SIGTERM。
// 不消费 AGENT_CONFIG（测试只验证进程池的 spawn/stop 生命周期，不验证配置传递）。

process.stdout.write('fake-runtime READY\n');

process.on('SIGTERM', () => {
  process.exit(0);
});

// 兜底：无论如何 3 秒后自行退出，避免测试遗漏 stop 导致子进程残留。
// unref() 使该定时器不单独维持事件循环存活（存活由上面的 SIGTERM 监听负责）。
setTimeout(() => process.exit(0), 3000).unref();
