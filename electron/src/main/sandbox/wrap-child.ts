// electron/src/main/sandbox/wrap-child.ts
//
// ChildProcess → SandboxProcess 的通用适配器。三个沙箱实现（linux/macos/fallback）
// 底层都 spawn 一个 node 子进程，差别只在 argv 和前置准备（profile 生成等），
// 所以把"把 ChildProcess 包装成 SandboxProcess"这段公共逻辑抽出来复用。

import type { ChildProcess, Serializable } from 'node:child_process';
import type { SandboxProcess } from './types';

/**
 * 把 Node 的 ChildProcess 包装成 SandboxProcess 接口。
 * send 做了 try/catch 保护：子进程退出后 IPC channel 关闭，直接 send 会抛 EPIPE。
 */
export function wrapChild(child: ChildProcess): SandboxProcess {
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event, cb) => child.on(event, cb as (...args: unknown[]) => void),
    send: (msg) => {
      try {
        return child.send(msg as Serializable);
      } catch {
        // 子进程退出与发送之间的竞态，忽略
        return false;
      }
    },
    kill: (signal) => child.kill(signal as NodeJS.Signals),
    connected: child.connected,
  };
}
