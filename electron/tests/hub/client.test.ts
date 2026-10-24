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
/** 单连接的 hello 脚本：应答内容 + hub 是否随后主动断开 */
interface HelloScript {
  /** hello 应答：true 放行 / false 拒绝（版本不匹配） */
  ok: boolean;
  /** 应答后 hub 主动断开该连接的延迟（ms）——真实 hub 4402；断开事件晚于客户端重连 */
  closeAfterMs?: number;
}

class FakeServer extends EventEmitter {
  sockets: FakeSocket[] = [];
  /** 每条连接的建立时刻（fake clock）——退避节奏断言用 */
  createdAt: number[] = [];
  /** 每条连接的握手请求头——hub 鉴权闸门读的就是它（Bearer deviceToken） */
  headers: Array<Record<string, string>> = [];
  /** 逐连接 hello 脚本——第 n 条连接用第 n 条（缺省走 replyHello 的统一行为） */
  helloScripts: HelloScript[] = [];
  /**
   * hello 成功应答的载荷覆盖（null = 默认载荷）。
   * 真实 hub 自 M0 T6 起随 hello 下发 onlineNodes 快照；置 null 可仿真字段缺失。
   */
  helloPayload: Record<string, unknown> | null = null;
  /** 回放 hello 应答；mutate 为 true 时回放失败应答 */
  replyHello(fail = false): void {
    this.on('to-server', (raw: string, sock: FakeSocket) => {
      const env = JSON.parse(raw) as { kind: string; method: string; id: string };
      if (env.kind !== 'req' || env.method !== RPC.hello) return;
      const script = this.helloScripts[this.sockets.indexOf(sock)];
      const ok = script ? script.ok : !fail;
      const payload = this.helloPayload
        ?? { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes: [] };
      const res = JSON.stringify(ok
        ? { v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: true, payload }
        : { v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: false, payload: { code: 'proto_version_mismatch', message: 'hub=2.0.0' } });
      // 回包经微任务投递——真实 hub 走网络往返，绝不在 send() 同栈内同步回包
      queueMicrotask(() => sock.emit('message', res));
      // hub 侧主动断开（真实 hub：版本不匹配即 socket.close(4402)）——断开事件可能晚于客户端重连
      if (script?.closeAfterMs !== undefined) {
        setTimeout(() => sock.emit('close', 4402, Buffer.from('proto_version_mismatch')), script.closeAfterMs);
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

  it('hello 被拒 + hub 关闭旧连接 → 恰好重连一次并最终 online', async () => {
    const { factory, server } = makeFactory();
    // 第一条连接：hello 被拒，hub 在 150ms 后才断开（真实 hub 4402——断开事件晚于客户端重连）；
    // 第二条连接起：hello 放行
    server.helloScripts = [
      { ok: false, closeAfterMs: 150 },
      { ok: true },
    ];
    server.replyHello();
    const states: string[] = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: (s) => states.push(s), onEvent: () => undefined, ws: factory,
      backoffBaseMs: 100, backoffMaxMs: 100,
    });
    client.start();
    await flushMicrotasks();                    // 第一条连接被拒 → 关闭 + 退避重连
    await vi.advanceTimersByTimeAsync(400);    // t100 第二条连接放行 → online；t150 旧连接的 close 到达
    await flushMicrotasks();
    expect(client.state()).toBe('online');
    // 恰好一次重连——旧连接迟到的 close 不得再调度一条（否则多出一条僵尸连接）
    expect(server.sockets.length).toBe(2);
    // online 之后不得回退 connecting（旧连接的 close 不得打断新连接）
    const onlineAt = states.indexOf('online');
    expect(onlineAt).toBeGreaterThanOrEqual(0);
    expect(states.slice(onlineAt)).not.toContain('connecting');
    client.stop();
  });
});

describe('HubClient hello 快照透出（OBS-1）', () => {
  it('hello 成功 → 回调 onHelloSnapshot 一次（payload.onlineNodes 原样透传）', async () => {
    const { factory, server } = makeFactory();
    const onlineNodes = [
      { nodeId: 'n2', nodeName: '客厅小主机' },
      { nodeId: 'n3', nodeName: '办公室 MacBook' },
    ];
    server.helloPayload = { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes };
    server.replyHello();
    const snapshots: Array<Array<{ nodeId: string; nodeName: string }>> = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onHelloSnapshot: (nodes) => snapshots.push(nodes),
    });
    client.start();
    await flushMicrotasks();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(onlineNodes);
    client.stop();
  });

  it('hello 被拒 → 不回调 onHelloSnapshot（快照只在成功分支透出）', async () => {
    const { factory, server } = makeFactory();
    server.replyHello(true);
    const snapshots: Array<Array<{ nodeId: string; nodeName: string }>> = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onHelloSnapshot: (nodes) => snapshots.push(nodes),
    });
    client.start();
    await flushMicrotasks();
    expect(snapshots).toHaveLength(0);
    client.stop();
  });

  it('hello 载荷缺 onlineNodes → 回调空数组（不抛，回调面恒为数组）', async () => {
    const { factory, server } = makeFactory();
    server.helloPayload = { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0 };
    server.replyHello();
    const snapshots: Array<Array<{ nodeId: string; nodeName: string }>> = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onHelloSnapshot: (nodes) => snapshots.push(nodes),
    });
    client.start();
    await flushMicrotasks();
    expect(snapshots).toEqual([[]]);
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

  it('invalid_name → 节点名非法（1-64 个字符）', async () => {
    const fetchJson = vi.fn().mockResolvedValueOnce({ error: 'invalid_name' });
    await expect(enrollOverHttp('http://h', 'tok', 'name', { fetchJson })).rejects.toThrow('节点名非法（1-64 个字符）');
  });

  it('响应缺字段 → hub 响应异常', async () => {
    const fetchJson = vi.fn().mockResolvedValueOnce({});
    await expect(enrollOverHttp('http://h', 'tok', 'name', { fetchJson })).rejects.toThrow('hub 响应异常');
  });
});
