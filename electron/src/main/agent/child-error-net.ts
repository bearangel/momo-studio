// electron/src/main/agent/child-error-net.ts
//
// runtime 子进程 'error' 事件吞并网（2026-11-11 会话停止竞速实录）：
// child.send 写已断管道的 EPIPE 可不同步抛，而异步以 'error' 事件打在
// ChildProcess 上——无监听即 uncaughtException（Electron「Uncaught Exception」
// 弹窗；时序：abortTurn 杀子 → 退出前最后一条 task_reply 在途 →
// notifyTaskReply）。与 AgentRunner.safeSend 的 try/catch + callback 双保险：
// 本网兜全部 send 位点（task-config / IPC 回包 / steer / shutdown）与
// kill 信号错误。语义：目标已死 = 消息合法不可达，warn 记痕吞并。
import type { ChildProcess } from 'node:child_process';
import { logger } from '../logger';

/**
 * 给 fork 出的 runtime 子进程挂 error 吞并监听（幂等——重复挂载去重）。
 * 导出供专项测试锁定语义；spawnForAgent 对每个 child 挂载。
 */
export function attachRuntimeChildErrorNet(child: ChildProcess, assignmentId: string): void {
  const listeners = child.listeners('error');
  for (const fn of listeners) {
    if ((fn as { __momoErrorNet?: string }).__momoErrorNet === assignmentId) return;
  }
  const onErr = (err: Error): void => {
    logger.warn('runtime 子进程 IPC/信号错误（吞并不抛穿）', {
      assignmentId,
      pid: child.pid,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  (onErr as { __momoErrorNet?: string }).__momoErrorNet = assignmentId;
  child.on('error', onErr);
}
