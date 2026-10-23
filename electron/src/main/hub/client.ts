// hub 连接层：状态机 + 指数退避重连 + 心跳判死 + enroll HTTP 客户端。
// ws 经工厂注入（测试 fake / 生产 'ws'）；信封语义全部走 protocol 包（不自制 wire 格式）。
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, RPC, encodeEnvelope, makeRequest, parseEnvelope,
  type EventEnvelope, type ResponseEnvelope,
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
  ws?: WsFactory;
  helloTimeoutMs?: number; // 默认 5000
  heartbeatMs?: number;    // 默认 25000（发 ping；下一拍无 res 即判死重连）
  backoffBaseMs?: number;  // 默认 1000
  backoffMaxMs?: number;   // 默认 30000
}

export interface HubClient { start(): void; stop(): void; state(): HubConnectionState }

export function createHubClient(opts: HubClientOpts): HubClient {
  const wsFactory = opts.ws ?? defaultWsFactory;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const base = opts.backoffBaseMs ?? 1000;
  const max = opts.backoffMaxMs ?? 30_000;

  let state: HubConnectionState = 'disconnected';
  let sock: WebSocketLike | null = null;
  let attempts = 0;
  let stopped = true;
  let helloTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let pongSincePing = true;
  let lastError: string | undefined;

  const setState = (s: HubConnectionState, err?: string): void => {
    state = s;
    opts.onStateChange(s, err);
  };

  const clearTimers = (): void => {
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const delay = Math.min(base * 2 ** attempts, max);
    attempts += 1;
    setTimeout(() => connect(), delay);
  };

  const connect = (): void => {
    if (stopped) return;
    setState('connecting');
    const s = wsFactory(opts.url, { authorization: `Bearer ${opts.deviceToken}` });
    sock = s;
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
      if (res.method === RPC.hello) {
        if (!helloTimer) return; // 迟到响应（已进入重连）——忽略
        clearTimeout(helloTimer); helloTimer = null;
        if (res.ok) {
          attempts = 0;
          pongSincePing = true;
          setState('online');
          heartbeatTimer = setInterval(() => {
            if (!pongSincePing) { s.terminate(); return; }
            pongSincePing = false;
            s.send(encodeEnvelope(makeRequest(RPC.ping, { ts: Date.now() })));
          }, heartbeatMs);
          return;
        }
        // hello 被拒（如版本不匹配）——记错误并按退避重连（hub 可能刚升级）
        lastError = (res.payload as { message?: string } | null)?.message ?? 'hello 被拒';
        clearTimers();
        setState('connecting', lastError);
        scheduleReconnect();
        return;
      }
      if (res.method === RPC.ping && res.ok) pongSincePing = true;
    });
    s.on('close', () => {
      clearTimers();
      if (sock === s) sock = null;
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
      clearTimers();
      sock?.close();
      sock = null;
      setState('disconnected');
    },
    state(): HubConnectionState { return state; },
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
