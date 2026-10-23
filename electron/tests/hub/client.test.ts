// 连接层契约锁：状态机、退避序列、心跳判死重连、事件透传、enroll 错误映射。
// ws 经工厂注入（EventEmitter fake）——信封编解码用真 protocol（wire 语义不简化）。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubClient, enrollOverHttp, type WsFactory, type WebSocketLike } from '../../src/main/hub/client';
import { EVT, PROTOCOL_VERSION, RPC, encodeEnvelope, parseEnvelope, type EventEnvelope } from '../../src/main/hub/protocol';

class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); this.emit('to-server', data); }
  close(): void { this.emit('close', 1000, Buffer.from('')); }
  terminate(): void { this.emit('close', 1006, Buffer.from('')); }
}
class FakeServer extends EventEmitter {
  sockets: FakeSocket[] = [];
  /** 每条连接的建立时刻（fake clock）——退避节奏断言用 */
  createdAt: number[] = [];
  /** 每条连接的握手请求头——hub 鉴权闸门读的就是它（Bearer deviceToken） */
  headers: Array<Record<string, string>> = [];
  /** 回放 hello 应答；mutate 为 true 时回放失败应答 */
  replyHello(fail = false): void {
    this.on('to-server', (raw: string, sock: FakeSocket) => {
      const env = JSON.parse(raw) as { kind: string; method: string; id: string };
      if (env.kind === 'req' && env.method === RPC.hello) {
        const res = JSON.stringify(fail
          ? { v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: false, payload: { code: 'proto_version_mismatch', message: 'hub=2.0.0' } }
          : { v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: true, payload: { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes: [] } });
        // 回包经微任务投递——真实 hub 走网络往返，绝不在 send() 同栈内同步回包
        queueMicrotask(() => sock.emit('message', res));
      }
    });
  }
}

function makeFactory(): { factory: WsFactory; server: FakeServer } {
  const server = new FakeServer();
  const factory: WsFactory = (url: string, headers: Record<string, string>) => {
    const s = new FakeSocket();
    // 上行帧转发给服务端并带上 socket 本体——回包须定位到发起请求的那条连接
    // （同 hub 服务端「会话自持有连接」纪律：绝不按 nodeId 反查注册表）。
    s.on('to-server', (raw: string) => server.emit('to-server', raw, s));
    server.sockets.push(s);
    server.createdAt.push(Date.now());
    server.headers.push(headers);
    queueMicrotask(() => s.emit('open'));
    return s;
  };
  return { factory, server };
}

/**
 * 'open' 与服务端回包都经微任务投递——断言 'online' 前须排空微任务队列。
 * 用推进 0ms 的异步计时器实现（同步版 advanceTimersByTime 不让微任务跑）。
 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** 退避观测的推进步长（每 400ms 一拍） */
const BEAT_MS = 400;

/**
 * 分段推进 fake timers（每 400ms 一拍），记录每拍新增连接数。
 * 必须用 advanceTimersByTimeAsync：同步推进不让微任务跑——'open' 事件因此永不投递，
 * hello 超时计时器永不上膛 → 永不 terminate → 永不重连（退避序列无从观测）。
 */
async function advanceAndCount(
  server: FakeServer,
  totalMs: number,
): Promise<{ perBeat: number[]; createdAt: number[] }> {
  const perBeat: number[] = [];
  let prev = server.sockets.length;
  for (let elapsed = 0; elapsed < totalMs; elapsed += BEAT_MS) {
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    const now = server.sockets.length;
    perBeat.push(now - prev);
    prev = now;
  }
  return { perBeat, createdAt: server.createdAt };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HubClient 状态机', () => {
  it('start → connecting → online；stop → disconnected', async () => {
    const { factory, server } = makeFactory();
    server.replyHello();
    const states: string[] = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: (s) => states.push(s), onEvent: () => undefined, ws: factory,
    });
    client.start();
    expect(states).toEqual(['connecting']);
    await flushMicrotasks();
    expect(states).toEqual(['connecting', 'online']);
    // 握手契约：hub 鉴权闸门读 authorization 头，缺失即 4401 拒连
    expect(server.headers[0]).toEqual({ authorization: 'Bearer t' });
    // 首帧必须是 hello 请求信封（真 protocol 解析——形状即契约）
    const hello = parseEnvelope(server.sockets[0]!.sent[0]!);
    expect(hello?.kind).toBe('req');
    expect(hello?.method).toBe(RPC.hello);
    expect(hello?.payload).toEqual({ protoVer: PROTOCOL_VERSION, nodeName: 'a' });
    client.stop();
    expect(client.state()).toBe('disconnected');
  });

  it('退避序列 1s/2s/4s…封顶 30s（注入 base=100/max=400 观察 factory 调用节奏）', async () => {
    const { factory, server } = makeFactory(); // 不回 hello → hello 超时 → 重连
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      helloTimeoutMs: 100, backoffBaseMs: 100, backoffMaxMs: 400,
    });
    client.start();
    const { perBeat, createdAt } = await advanceAndCount(server, 60_000);
    // 数量下界：60s 内重连 ≥ 10 次
    expect(server.sockets.length).toBeGreaterThanOrEqual(10);
    // 相邻连接的间隔 = hello 超时(100) + 退避时长 → 退避序列 100/200/400…封顶 400
    const gaps = createdAt.slice(1).map((t, i) => t - (createdAt[i] as number));
    expect(gaps[0]).toBe(200); // 100 超时 + 100 退避
    expect(gaps[1]).toBe(300); // 100 超时 + 200 退避
    expect(gaps[2]).toBe(500); // 100 超时 + 400 退避（封顶）
    // 封顶后间隔恒定——不再指数增长（封顶断言）
    expect(gaps.slice(3).every((g) => g === 500)).toBe(true);
    // 每拍至多一次新连接（封顶后不再更快）
    expect(Math.max(...perBeat)).toBeLessThanOrEqual(1);
    client.stop();
  });
});

describe('HubClient 心跳与事件', () => {
  it('心跳无 pong → terminate 重连（connecting 再现）', async () => {
    const { factory, server } = makeFactory();
    server.replyHello(); // 只回 hello，不回 ping
    const states: string[] = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: (s) => states.push(s), onEvent: () => undefined, ws: factory,
    });
    client.start();
    await flushMicrotasks();
    expect(client.state()).toBe('online');
    vi.advanceTimersByTime(25_000 + 25_000); // 第一拍发 ping、第二拍无 res → terminate
    expect(states.filter((s) => s === 'connecting').length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it('node.online 事件透传到 onEvent', () => {
    const { factory, server } = makeFactory();
    server.replyHello();
    const got: EventEnvelope[] = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: (e) => got.push(e), ws: factory,
    });
    client.start();
    server.sockets[0]!.emit('message', encodeEnvelope({ v: 1, kind: 'evt', method: EVT.nodeOnline, payload: { nodeId: 'n2', nodeName: 'b', at: 1 } }));
    expect(got.map((e) => e.method)).toEqual([EVT.nodeOnline]);
    client.stop();
  });

  it('hello 被拒（版本不匹配）→ 记错误并按退避重连', async () => {
    const { factory, server } = makeFactory();
    server.replyHello(true);
    const errors: Array<string | undefined> = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: (_s, err) => errors.push(err), onEvent: () => undefined, ws: factory,
      backoffBaseMs: 100,
    });
    client.start();
    await flushMicrotasks();
    expect(errors.some((e) => e?.includes('hub=2.0.0'))).toBe(true);
    client.stop();
  });
});

describe('enrollOverHttp', () => {
  it('invalid_enrollment → 人话错误；成功返回凭证；网络失败 → 无法连接 hub', async () => {
    const fetchJson = vi.fn()
      .mockResolvedValueOnce({ error: 'invalid_enrollment' })
      .mockResolvedValueOnce({ nodeId: 'n1', deviceToken: 'dt' })
      .mockRejectedValueOnce(new Error('boom'));
    await expect(enrollOverHttp('http://h', 'tok', 'name', { fetchJson })).rejects.toThrow('加入凭证无效');
    await expect(enrollOverHttp('http://h', 'tok', 'name', { fetchJson })).resolves.toEqual({ nodeId: 'n1', deviceToken: 'dt' });
    await expect(enrollOverHttp('http://h', 'tok', 'name', { fetchJson })).rejects.toThrow('无法连接 hub');
  });
});
