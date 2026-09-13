// electron/src/main/agent/tools/net-trust-bridge.ts
//
// 沙箱网络出站策略子进程 IPC 桥（2026-09-13 修订 B 双态化，镜像
// browser-ipc-bridge.ts 结构）。ShellTools 在 runtime 子进程执行，但网络双态
// 策略（deny/allow）的真相源在主进程 settings kv——本桥把查询代理为
// process.send IPC 往返，由主进程 network-trust.handleNetTrustOp 分发：
//   - effective：spawn 前有效网络态（netOn = policy === 'allow'）
// （三态时代的 wait 阻塞询问 op 已随 ask 信任门机制全链下线。）
//
// 线协议（两端同 commit 修改——momo-boundary-rules 生产者消费者成对）：
//   child → main: { type: 'net-trust-op', requestId, op: 'effective', streamSessionId }
//   main → child: { type: 'net-trust-op:result', requestId, ok, payload? | error }
//
// 错误路径铁律（照抄 browser-ipc-bridge）：
//   - 超时 reject 中文文案并清 pending（防泄漏 + 迟到结果安全 no-op）
//   - process.send 不可用（非 fork 环境，如直跑单测）立即 reject，绝不挂等超时
//   - process.send 必须以方法调用形式发送（真实 Node 读 this.connected——
//     2.0.0 主机验收 P0-1 教训：解构裸调用在严格模式下直接抛错）
import { randomUUID } from 'node:crypto';

/** 超时中文文案（同时覆盖「主进程未接线」情形——两态对子进程不可区分） */
const TIMEOUT_MESSAGE = '网络策略 IPC 无响应（主进程未接线或超时）';

/** process.send 缺失文案（非 fork 环境直接跑 runtime-entry / 直跑工具单测的场景） */
const NO_SEND_MESSAGE = '网络策略 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/** effective op 超时档（主进程同步计算，60s 远超所需；仅防主进程卡死） */
const EFFECTIVE_BRIDGE_TIMEOUT_MS = 60_000;

/** spawn 前有效网络态（主进程双态策略单点判定的镜像产物） */
export interface EffectiveNetworkDecision {
  netOn: boolean;
}

interface PendingEntry {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** requestId → 在途请求（进程级单例——每 op 一个随机 UUID，真实唯一） */
const pending = new Map<string, PendingEntry>();

/**
 * 发送一次 net-trust-op 并等待应答。requestId 单点生成（randomUUID）沿线透传——
 * 主进程应答按 requestId 原样回带，任何一跳重新生成 ID 都会断链。
 */
function sendNetTrustOp(
  op: 'effective',
  payload: { streamSessionId: string },
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: 'net-trust-op', requestId, op, ...payload });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** spawn 前查询有效网络态（每条 bash 命令一次往返——IPC 开销远小于进程 spawn 本身） */
export function requestEffectiveNetwork(streamSessionId: string): Promise<EffectiveNetworkDecision> {
  return sendNetTrustOp('effective', { streamSessionId }, EFFECTIVE_BRIDGE_TIMEOUT_MS) as
    Promise<EffectiveNetworkDecision>;
}

/**
 * 消费主进程应答（runtime-entry 的 taskMessageListener 分发到此）。按 requestId
 * 派发到 pending 表；ok=false 时 new Error(message)。未知 requestId（迟到 / 重复 /
 * 跨桥残留）静默忽略——不崩不误伤在途请求。
 */
export function handleNetTrustOpResult(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: unknown; ok?: boolean; payload?: unknown; error?: string };
  if (m.type !== 'net-trust-op:result' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) {
    entry.resolve(m.payload);
  } else {
    entry.reject(new Error(typeof m.error === 'string' ? m.error : TIMEOUT_MESSAGE));
  }
}
