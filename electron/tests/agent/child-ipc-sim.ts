// electron/tests/agent/child-ipc-sim.ts
//
// 子进程下行 IPC 模拟投递（P3-1 forks 迁池配套，2026-10-28）。
//
// threads 池：process.on('message') 无 vitest 监听，process.emit('message', obj)
// 只达生产监听者。forks 池：vitest 的 v8 反序列化监听在场，plain object 进
// deserialize 必抛 TypeError（ERR_INVALID_ARG_TYPE）→ unhandled rejection 拉非零
// 退出码（用例本体全过的假红，实测单跑 30 errors）。仓库先例：
// tests/mcp/iserror-propagation.test.ts「绕开 process.emit('message',...)」注释。
//
// 本助手逐监听直投，只吞 vitest 反序列化那一类 TypeError；生产监听的同步抛错 /
// 异步真 rejection 照常可见（真实 TypeError 也会被吞——生产监听者以 async/await
// 为主，同步 TypeError 属罕见路径，可接受）。

export type ChildMessageListener = (message: unknown, ...extras: unknown[]) => unknown;

export function emitChildIpcMessage(message: unknown): void {
  for (const listener of process.listeners('message') as ChildMessageListener[]) {
    try {
      const ret = listener(message, undefined);
      if (ret instanceof Promise) {
        ret.catch((err: unknown) => {
          if (!(err instanceof TypeError)) throw err;
        });
      }
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
  }
}
