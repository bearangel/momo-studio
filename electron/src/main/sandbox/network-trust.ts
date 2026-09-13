// electron/src/main/sandbox/network-trust.ts
//
// 沙箱网络出站信任门（spec 2026-09-13 §5，方案 A 阻塞式）——主进程单点：
//   - sessionGrants：streamSessionId → granted/denied（会话级授权，严格随任务
//     生命周期——agent-runner 活跃任务表终态时清理，spec §3 非目标：不跨任务记忆）
//   - 单飞等待表：同 streamSessionId 并发命中只推一张信任卡，join 同一裁决
//   - 阻塞询问协议：推卡 → 等待（≤180s）→ 三值应答 / 超时=deny / 迟到应答 no-op
//
// 纪律对齐 browser/policy.ts：纯逻辑零 electron 依赖（推送 / 持久化 / 时钟全部
// 构造注入，单测直驱）。子进程 shell-tools 经 net-trust-bridge IPC 桥调用本模块
// （handleNetTrustOp），grants 活在主进程内存、子进程不可见。
import { logger } from '../logger';
import type { NetworkPolicy } from './settings';

export type { NetworkPolicy } from './settings';

/** 阻塞询问上限（spec §5 协议 2）；导出供桥侧超时分档联动（改一处另一处编译期可见） */
export const NETWORK_TRUST_TIMEOUT_MS = 180_000;

/** 信任卡三值应答（镜像浏览器 answerTrust 语义，spec §2） */
export type NetworkTrustAnswer = 'session' | 'always' | 'deny';
/** 等待出口：granted=放行（结果尾追加提示）/ denied=拒绝（失败结果原样返回） */
export type NetworkTrustOutcome = 'granted' | 'denied';
export type NetworkGrantValue = 'granted' | 'denied';

/** m→r 推送载荷（sandbox:notice 通道）。createdAt 供卡片倒计时（180s 窗口两端对齐） */
export interface NetworkTrustNotice {
  kind: 'net-trust-request';
  text: string;
  streamSessionId: string;
  createdAt: number;
}

/** 时钟注入面（测试勿真睡铁律）：默认真实 setTimeout（unref）；测试传手动触发桩 */
export interface TrustClock {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultClock: TrustClock = {
  setTimer: (cb, ms) => {
    const t = setTimeout(cb, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

// ─── 网络拒绝签名双条件（主进程侧复刻 renderer/src/stores/stream.store.ts:30，
// spec §5 要求对齐其正则——tag 在场 = 网络态权威 + 任一失败签名；仅 tag 不触发
// （未碰网络的命令不打扰）、仅签名不触发（非沙箱所致的网络错误））───
const SANDBOX_NET_OFF_TAG = /sandbox: (?:seatbelt|bwrap)\/net-off/;
const NET_BLOCKED_SIGNATURES: readonly RegExp[] = [
  /listen EPERM/i,
  /(?:connect|connection)[^\n]{0,60}EPERM/i,
  /Could not resolve host/i,
  /curl: \((?:6|7)\)/,
];

/** 双条件判定：bash 结果文本同时命中 net-off tag 与网络失败签名 */
export function detectNetworkBlocked(resultText: string): boolean {
  return (
    SANDBOX_NET_OFF_TAG.test(resultText) &&
    NET_BLOCKED_SIGNATURES.some((re) => re.test(resultText))
  );
}

/** 信任卡推送文案（单一事实源，测试可断言） */
const NOTICE_TEXT =
  'agent 的沙箱命令因网络被拦截而失败——正在等待你裁定本任务是否允许访问网络（3 分钟内有效，超时按拒绝处理）';

interface WaitEntry {
  readonly promise: Promise<NetworkTrustOutcome>;
  readonly resolve: (o: NetworkTrustOutcome) => void;
  readonly timer: unknown;
}

/** spawn 时逐条求值的单点函数产物（spec §5 effectiveNetwork） */
export interface EffectiveNetwork {
  netOn: boolean;
  /** true = 解析为 ask 且无 session grant（命令失败命中签名后应走阻塞询问） */
  awaitingAsk: boolean;
}

export interface NetworkTrustGateDeps {
  readPolicy: () => NetworkPolicy;
  /** 「永久允许」持久化（settings kv → allow）；抛错不撤销会话级授权 */
  persistAlways: () => void;
  pushNotice: (n: NetworkTrustNotice) => void;
  clock?: TrustClock;
}

export class NetworkTrustGate {
  private readonly grants = new Map<string, NetworkGrantValue>();
  private readonly waiters = new Map<string, WaitEntry>();
  private readonly clock: TrustClock;

  constructor(private readonly deps: NetworkTrustGateDeps) {
    this.clock = deps.clock ?? defaultClock;
  }

  /** 测试专用：直接注入 grant（生产路径只经 answer / 超时产出） */
  __setGrantForTest(streamSessionId: string, value: NetworkGrantValue): void {
    this.grants.set(streamSessionId, value);
  }

  getGrant(streamSessionId: string): NetworkGrantValue | undefined {
    return this.grants.get(streamSessionId);
  }

  /** 任务终态清理（agent-runner 调用；幂等） */
  clearGrant(streamSessionId: string): void {
    this.grants.delete(streamSessionId);
  }

  /** 有效策略解析（spec §5 单点函数）：grants 优先，落空走 settings 三态 */
  effective(streamSessionId: string): EffectiveNetwork {
    const grant = this.grants.get(streamSessionId);
    if (grant === 'granted') return { netOn: true, awaitingAsk: false };
    if (grant === 'denied') return { netOn: false, awaitingAsk: false };
    const policy = this.deps.readPolicy();
    if (policy === 'allow') return { netOn: true, awaitingAsk: false };
    if (policy === 'deny') return { netOn: false, awaitingAsk: false };
    return { netOn: false, awaitingAsk: true };
  }

  /**
   * 阻塞询问（spec §5 协议）：ask 无 grant 时推卡挂起，直到三值应答 / 超时。
   *   - 快路径：等待期间授权已到 / 策略已翻转（决定与等待竞态）→ 直接返回现值
   *   - 单飞：同 streamSessionId 并发等待 join 同一 entry（只推一张卡）
   *   - 推卡必须先于挂起（否则 renderer 收不到卡、等待必然超时）；推卡抛错
   *     （IPC 故障）向上穿透且清 entry/timer——不留悬挂等待
   */
  async waitForTrust(streamSessionId: string): Promise<NetworkTrustOutcome> {
    const eff = this.effective(streamSessionId);
    if (!eff.awaitingAsk) return eff.netOn ? 'granted' : 'denied';
    const existing = this.waiters.get(streamSessionId);
    if (existing !== undefined) return existing.promise;

    let resolve!: (o: NetworkTrustOutcome) => void;
    const promise = new Promise<NetworkTrustOutcome>((res) => {
      resolve = res;
    });
    const timer = this.clock.setTimer(() => {
      // 超时 = 等效 deny（spec §5 协议 5）：置 denied + 唤醒全部挂起者；
      // pending 先清——迟到的 answer 对无 entry 是 no-op（协议 6）
      this.waiters.delete(streamSessionId);
      this.grants.set(streamSessionId, 'denied');
      resolve('denied');
    }, NETWORK_TRUST_TIMEOUT_MS);
    this.waiters.set(streamSessionId, { promise, resolve, timer });
    try {
      this.deps.pushNotice({
        kind: 'net-trust-request',
        text: NOTICE_TEXT,
        streamSessionId,
        createdAt: Date.now(),
      });
    } catch (err) {
      this.waiters.delete(streamSessionId);
      this.clock.clearTimer(timer);
      throw err;
    }
    return promise;
  }

  /**
   * 信任卡应答出口（sandbox:answerNetworkTrust IPC 入口）：
   *   - 迟到应答（无 pending waiter：已超时收敛 / 已应答过）整体 no-op——
   *     spec §5 协议 6「丢弃，不污染下一张卡」（与浏览器信任门语义不同：
   *     浏览器迟到点击为下一次调用授权，网络门严格丢弃）
   *   - session → grants=granted（任务结束即失效）
   *   - always → grants=granted + 持久化（本任务即刻生效 + 跨任务生效）
   *   - deny → grants=denied（本任务内不再询问；不持久化）
   */
  answer(streamSessionId: string, ans: NetworkTrustAnswer): void {
    const entry = this.waiters.get(streamSessionId);
    if (entry === undefined) return;
    this.waiters.delete(streamSessionId);
    this.clock.clearTimer(entry.timer);
    if (ans === 'deny') {
      this.grants.set(streamSessionId, 'denied');
      entry.resolve('denied');
      return;
    }
    this.grants.set(streamSessionId, 'granted');
    if (ans === 'always') {
      try {
        this.deps.persistAlways();
      } catch (err) {
        // 持久化失败不撤销会话级授权（本任务已放行；跨任务下次再问）
        logger.warn('网络信任门 always 持久化失败（会话级授权保留）', {
          streamSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    entry.resolve('granted');
  }
}

// ─── 模块级单例 + 接线（boot / registerSandboxIpc 注入真实依赖）───

let gate: NetworkTrustGate | null = null;

export function initNetworkTrustGate(deps: NetworkTrustGateDeps): void {
  gate = new NetworkTrustGate(deps);
}

export function getNetworkTrustGate(): NetworkTrustGate | null {
  return gate;
}

export function __resetNetworkTrustGateForTest(): void {
  gate = null;
}

/** agent-runner 任务终态清理入口：gate 未接线时 no-op——清理绝不阻断收尾链路 */
export function clearActiveNetworkGrant(streamSessionId: string): void {
  gate?.clearGrant(streamSessionId);
}

// ─── child IPC op 路由（net-trust-bridge 桥的主进程对端，镜像 browser/op-router）───

interface NetTrustOpMsg {
  type: 'net-trust-op';
  requestId: string;
  op: 'effective' | 'wait';
  streamSessionId: string;
  resultText?: string;
}

export type NetTrustOpResult =
  | { ok: true; payload: { netOn: boolean; awaitingAsk: boolean } }
  | { ok: true; payload: { outcome: NetworkTrustOutcome | 'not-triggered' } }
  | { ok: false; error: string };

function parseNetTrustOpMsg(msg: unknown): NetTrustOpMsg | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Partial<NetTrustOpMsg>;
  if (m.type !== 'net-trust-op') return null;
  if (typeof m.requestId !== 'string' || m.requestId === '') return null;
  if (m.op !== 'effective' && m.op !== 'wait') return null;
  if (typeof m.streamSessionId !== 'string' || m.streamSessionId === '') return null;
  if (m.op === 'wait' && typeof m.resultText !== 'string') return null;
  return m as NetTrustOpMsg;
}

/**
 * 子进程 op 统一路由（永不抛异常——失败统一 { ok:false, error } 序列化回子进程）：
 *   - effective：spawn 前有效策略查询（grants 在主进程内存，子进程不可见）
 *   - wait：命令完成后阻塞询问——触发条件三连（spec §5）：ask 无 grant +
 *     结果文本双条件（net-off tag + 网络拒绝签名，由 resultText 判定）
 */
export async function handleNetTrustOp(msg: unknown): Promise<NetTrustOpResult> {
  const g = getNetworkTrustGate();
  if (g === null) {
    return { ok: false, error: '网络信任门未初始化（主进程未接线：registerSandboxIpc 应先 initNetworkTrustGate）' };
  }
  const parsed = parseNetTrustOpMsg(msg);
  if (parsed === null) {
    return { ok: false, error: 'net-trust-op 载荷形状非法（需 type/requestId/op/streamSessionId[/resultText]）' };
  }
  if (parsed.op === 'effective') {
    return { ok: true, payload: g.effective(parsed.streamSessionId) };
  }
  const resultText = parsed.resultText ?? '';
  if (!detectNetworkBlocked(resultText)) {
    return { ok: true, payload: { outcome: 'not-triggered' } };
  }
  const eff = g.effective(parsed.streamSessionId);
  if (!eff.awaitingAsk) {
    return { ok: true, payload: { outcome: eff.netOn ? 'granted' : 'denied' } };
  }
  const outcome = await g.waitForTrust(parsed.streamSessionId);
  return { ok: true, payload: { outcome } };
}
