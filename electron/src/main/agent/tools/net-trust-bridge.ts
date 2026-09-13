// electron/src/main/agent/tools/net-trust-bridge.ts
//
// 网络信任门子进程 IPC 桥（spec 2026-09-13 §5，镜像 browser-ipc-bridge.ts）。
//
// 根因同浏览器工具：ShellTools 在 runtime 子进程执行，但信任门状态（sessionGrants /
// 等待表 / renderer 推卡）只能活在主进程——grants 生命周期挂在主进程 agent-runner
// 活跃任务表上，且信任卡推送需 webContents。本桥把两个查询代理为 process.send
// IPC 往返，由主进程 network-trust.handleNetTrustOp 分发：
//   - effective：spawn 前有效策略（netOn + awaitingAsk）
//   - wait：命令完成后阻塞询问（主进程复判触发条件三连后挂起等用户应答）
//
// 线协议（两端同 commit 修改——momo-boundary-rules 生产者消费者成对）：
//   child → main: { type: 'net-trust-op', requestId, op, streamSessionId, resultText? }
//   main → child: { type: 'net-trust-op:result', requestId, ok, payload? | error }
//
// 错误路径铁律（照抄 browser-ipc-bridge）：
//   - 超时 reject 中文文案并清 pending（防泄漏 + 迟到结果安全 no-op）
//   - process.send 不可用（非 fork 环境，如直跑单测）立即 reject，绝不挂等超时
//   - process.send 必须以方法调用形式发送（真实 Node 读 this.connected——
//     2.0.0 主机验收 P0-1 教训：解构裸调用在严格模式下直接抛错）
import { randomUUID } from 'node:crypto';
import { NETWORK_TRUST_TIMEOUT_MS } from '../../sandbox/network-trust';

/** 超时中文文案（同时覆盖「主进程未接线」情形——两态对子进程不可区分） */
const TIMEOUT_MESSAGE = '网络信任门 IPC 无响应（主进程未接线或超时）';

/** process.send 缺失文案（非 fork 环境直接跑 runtime-entry / 直跑工具单测的场景） */
const NO_SEND_MESSAGE = '网络信任门 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/**
 * wait op 的桥超时：主进程侧阻塞等待用户点击信任卡最长 NETWORK_TRUST_TIMEOUT_MS
 * （network-trust 单一真相源，本常量由其推导——编译期联动；测试锁「本值 ≥
 * NETWORK_TRUST_TIMEOUT_MS + 20s」防单边改小）。桥超时必须长于等待上限 + 裕量，
 * 否则用户还在思考时桥先超时，把「等待授权」误报为「IPC 无响应」。
 */
export const NET_TRUST_BRIDGE_TIMEOUT_MS = NETWORK_TRUST_TIMEOUT_MS + 20_000;

/** effective op 走默认档（主进程同步计算，60s 远超所需；仅防主进程卡死） */
const EFFECTIVE_BRIDGE_TIMEOUT_MS = 60_000;

/** spawn 前有效策略（主进程 effectiveNetwork 单点函数的镜像产物） */
export interface EffectiveNetworkDecision {
  netOn: boolean;
  awaitingAsk: boolean;
}

/** wait op 出口：granted=放行 / denied=拒绝（超时/用户拒绝）/ not-triggered=未命中触发条件 */
export type NetworkTrustWaitOutcome = 'granted' | 'denied' | 'not-triggered';

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
  op: 'effective' | 'wait',
  payload: { streamSessionId: string; resultText?: string },
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

/** spawn 前查询有效策略（每条 bash 命令一次往返——IPC 开销远小于进程 spawn 本身） */
export function requestEffectiveNetwork(streamSessionId: string): Promise<EffectiveNetworkDecision> {
  return sendNetTrustOp('effective', { streamSessionId }, EFFECTIVE_BRIDGE_TIMEOUT_MS) as
    Promise<EffectiveNetworkDecision>;
}

/**
 * 命令完成后阻塞询问（触发条件由主进程复判：ask 无 grant + net-off tag + 网络
 * 拒绝签名——resultText 携带完整结果文本，tag 行在内）。
 */
export function requestNetworkTrustWait(
  streamSessionId: string,
  resultText: string,
): Promise<NetworkTrustWaitOutcome> {
  return sendNetTrustOp('wait', { streamSessionId, resultText }, NET_TRUST_BRIDGE_TIMEOUT_MS) as
    Promise<NetworkTrustWaitOutcome>;
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
