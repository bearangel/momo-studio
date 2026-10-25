// 被动应答（responder）与非关联 res 透出契约锁（M2c 镜像链目标/leader 两形态）：
//   1. req 信封（mirror.apply）→ onRequest 处理器 → 回**同 id** res 信封（mirror.receipt）
//   2. 处理器 ok=false → res.ok=false + RpcErrorPayload（+diffSummary 超集透传）
//   3. 处理器 reject → internal 错误 res（不留 hub 侧按 id 悬挂等待）
//   4. 未配置 onRequest → req 静默丢弃（不回执——hub 上层超时/断连兜底）
//   5. 非关联 res（mirror.result，id=mirrorId 非本端请求）→ onUnsolicitedRes 透出，
//      不污染 pending 关联器；随后同 id RPC 正常（关联器优先级锁）
//   6. 回执走当前在线连接；连接被取代后不回执（身份守卫——stale socket 回执无意义）
//   7. sendRes：本端主动上行 res 信封（task.report，id=taskId 对账键——M2e 委派）；
//      离线/停机返回 false 不抛（调用方缓冲重试），不入 pending 关联器
// ws 经工厂注入（client.test.ts 同款 FakeSocket/FakeServer）——信封编解码用真 protocol。
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createHubClient, type WsFactory, type WebSocketLike } from '../../src/main/hub/client';
import { PROTOCOL_VERSION, RPC, encodeEnvelope, parseEnvelope, type RequestEnvelope, type ResponseEnvelope } from '../../src/main/hub/protocol';
import { MIRROR_WIRE } from '../../src/main/hub/mirror-wire';
import { TASK_WIRE } from '../../src/main/hub/delegation-wire';

class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); this.emit('to-server', data); }
  close(): void { this.emit('close', 1000, Buffer.from('')); }
  terminate(): void { this.emit('close', 1006, Buffer.from('')); }
}

function makeFactory(): { factory: WsFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WsFactory = () => {
    const s = new FakeSocket();
    s.on('to-server', (raw: string) => {
      const env = JSON.parse(raw) as { kind: string; method: string; id: string };
      if (env.kind !== 'req' || env.method !== RPC.hello) return;
      const res = JSON.stringify({
        v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: true,
        payload: { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes: [] },
      });
      queueMicrotask(() => s.emit('message', res));
    });
    sockets.push(s);
    queueMicrotask(() => s.emit('open'));
    return s;
  };
  return { factory, sockets };
}

async function flushMicrotasks(): Promise<void> {
  // 真实时钟下的微任务排空（hello/回执均经微任务投递；无退避/心跳类计时器断言）
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** hub 定向投递一条信封到指定连接 */
function deliver(sock: FakeSocket, env: RequestEnvelope | ResponseEnvelope): void {
  queueMicrotask(() => sock.emit('message', encodeEnvelope(env)));
}

function mirrorApplyReq(id: string): RequestEnvelope {
  return {
    v: 1, kind: 'req', id, method: MIRROR_WIRE.apply,
    payload: { mirrorId: id, snapshotId: 'snap-1', workspaceName: 'prod-dev', strategy: 'replace' },
  };
}

/** 从连接上行帧中找 res 信封（按 id） */
function findRes(sock: FakeSocket, id: string): ResponseEnvelope | undefined {
  for (const raw of [...sock.sent].reverse()) {
    const env = parseEnvelope(raw);
    if (env && env.kind === 'res' && env.id === id) return env as ResponseEnvelope;
  }
  return undefined;
}

describe('HubClient 被动应答（responder）', () => {
  it('req（mirror.apply）→ onRequest → 回同 id res（mirror.receipt，载荷原样）', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onRequest: async (_req) => ({ ok: true, payload: { appliedResources: ['agent/coder'], unresolvedRefs: ['mcp:ghost'] } }),
    });
    client.start();
    await flushMicrotasks();
    deliver(sockets[0]!, mirrorApplyReq('mir-1'));
    await flushMicrotasks();

    const res = findRes(sockets[0]!, 'mir-1');
    expect(res).toBeDefined();
    expect(res!.method).toBe(MIRROR_WIRE.apply); // res.method 回写 req 方法名（hub 对账形态）
    expect(res!.ok).toBe(true);
    expect(res!.payload).toEqual({ appliedResources: ['agent/coder'], unresolvedRefs: ['mcp:ghost'] });
    client.stop();
  });

  it('处理器 ok=false → res.ok=false + RpcErrorPayload + diffSummary 超集透传', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onRequest: async () => ({
        ok: false,
        payload: { code: 'conflict', message: '目标已存在', diffSummary: { added: 1, removed: 2, changed: 3 } },
      }),
    });
    client.start();
    await flushMicrotasks();
    deliver(sockets[0]!, mirrorApplyReq('mir-2'));
    await flushMicrotasks();

    const res = findRes(sockets[0]!, 'mir-2');
    expect(res!.ok).toBe(false);
    expect(res!.payload).toEqual({
      code: 'conflict', message: '目标已存在', diffSummary: { added: 1, removed: 2, changed: 3 },
    });
    client.stop();
  });

  it('处理器 reject → internal 错误 res（不悬挂）', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onRequest: async () => { throw new Error('应用器爆炸'); },
    });
    client.start();
    await flushMicrotasks();
    deliver(sockets[0]!, mirrorApplyReq('mir-3'));
    await flushMicrotasks();

    const res = findRes(sockets[0]!, 'mir-3');
    expect(res!.ok).toBe(false);
    expect(res!.payload).toEqual({ code: 'internal', message: '节点处理失败: 应用器爆炸' });
    client.stop();
  });

  it('未配置 onRequest → req 静默丢弃（零回执）', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
    });
    client.start();
    await flushMicrotasks();
    const before = sockets[0]!.sent.length;
    deliver(sockets[0]!, mirrorApplyReq('mir-4'));
    await flushMicrotasks();
    expect(sockets[0]!.sent.length).toBe(before); // 无新增上行帧
    client.stop();
  });
});

describe('HubClient 非关联 res 透出（mirror.result）', () => {
  it('hub 定向 res → onUnsolicitedRes 透出；不污染 pending 关联器（后续 RPC 正常）', async () => {
    const { factory, sockets } = makeFactory();
    const unsolicited: ResponseEnvelope[] = [];
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
      onUnsolicitedRes: (res) => unsolicited.push(res),
    });
    client.start();
    await flushMicrotasks();

    deliver(sockets[0]!, {
      v: 1, kind: 'res', id: 'mir-9', method: MIRROR_WIRE.result, ok: true,
      payload: { mirrorId: 'mir-9', appliedResources: ['skill/x'] },
    });
    await flushMicrotasks();
    expect(unsolicited).toHaveLength(1);
    expect(unsolicited[0]!.method).toBe(MIRROR_WIRE.result);
    expect(unsolicited[0]!.payload).toEqual({ mirrorId: 'mir-9', appliedResources: ['skill/x'] });

    // pending 关联器不受影响：正常 RPC 请求-应答仍通
    const pong = client.request(RPC.ping, { ts: 1 }, 1000);
    await flushMicrotasks();
    const pingEnv = sockets[0]!.sent
      .map((r) => parseEnvelope(r))
      .find((e): e is RequestEnvelope => e !== null && e.kind === 'req' && e.method === RPC.ping);
    expect(pingEnv).toBeDefined();
    deliver(sockets[0]!, { v: 1, kind: 'res', id: pingEnv!.id, method: RPC.ping, ok: true, payload: { ts: 1, serverTime: 2 } });
    await expect(pong).resolves.toEqual({ ts: 1, serverTime: 2 });
    expect(unsolicited).toHaveLength(1); // ping 应答走关联器，不再进 unsolicited
    client.stop();
  });
});

describe('HubClient 主动上行 res（task.report——M2e 委派）', () => {
  it('online 时 sendRes → 当前连接上行 res 信封（id/method/payload 原样）；返 true', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
    });
    client.start();
    await flushMicrotasks();

    const sent = client.sendRes('task-1', TASK_WIRE.report, {
      status: 'running', sessionId: 'sess-1', progress: { lastSeq: 3, excerpt: '开始' },
    });
    expect(sent).toBe(true);
    const res = findRes(sockets[0]!, 'task-1');
    expect(res).toBeDefined();
    expect(res!.method).toBe(TASK_WIRE.report);
    expect(res!.ok).toBe(true);
    expect(res!.payload).toEqual({ status: 'running', sessionId: 'sess-1', progress: { lastSeq: 3, excerpt: '开始' } });
    client.stop();
  });

  it('未连接/停机 → sendRes 返 false 不抛（调用方缓冲重试）；重连后可再发', async () => {
    const { factory, sockets } = makeFactory();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'a', deviceToken: 't',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
    });
    // start 前（disconnected）
    expect(client.sendRes('task-1', TASK_WIRE.report, { status: 'running' })).toBe(false);

    client.start();
    await flushMicrotasks();
    client.stop();
    // 停机后（disconnected）
    expect(client.sendRes('task-1', TASK_WIRE.report, { status: 'running' })).toBe(false);
    expect(sockets[0]!.sent.some((r) => parseEnvelope(r)?.kind === 'res')).toBe(false);

    // 重连后恢复可用
    client.start();
    await flushMicrotasks();
    expect(client.sendRes('task-1', TASK_WIRE.report, { status: 'running' })).toBe(true);
    client.stop();
  });
});
