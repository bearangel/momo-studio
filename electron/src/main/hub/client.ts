// hub 连接层：状态机 + 指数退避重连 + 心跳判死 + enroll HTTP 客户端 + RPC 关联器。
// ws 经工厂注入（测试 fake / 生产 'ws'）；信封语义全部走 protocol 包（不自制 wire 格式）。
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, RPC, encodeEnvelope, makeRequest, parseEnvelope,
  type EventEnvelope, type ResponseEnvelope, type RpcErrorPayload,
} from './protocol';

export type HubConnectionState = 'disconnected' | 'connecting' | 'online';

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

export interface HubClientOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  onStateChange(state: HubConnectionState, lastError?: string): void;
  onEvent(evt: EventEnvelope): void;
  /**
   * hello 应答成功时的在线节点快照回调（OBS-1）——hub 自 M0 T6 起随 hello 应答
   * 下发 onlineNodes；缺失/非数组时回调空数组（恒为数组，消费面无需判空）。
   */
  onHelloSnapshot?: (nodes: Array<{ nodeId: string; nodeName: string }>) => void;
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
  /**
   * RPC 请求-响应关联器（M2 spec §3.1）：信封 id → pending 映射。
   * - res.ok=false → reject Error(RpcErrorPayload.message)（hub 端人话原文）
   * - 非 online → 直接 reject（不排队不发半途请求）
   * - 连接断开 / stop → 全部 pending reject「连接已重置」（不留悬挂 Promise）
   * - timeoutMs 超时 → reject（缺省 10s）
   */
  request<T = unknown>(method: string, payload: unknown, timeoutMs?: number): Promise<T>;
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
  // 当前连接私有计时器（hello 超时/心跳）的清理入口——stop 时立即掐断，不依赖 close 事件
  let clearCurrentTimers: (() => void) | null = null;
  // 待触发的重连计时器——stop 时清除（否则停机后仍会重连）
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempts = 0;
  let stopped = true;
  let lastError: string | undefined;
  // RPC 关联器待答表：请求信封 id → pending（跨连接存续；断开/停机时全部清偿）
  const pending = new Map<string, PendingEntry>();

  const rejectAllPending = (message: string): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  const setState = (s: HubConnectionState, err?: string): void => {
    state = s;
    opts.onStateChange(s, err);
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
      if (env.kind !== 'res') return;
      const res = env as ResponseEnvelope;
      // RPC 关联器优先按 id 清偿（hello/ping 的 id 从不入表，落到下方方法匹配）
      const entry = pending.get(res.id);
      if (entry) {
        pending.delete(res.id);
        clearTimeout(entry.timer);
        if (res.ok) entry.resolve(res.payload);
        else entry.reject(new Error((res.payload as RpcErrorPayload | null)?.message ?? `hub 拒绝: ${res.method}`));
        return;
      }
      if (res.method === RPC.hello) {
        if (!helloTimer) return; // 迟到响应（已进入重连）——忽略
        clearTimeout(helloTimer); helloTimer = null;
        if (res.ok) {
          attempts = 0;
          pongSincePing = true;
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
        // hello 被拒（如版本不匹配）——记错误 → 关闭被拒连接 → 按退避重连。
        // 顺序要紧：先摘除当前连接身份（sock = null），其后 hub 发来的 close 事件
        // 会被身份守卫拦下、不重复调度重连（否则一条被拒连接会连出两条新连接）。
        lastError = (res.payload as { message?: string } | null)?.message ?? 'hello 被拒';
        clearSocketTimers();
        if (clearCurrentTimers === clearSocketTimers) clearCurrentTimers = null;
        setState('connecting', lastError);
        sock = null;
        s.close();
        scheduleReconnect();
        return;
      }
      if (res.method === RPC.ping && res.ok) pongSincePing = true;
    });
    s.on('close', () => {
      // 身份守卫：过期连接（已被新连接取代）的 close 不清计时器、不改状态、不调度重连
      if (sock !== s) return;
      sock = null;
      if (clearCurrentTimers === clearSocketTimers) clearCurrentTimers = null;
      clearSocketTimers();
      // 本连接上的在途请求全部清偿——不留悬挂 Promise 等一个永不到来的 res
      rejectAllPending('hub 连接已重置，请求未完成，请重试');
      if (!stopped) { setState('connecting', lastError); scheduleReconnect(); }
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
      s?.close();
      rejectAllPending('hub 连接已停止，请求未完成');
      setState('disconnected');
    },
    state(): HubConnectionState { return state; },
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
