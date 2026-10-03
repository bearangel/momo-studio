// electron/src/main/agent/tools/write-grant-wait.ts
// 写授权硬门控等待循环（spec 2026-10-03 hard-gate §3/§5；前生 bash-write-wait §12）：
// 越界工具调用挂起等待用户在授权卡上处置——三出口：
//   covered = 轮询 effective 成员判定命中（授权落地，调用方原地重执行）
//   denied  = 主进程广播 write-grant-denied 推送解除（用户拒绝，即时返回）
//   aborted = ctx.abortSignal（停止按钮——无限等待下唯一的机器侧逃生口）
// 无限等待：无预算上限（产品裁定对齐 Claude Code）。
//
// 非 fork 环境（process.send 缺失——直跑单测/CLI）短路为立即 denied：没有主进程
// 就没有授权卡，等待无人应答，语义上等价用户缺席时的拒绝收敛。

export type WriteWaitOutcome =
  | { kind: 'covered' }
  | { kind: 'denied' }
  | { kind: 'aborted' };

/** 轮询节拍（每拍一次 effective 桥查询，IPC 开销可忽略） */
export const WRITE_GRANT_WAIT_TICK_MS = 2_000;

/** 拒绝广播的等待方匹配（spec §4.4）：dirs 有交集，或两侧均为空（降级卡关闭意图） */
function denialMatches(waitDirs: string[], denyDirs: string[]): boolean {
  if (denyDirs.length === 0) return waitDirs.length === 0;
  return waitDirs.some((d) => denyDirs.includes(d));
}

interface DeniedWaiter {
  dirs: string[];
  fire: () => void;
}

/** 在途等待订阅表（模块级——同进程多个工具调用各自注册互不干扰） */
const deniedWaiters = new Set<DeniedWaiter>();

/**
 * 主进程 write-grant-denied 广播的消费入口（runtime-entry 的 taskMessageListener
 * 分发到此）。按 §4.4 匹配规则唤醒在途等待；无匹配 no-op。载荷形状不符静默忽略
 * （未知消息不崩——线协议向后兼容铁律）。
 */
export function notifyWriteGrantDenied(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: unknown; dirs?: unknown };
  if (m.type !== 'write-grant-denied') return;
  if (!Array.isArray(m.dirs) || m.dirs.some((d) => typeof d !== 'string')) return;
  for (const w of [...deniedWaiters]) {
    if (denialMatches(w.dirs, m.dirs as string[])) w.fire();
  }
}

/** 测试用：清空订阅表（防跨用例泄漏） */
export function __clearDeniedWaitersForTest(): void {
  deniedWaiters.clear();
}

export async function waitForWriteGrant(opts: {
  dirs: string[];
  /** 覆盖判定（生产 = effective 桥轮询：dirs ⊆ extraDirs 三层合成） */
  isCovered: () => Promise<boolean>;
  tickMs?: number;
  signal?: AbortSignal;
}): Promise<WriteWaitOutcome> {
  // 非 fork 短路（原 §12 timeout 短路的拒绝语义迁移）
  if (typeof process.send !== 'function') return { kind: 'denied' };
  const tick = opts.tickMs ?? WRITE_GRANT_WAIT_TICK_MS;

  let deniedFired = false;
  let deniedResolve!: () => void;
  const deniedPromise = new Promise<void>((resolve) => {
    deniedResolve = resolve;
  });
  const waiter: DeniedWaiter = {
    dirs: opts.dirs,
    fire: () => {
      deniedFired = true;
      deniedResolve();
    },
  };
  deniedWaiters.add(waiter);
  try {
    for (;;) {
      if (opts.signal?.aborted) return { kind: 'aborted' };
      if (await opts.isCovered()) return { kind: 'covered' };
      // 三路竞速：denied 推送 / abort / tick 到点。denied 胜出时 sleep 侧 timer
      // 可能仍挂一拍（≤tick 后自然 resolve，无副作用）——可接受的悬挂粒度。
      await Promise.race([deniedPromise, sleepInterruptible(tick, opts.signal)]);
      if (opts.signal?.aborted) return { kind: 'aborted' };
      if (deniedFired) return { kind: 'denied' };
    }
  } finally {
    deniedWaiters.delete(waiter);
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

/** denied 出口回给 LLM 的统一文案（bash 与文件工具共用，spec §7 逐字） */
export function formatWriteDeniedResult(dirs: string[]): string {
  return `用户已拒绝授权（目录：${dirs.join('、') || '未能定位'}）。请勿重试同一目标；如确需写入请与用户协商其他方案。`;
}
