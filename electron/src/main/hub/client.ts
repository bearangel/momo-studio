// hub 连接层：状态机 + 指数退避重连 + 心跳判死 + enroll HTTP 客户端 + RPC 关联器。
// ws 经工厂注入（测试 fake / 生产 'ws'）；信封语义全部走 protocol 包（不自制 wire 格式）。
// M2c 起 node 侧兼作**被动应答方**：收 hub 定向投递的 req 信封（mirror.apply 等）
// → onRequest 处理器 → 回同 id res 信封（mirror.receipt）；hub 主动下发的 res
// 信封（mirror.result 两段式第二段）经 onUnsolicitedRes 透出（不入 pending 关联器）。
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, RPC, encodeEnvelope, makeRequest, parseEnvelope,
  type EventEnvelope, type RequestEnvelope, type ResponseEnvelope, type RpcErrorPayload,
} from './protocol';

export type HubConnectionState = 'disconnected' | 'connecting' | 'online';

/**
 * hello 改名撞名（M5.0 §5）人话：hub hello 拒绝（res code name_conflict）与
 * 专用关码 close 4404 两路共用——「该名称已被其他节点使用」。落 lastError
 * 由设置面板直读展示。
 */
const NAME_CONFLICT_MESSAGE = '该名称已被其他节点使用';
/** hub hello 拒绝后的专用关码（hub §5——proto_version_mismatch 的 44xx 关码族同款） */
const CLOSE_CODE_NAME_CONFLICT = 4404;

/**
 * hub 拒绝的 RPC 应答错误（M3.0-P2）：在 Error 之上携带协议错误码（code），
 * message 逐字保留 hub 人话原文（既有消费方读 message 的行为零变化）。
 * code 取自 RpcErrorPayload.code；载荷异形（无非字符串 code）时兜底 'internal'。
 */
export class RpcRemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcRemoteError';
    this.code = code;
  }
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const defaultWsFactory: WsFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike;

/** 被动应答结果形态：ok=false 时 payload 必须是 RpcErrorPayload（hub 人话透传纪律）。 */
export type HubResponderResult = { ok: true; payload: unknown } | { ok: false; payload: RpcErrorPayload };

/**
 * hub 定向 req 信封处理器（node 侧被动应答——M2 mirror.apply 链）。
 * 处理器抛错 → 回 internal 错误 res（不留 hub 侧悬挂按 id 等待的 pending）。
 */
export type HubRequestHandler = (req: RequestEnvelope) => Promise<HubResponderResult>;

export interface HubClientOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  /**
   * 状态迁移回调。err/errCode 只在产生错误的迁移上携带（如 hello 被拒）；
   * 无错误的迁移两者均为 undefined——消费方据此保留上一条错误（与既有
   * lastError 语义一致，online 清零由 HubManager 层负责）。
   * errCode 为 hub RpcErrorPayload.code（M3.0-P2 传播，如 proto_version_mismatch）。
   */
  onStateChange(state: HubConnectionState, lastError?: string, lastErrorCode?: string): void;
  onEvent(evt: EventEnvelope): void;
  /**
   * hello 应答成功时的在线节点快照回调（OBS-1）——hub 自 M0 T6 起随 hello 应答
   * 下发 onlineNodes；缺失/非数组时回调空数组（恒为数组，消费面无需判空）。
   */
  onHelloSnapshot?: (nodes: Array<{ nodeId: string; nodeName: string }>) => void;
  /** 被动应答器：收 hub 定向 req（mirror.apply）→ 处理 → 回同 id res（mirror.receipt）。
   *  未配置时收 req 静默丢弃（hub 侧上层超时/断连兜底结算）。 */
  onRequest?: HubRequestHandler;
  /** 非本端发起的 res 信封回调（hub 主动定向下发——mirror.result 两段式第二段）。
   *  不入 pending 关联器（id 对不上本端请求），未配置时静默忽略。 */
  onUnsolicitedRes?: (res: ResponseEnvelope) => void;
  ws?: WsFactory;
  helloTimeoutMs?: number; // 默认 5000
  heartbeatMs?: number;    // 默认 25000（发 ping；下一拍无 res 即判死重连）
  backoffBaseMs?: number;  // 默认 1000
  backoffMaxMs?: number;   // 默认 30000
}

/** hello 应答载荷里的 onlineNodes 快照——原样透传；非数组（字段缺失/异形）归一为空数组。 */
function readOnlineNodes(payload: unknown): Array<{ nodeId: string; nodeName: string }> {
  const raw = (payload as { onlineNodes?: unknown } | null | undefined)?.onlineNodes;
  if (!Array.isArray(raw)) return [];
  return raw as Array<{ nodeId: string; nodeName: string }>;
}

export interface HubClient {
  start(): void;
  stop(): void;
  state(): HubConnectionState;
  /** 当前连接协商到的 hub 协议版本（hello 应答 protoVer——M3.0-P2）；未连接为 null */
  hubProtoVer(): string | null;
  /**
   * RPC 请求-响应关联器（M2 spec §3.1）：信封 id → pending 映射。
   * - res.ok=false → reject RpcRemoteError（message=hub 端人话原文，code=协议错误码）
   * - 非 online → 直接 reject（不排队不发半途请求）
   * - 连接断开 / stop → 全部 pending reject「连接已重置」（不留悬挂 Promise）
   * - timeoutMs 超时 → reject（缺省 10s）
   */
  request<T = unknown>(method: string, payload: unknown, timeoutMs?: number): Promise<T>;
  /**
   * 本端主动上行 res 信封（M2e 委派 task.report——id=taskId 对账键）。
   * 走当前在线连接；离线/停机返回 false 不抛（调用方缓冲重试），不入 pending
   * 关联器（hub 侧对 report 无应答）。send 抛错按 false 处理（连接将进重连）。
   */
  sendRes(id: string, method: string, payload: unknown): boolean;
}

interface PendingEntry {
  resolve(payload: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export function createHubClient(opts: HubClientOpts): HubClient {
  const wsFactory = opts.ws ?? defaultWsFactory;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const base = opts.backoffBaseMs ?? 1000;
  const max = opts.backoffMaxMs ?? 30_000;

  let state: HubConnectionState = 'disconnected';
  // 当前连接（身份守卫基准）——过期连接（已被新连接取代）的 close 一律不碰状态/计时器/重连
  let sock: WebSocketLike | null = null;
  // 当前连接协商到的 hub 协议版本（hello 应答 protoVer——M3.0-P2 版本管道）。
  // 仅 online 期间有值；断开/停机/异形应答一律回 null（未连接即未知）
  let hubProtoVer: string | null = null;
  // 当前连接私有计时器（hello 超时/心跳）的清理入口——stop 时立即掐断，不依赖 close 事件
  let clearCurrentTimers: (() => void) | null = null;
  // 待触发的重连计时器——stop 时清除（否则停机后仍会重连）
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempts = 0;
  let stopped = true;
  let lastError: string | undefined;
  // 最近一次 hello 被拒的协议错误码（如 proto_version_mismatch）——与 lastError 同生命周期
  // （无错误的迁移不携带，online 由上层清零）；重连 close 时与 lastError 一同重放
  let lastErrorCode: string | undefined;
  // RPC 关联器待答表：请求信封 id → pending（跨连接存续；断开/停机时全部清偿）
  const pending = new Map<string, PendingEntry>();

  const rejectAllPending = (message: string): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  /**
   * 被动应答分发（req 信封 → onRequest 处理器 → 同 id res 信封）。
   * 身份守卫：连接被取代/停机后不回执（stale socket 的回执对 hub 无意义，
   * hub 侧断连清理按 pending 结算——T6 语义）。
   */
  const dispatchRequest = (req: RequestEnvelope, s: WebSocketLike): void => {
    const handler = opts.onRequest;
    if (!handler) return; // 无应答器——静默丢弃（hub 上层超时兜底）
    void handler(req)
      .then((r) => {
        if (stopped || sock !== s) return;
        s.send(encodeEnvelope({ v: 1, kind: 'res', id: req.id, method: req.method, ok: r.ok, payload: r.payload }));
      })
      .catch((err) => {
        if (stopped || sock !== s) return;
        s.send(encodeEnvelope({
          v: 1, kind: 'res', id: req.id, method: req.method, ok: false,
          payload: { code: 'internal', message: `节点处理失败: ${err instanceof Error ? err.message : String(err)}` } satisfies RpcErrorPayload,
        }));
      });
  };

  const setState = (s: HubConnectionState, err?: string, errCode?: string): void => {
    state = s;
    opts.onStateChange(s, err, errCode);
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const delay = Math.min(base * 2 ** attempts, max);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    setState('connecting');
    const s = wsFactory(opts.url, { authorization: `Bearer ${opts.deviceToken}` });
    sock = s;

    // 本连接私有的计时器与心跳标记——绝不跨连接共享：
    // 旧连接的 close 不得清掉新连接的 hello 超时/心跳（否则新连接成僵尸连接）。
    let helloTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let pongSincePing = true;

    const clearSocketTimers = (): void => {
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };
    clearCurrentTimers = clearSocketTimers;

    s.on('error', (err) => { lastError = err.message; });
    s.on('open', () => {
      s.send(encodeEnvelope(makeRequest(RPC.hello, { protoVer: PROTOCOL_VERSION, nodeName: opts.nodeName })));
      helloTimer = setTimeout(() => s.terminate(), helloTimeoutMs);
    });
    s.on('message', (raw) => {
      const env = parseEnvelope(typeof raw === 'string' ? raw : String(raw));
      if (!env) return;
      if (env.kind === 'evt') { opts.onEvent(env); return; }
      if (env.kind === 'req') { dispatchRequest(env, s); return; }
      if (env.kind !== 'res') return;
      const res = env as ResponseEnvelope;
      // RPC 关联器优先按 id 清偿（hello/ping 的 id 从不入表，落到下方方法匹配）
      const entry = pending.get(res.id);
      if (entry) {
        pending.delete(res.id);
        clearTimeout(entry.timer);
        if (res.ok) entry.resolve(res.payload);
        // code 随错误类型保留（M3.0-P2）——message 逐字沿用既有文案（零行为变化）
        else {
          const errPayload = res.payload as RpcErrorPayload | null;
          entry.reject(new RpcRemoteError(
            typeof errPayload?.code === 'string' ? errPayload.code : 'internal',
            errPayload?.message ?? `hub 拒绝: ${res.method}`,
          ));
        }
        return;
      }
      if (res.method === RPC.hello) {
        if (!helloTimer) return; // 迟到响应（已进入重连）——忽略
        clearTimeout(helloTimer); helloTimer = null;
        if (res.ok) {
          attempts = 0;
          pongSincePing = true;
          // 版本管道（M3.0-P2）：hello 应答 protoVer 先落连接态再广播 online——
          // 上层在 onStateChange 回调内读 hubProtoVer() 即见本次协商结果
          const ver = (res.payload as { protoVer?: unknown } | null)?.protoVer;
          hubProtoVer = typeof ver === 'string' ? ver : null;
          setState('online');
          // hello 成功 → 透出在线节点快照（OBS-1：hub 已下发，client 不得丢弃）
          opts.onHelloSnapshot?.(readOnlineNodes(res.payload));
          heartbeatTimer = setInterval(() => {
            if (!pongSincePing) { s.terminate(); return; }
            pongSincePing = false;
            s.send(encodeEnvelope(makeRequest(RPC.ping, { ts: Date.now() })));
          }, heartbeatMs);
          return;
        }
        // hello 被拒（如版本不匹配）——记错误与协议错误码 → 关闭被拒连接 → 按退避重连。
        // 顺序要紧：先摘除当前连接身份（sock = null），其后 hub 发来的 close 事件
        // 会被身份守卫拦下、不重复调度重连（否则一条被拒连接会连出两条新连接）。
        // name_conflict（M5.0 改名撞名）：hub 原文人话不可读，本地覆写单源文案。
        const rejectPayload = res.payload as { message?: unknown; code?: unknown } | null;
        lastErrorCode = typeof rejectPayload?.code === 'string' ? rejectPayload.code : undefined;
        lastError = lastErrorCode === 'name_conflict'
          ? NAME_CONFLICT_MESSAGE
          : (typeof rejectPayload?.message === 'string' ? rejectPayload.message : undefined) ?? 'hello 被拒';
        clearSocketTimers();
        if (clearCurrentTimers === clearSocketTimers) clearCurrentTimers = null;
        setState('connecting', lastError, lastErrorCode);
        sock = null;
        s.close();
        scheduleReconnect();
        return;
      }
      if (res.method === RPC.ping && res.ok) { pongSincePing = true; return; }
      // 非本端发起的 res（mirror.result 两段式第二段，id=mirrorId）——透出给消费面
      opts.onUnsolicitedRes?.(res);
    });
    s.on('close', (code) => {
      // 身份守卫：过期连接（已被新连接取代）的 close 不清计时器、不改状态、不调度重连
      if (sock !== s) return;
      sock = null;
      // 4404 专用关码（M5.0 改名撞名——hub 可能未及/无需结构化 res 即关连接）：
      // 与 hello res name_conflict 同文案；res 先到时两路幂等（同文案同 code）。
      if (code === CLOSE_CODE_NAME_CONFLICT) {
        lastError = NAME_CONFLICT_MESSAGE;
        lastErrorCode = 'name_conflict';
      }
      // 断开 → 协商版本作废（M3.0-P2：未连接即未知，先清再广播）
      hubProtoVer = null;
      if (clearCurrentTimers === clearSocketTimers) clearCurrentTimers = null;
      clearSocketTimers();
      // 本连接上的在途请求全部清偿——不留悬挂 Promise 等一个永不到来的 res
      rejectAllPending('hub 连接已重置，请求未完成，请重试');
      if (!stopped) { setState('connecting', lastError, lastErrorCode); scheduleReconnect(); }
    });
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      connect();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearCurrentTimers?.();
      clearCurrentTimers = null;
      const s = sock;
      sock = null;
      hubProtoVer = null;
      s?.close();
      rejectAllPending('hub 连接已停止，请求未完成');
      setState('disconnected');
    },
    state(): HubConnectionState { return state; },
    hubProtoVer(): string | null { return hubProtoVer; },
    request<T = unknown>(method: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (stopped || state !== 'online' || !sock) {
          reject(new Error('hub 未连接，请稍后重试'));
          return;
        }
        const env = makeRequest(method, payload);
        const timer = setTimeout(() => {
          pending.delete(env.id);
          reject(new Error(`请求超时：${method}`));
        }, timeoutMs);
        pending.set(env.id, {
          resolve: (p): void => resolve(p as T),
          reject,
          timer,
        });
        try {
          sock.send(encodeEnvelope(env));
        } catch (err) {
          pending.delete(env.id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('发送失败'));
        }
      });
    },
    sendRes(id: string, method: string, payload: unknown): boolean {
      if (stopped || state !== 'online' || !sock) return false;
      try {
        sock.send(encodeEnvelope({ v: 1, kind: 'res', id, method, ok: true, payload }));
        return true;
      } catch {
        return false; // 连接半关（send 同步抛）——上层缓冲待重连
      }
    },
  };
}

export interface EnrollDeps {
  fetchJson(url: string, init: { method: string; body: string }): Promise<unknown>;
}

/** 首次接入：HTTP POST /enroll 换 device token。错误映射为人话（UI 直接展示）。 */
export async function enrollOverHttp(
  hubUrl: string, enrollmentToken: string, nodeName: string, deps?: EnrollDeps,
): Promise<{ nodeId: string; deviceToken: string }> {
  const fetchJson = deps?.fetchJson ?? (async (url, init) => {
    const res = await fetch(url, {
      method: init.method, body: init.body, headers: { 'content-type': 'application/json' },
    });
    return (await res.json().catch(() => ({ error: 'network' }))) as unknown;
  });
  let body: unknown;
  try {
    body = await fetchJson(`${hubUrl.replace(/\/$/, '')}/enroll`, {
      method: 'POST',
      body: JSON.stringify({ enrollmentToken, nodeName }),
    });
  } catch {
    throw new Error('无法连接 hub');
  }
  const r = body as { nodeId?: string; deviceToken?: string; error?: string };
  if (r.error === 'invalid_enrollment') throw new Error('加入凭证无效');
  if (r.error === 'invalid_name') throw new Error('节点名非法（1-64 个字符）');
  if (typeof r.nodeId !== 'string' || typeof r.deviceToken !== 'string') throw new Error('hub 响应异常');
  return { nodeId: r.nodeId, deviceToken: r.deviceToken };
}
