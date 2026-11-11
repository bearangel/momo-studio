// electron/tests/agent/child-error-net.test.ts
//
// runtime 子进程 'error' 事件吞并网回归锁（2026-11-11 会话停止竞速实录）：
// abortTurn 杀死 runtime 后，退出前在途的 task_reply 触发 notifyTaskReply →
// child.send 写已断管道的 EPIPE 可不 同步抛，而异步以 'error' 事件打在
// ChildProcess 上——spawn 站点此前只挂 message/exit 监听，'error' 无监听
// 即 uncaughtException 弹窗（Electron「Uncaught Exception: write EPIPE」）。
// 本网对每个 fork 的 child 挂 error 监听：错误只记 warn，绝不抛穿。
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { attachRuntimeChildErrorNet } from '../../src/main/agent/child-error-net';
import { logger } from '../../src/main/logger';

describe('runtime 子进程 error 事件吞并网', () => {
  it('挂载后 child error 事件不抛穿（无监听的 EventEmitter.emit 即 uncaught）+ warn 记痕', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const child = new EventEmitter() as unknown as ChildProcess;
      attachRuntimeChildErrorNet(child, 'inst-net');
      expect(child.listenerCount('error')).toBe(1);
      expect(() => child.emit('error', new Error('write EPIPE'))).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        'runtime 子进程 IPC/信号错误（吞并不抛穿）',
        expect.objectContaining({ assignmentId: 'inst-net' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('重复挂载幂等（同一 child 二次调用不重复报警）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const child = new EventEmitter() as unknown as ChildProcess;
      attachRuntimeChildErrorNet(child, 'inst-a');
      attachRuntimeChildErrorNet(child, 'inst-a');
      expect(child.listenerCount('error')).toBe(1);
      child.emit('error', new Error('write EPIPE'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
