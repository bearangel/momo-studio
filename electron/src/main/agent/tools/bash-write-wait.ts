// electron/src/main/agent/tools/bash-write-wait.ts
// 有界阻塞等待循环（spec 2026-10-03 §12，浏览器 DEFAULT_AGENT_WAIT_MS 先例）：
// bash 结果检测到沙箱写拦截后，等待用户在授权卡上放行——covered 则由调用方
// 重执行同一命令（无缝续跑）；timeout/aborted 则按既有行为返回被拦结果。
//
// 非 fork 环境（process.send 缺失——直跑单测/CLI）短路为立即 timeout：没有
// 主进程就没有授权卡，等待无人应答，语义上等价于预算耗尽。
export type WriteWaitOutcome =
  | { kind: 'covered' }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/** 等待总预算（对齐浏览器 DEFAULT_AGENT_WAIT_MS=120s） */
export const BASH_WRITE_WAIT_MS = 120_000;
/** 轮询节拍（每拍一次 effective 桥查询，120s 至多 60 次 IPC——开销可忽略） */
export const BASH_WRITE_WAIT_TICK_MS = 2_000;

export async function waitForWriteGrant(opts: {
  dirs: string[];
  /** 覆盖判定（生产 = effective 桥轮询：toolchainOn || dirs ∈ extraDirs） */
  isCovered: () => Promise<boolean>;
  budgetMs?: number;
  tickMs?: number;
  signal?: AbortSignal;
}): Promise<WriteWaitOutcome> {
  if (typeof process.send !== 'function') return { kind: 'timeout' };
  const budget = opts.budgetMs ?? BASH_WRITE_WAIT_MS;
  const tick = opts.tickMs ?? BASH_WRITE_WAIT_TICK_MS;
  const deadline = Date.now() + budget;

  for (;;) {
    if (opts.signal?.aborted) return { kind: 'aborted' };
    if (await opts.isCovered()) return { kind: 'covered' };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: 'timeout' };
    // 可中断 sleep：abort 立即唤醒（不占满剩余预算）
    await sleepInterruptible(Math.min(tick, remaining), opts.signal);
    if (opts.signal?.aborted) return { kind: 'aborted' };
  }
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
