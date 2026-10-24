// 工作组客户端契约锁（M2b T4）——RM2-4：mock 仿真鉴权 + 角色。
// mock 边界只收窄在 hub 侧（FakeGroupHub 仿真：Bearer 鉴权识别节点身份、组引擎
// 判 leader/成员、邀请码撤销语义），客户端链路全真实：createGroupClient →
// createHubClient.request 关联器 → 真 protocol 信封 → ws 工厂。
// 组矩阵与 hub 仓 groups.test.ts 语义对齐（wire 层同一契约的双端互锁）。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupClient } from '../../src/main/hub/groups';
import { createHubClient, type HubClient, type WsFactory, type WebSocketLike } from '../../src/main/hub/client';
import { EVT, PROTOCOL_VERSION, RPC, type EventEnvelope } from '../../src/main/hub/protocol';

class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  constructor(readonly token: string) {
    super();
  }
  send(data: string): void { this.sent.push(data); this.emit('to-server', data); }
  close(): void { this.emit('close', 1000, Buffer.from('')); }
  terminate(): void { this.emit('close', 1006, Buffer.from('')); }
}

interface GroupState {
  name: string;
  leader: string;
  members: Set<string>;
  /** 有效（未撤销）邀请码 */
  code: string | null;
}

/** 仿真 hub 组引擎：鉴权（token→nodeId）+ 角色（leader/成员）+ 邀请码撤销。 */
class FakeGroupHub extends EventEmitter {
  groups = new Map<string, GroupState>();
  events: EventEnvelope[] = [];
  private seq = 0;
  private names = new Map<string, string>();

  constructor(readonly creds: Map<string, string>) {
    super(); // creds: deviceToken → nodeId
  }

  registerNode(nodeId: string, name: string, token: string): void {
    this.creds.set(token, nodeId);
    this.names.set(nodeId, name);
  }

  /** socket 身份解析：升级头 Bearer token 查 creds（仿真 /ws 鉴权闸门） */
  nodeIdOf(sock: FakeSocket): string | null {
    return this.creds.get(sock.token) ?? null;
  }

  private broadcast(groupId: string, kind: 'joined' | 'left' | 'leaderChanged', nodeId: string): void {
    const evt: EventEnvelope = { v: 1, kind: 'evt', method: EVT.groupChanged, payload: { groupId, kind, nodeId } };
    this.events.push(evt);
  }

  /** 组 RPC 处理（语义与 hub 仓 packages/hub/src/groups.ts 对齐） */
  handle(nodeId: string, method: string, payload: Record<string, unknown>): { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } } {
    const res = (ok: true, payload: unknown) => ({ ok, payload } as const);
    const err = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
    switch (method) {
      case RPC.group.create: {
        const name = payload.groupName;
        if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64) {
          return err('bad_request', '组名非法（1-64 个字符）');
        }
        const groupId = `grp-${++this.seq}`;
        this.groups.set(groupId, { name: name.trim(), leader: nodeId, members: new Set([nodeId]), code: null });
        this.broadcast(groupId, 'joined', nodeId);
        return res(true, { groupId, nodeId });
      }
      case RPC.group.list: {
        const groups = [...this.groups.entries()]
          .filter(([, g]) => g.members.has(nodeId))
          .map(([groupId, g]) => ({
            groupId,
            groupName: g.name,
            leaderNodeId: g.leader,
            members: [...g.members].map((m) => ({ nodeId: m, name: this.names.get(m) ?? m, online: true })),
          }));
        return res(true, { groups });
      }
      case RPC.group.invite: {
        const g = this.groups.get(String(payload.groupId));
        if (!g) return err('not_found', '工作组不存在');
        if (!g.members.has(nodeId)) return err('forbidden', '仅本组成员可生成邀请码');
        g.code = `code-${++this.seq}`;
        return res(true, { inviteCode: g.code });
      }
      case RPC.group.join: {
        for (const [groupId, g] of this.groups) {
          if (g.code === payload.inviteCode) {
            if (g.members.has(nodeId)) return res(true, { groupId });
            g.members.add(nodeId);
            this.broadcast(groupId, 'joined', nodeId);
            return res(true, { groupId });
          }
        }
        return err('not_found', '邀请码无效或已被撤销');
      }
      case RPC.group.leave: {
        const g = this.groups.get(String(payload.groupId));
        if (!g) return err('not_found', '工作组不存在');
        if (!g.members.has(nodeId)) return err('forbidden', '仅本组成员可退组');
        if (g.leader === nodeId) return err('forbidden', '组长需先转移组长身份再退组');
        g.members.delete(nodeId);
        this.broadcast(String(payload.groupId), 'left', nodeId);
        return res(true, { ok: true });
      }
      case RPC.group.transfer: {
        const g = this.groups.get(String(payload.groupId));
        if (!g) return err('not_found', '工作组不存在');
        if (g.leader !== nodeId) return err('forbidden', '仅组长（leader）可执行该操作');
        if (!g.members.has(String(payload.toNodeId))) return err('forbidden', '目标节点不是本组成员');
        if (payload.toNodeId === nodeId) return res(true, { ok: true });
        g.leader = String(payload.toNodeId);
        this.broadcast(String(payload.groupId), 'leaderChanged', String(payload.toNodeId));
        return res(true, { ok: true });
      }
      default:
        return err('unknown_method', method);
    }
  }
}

function makeHub() {
  const hub = new FakeGroupHub(new Map());
  const sockets: FakeSocket[] = [];
  const factory: WsFactory = (url: string, headers: Record<string, string>) => {
    const token = headers.authorization?.slice('Bearer '.length) ?? '';
    const sock = new FakeSocket(token);
    sock.on('to-server', (raw: string) => hub.emit('to-server', raw, sock));
    sockets.push(sock);
    queueMicrotask(() => sock.emit('open'));
    return sock;
  };
  hub.on('to-server', (raw: string, sock: FakeSocket) => {
    const env = JSON.parse(raw) as { kind: string; method: string; id: string; payload: unknown };
    if (env.kind !== 'req') return;
    if (env.method === RPC.hello) {
      queueMicrotask(() => sock.emit('message', JSON.stringify({
        v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: true,
        payload: { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes: [] },
      })));
      return;
    }
    // 鉴权闸门：未注册 token 的连接一切组 RPC 拒 unauthorized（仿真 /ws 升级校验）
    const nodeId = hub.nodeIdOf(sock);
    const out = nodeId === null
      ? { ok: false as const, error: { code: 'unauthorized', message: '凭证无效' } }
      : hub.handle(nodeId, env.method, (env.payload ?? {}) as Record<string, unknown>);
    queueMicrotask(() => sock.emit('message', JSON.stringify(
      out.ok
        ? { v: 1, kind: 'res', id: env.id, method: env.method, ok: true, payload: out.payload }
        : { v: 1, kind: 'res', id: env.id, method: env.method, ok: false, payload: out.error },
    )));
  });
  return { hub, factory, sockets };
}

/** 仿真接入：注册节点身份 + 建 client + 过 hello + 组客户端绑定。 */
async function enrollClient(hub: FakeGroupHub, factory: WsFactory, nodeId: string, name: string): Promise<{ client: HubClient; groups: ReturnType<typeof createGroupClient> }> {
  const token = `tok-${nodeId}`;
  hub.registerNode(nodeId, name, token);
  const events: EventEnvelope[] = [];
  const client = createHubClient({
    url: 'ws://x/ws', nodeName: name, deviceToken: token,
    onStateChange: () => undefined,
    onEvent: (e) => events.push(e),
    ws: factory,
  });
  client.start();
  await vi.advanceTimersByTimeAsync(0); // 排干 hello 微任务
  const groups = createGroupClient((method, payload, timeoutMs) => client.request(method, payload, timeoutMs));
  return { client, groups };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('工作组客户端（mock hub 仿真鉴权+角色）', () => {
  it('创建→生成码→凭码入组→列表（成员+leaderNodeId）；事件 onEvent 收 group.changed', async () => {
    const { hub, factory } = makeHub();
    const a = await enrollClient(hub, factory, 'node-a', '办公室 MacBook');
    const b = await enrollClient(hub, factory, 'node-b', '客厅小主机');

    const created = await a.groups.create('TeamA');
    expect(created).toEqual({ groupId: 'grp-1', nodeId: 'node-a' });

    const { inviteCode } = await a.groups.invite('grp-1');
    expect(typeof inviteCode).toBe('string');

    const joined = await b.groups.join(inviteCode);
    expect(joined).toEqual({ groupId: 'grp-1' });

    const { groups } = await a.groups.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ groupId: 'grp-1', groupName: 'TeamA', leaderNodeId: 'node-a' });
    expect(groups[0]!.members.map((m) => m.nodeId).sort()).toEqual(['node-a', 'node-b']);
    // 组引擎广播产生 group.changed 事件（客户端 onEvent 面可见——桥的上游）
    expect(hub.events.filter((e) => e.method === EVT.groupChanged)).toHaveLength(2);
    a.client.stop();
    b.client.stop();
  });

  it('邀请码撤销：再生成后旧码入组 → not_found 人话 rejection', async () => {
    const { hub, factory } = makeHub();
    const a = await enrollClient(hub, factory, 'node-a', 'A');
    const b = await enrollClient(hub, factory, 'node-b', 'B');
    await a.groups.create('T');
    const c1 = (await a.groups.invite('grp-1')).inviteCode;
    const c2 = (await a.groups.invite('grp-1')).inviteCode;
    expect(c1).not.toBe(c2);
    await expect(b.groups.join(c1)).rejects.toThrow('邀请码无效或已被撤销');
    await expect(b.groups.join(c2)).resolves.toEqual({ groupId: 'grp-1' });
    a.client.stop();
    b.client.stop();
  });

  it('角色矩阵：非 leader transfer → forbidden 人话；非成员 invite/leave → forbidden', async () => {
    const { hub, factory } = makeHub();
    const a = await enrollClient(hub, factory, 'node-a', 'A');
    const b = await enrollClient(hub, factory, 'node-b', 'B');
    const c = await enrollClient(hub, factory, 'node-c', 'C');
    await a.groups.create('T');
    const code = (await a.groups.invite('grp-1')).inviteCode;
    await b.groups.join(code);

    await expect(b.groups.transfer('grp-1', 'node-b')).rejects.toThrow('仅组长（leader）可执行该操作');
    await expect(c.groups.invite('grp-1')).rejects.toThrow('仅本组成员可生成邀请码');
    await expect(c.groups.leave('grp-1')).rejects.toThrow('仅本组成员可退组');

    // leader 转移成功后角色翻转
    await expect(a.groups.transfer('grp-1', 'node-b')).resolves.toEqual({ ok: true });
    await expect(a.groups.transfer('grp-1', 'node-a')).rejects.toThrow('仅组长（leader）可执行该操作');
    a.client.stop();
    b.client.stop();
    c.client.stop();
  });

  it('leader 退组 → forbidden 人话；转移后可退', async () => {
    const { hub, factory } = makeHub();
    const a = await enrollClient(hub, factory, 'node-a', 'A');
    const b = await enrollClient(hub, factory, 'node-b', 'B');
    await a.groups.create('T');
    const code = (await a.groups.invite('grp-1')).inviteCode;
    await b.groups.join(code);
    await expect(a.groups.leave('grp-1')).rejects.toThrow('组长需先转移组长身份再退组');
    await a.groups.transfer('grp-1', 'node-b');
    await expect(a.groups.leave('grp-1')).resolves.toEqual({ ok: true });
    const { groups } = await b.groups.list();
    expect(groups[0]!.members).toHaveLength(1);
    a.client.stop();
    b.client.stop();
  });

  it('未鉴权连接（未知 token）→ unauthorized 人话 rejection', async () => {
    const { factory } = makeHub();
    const client = createHubClient({
      url: 'ws://x/ws', nodeName: 'ghost', deviceToken: 'bad-token',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0); // hello 本身不鉴权（升级头才鉴权）——组 RPC 层拒
    const groups = createGroupClient((m, p, t) => client.request(m, p, t));
    await expect(groups.create('T')).rejects.toThrow('凭证无效');
    client.stop();
  });

  it('离线（未 start）→ hub 未连接人话；在线超时 → 请求超时人话', async () => {
    const { hub, factory } = makeHub();
    // 未 start：client 直接拒
    const token = 'tok-x';
    hub.registerNode('node-x', 'X', token);
    const offline = createHubClient({
      url: 'ws://x/ws', nodeName: 'X', deviceToken: token,
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory,
    });
    const groupsOffline = createGroupClient((m, p, t) => offline.request(m, p, t));
    await expect(groupsOffline.list()).rejects.toThrow('hub 未连接');

    // 在线但 hub 不应答（去掉监听模拟黑洞）→ 超时
    const hub2 = new EventEmitter();
    const factory2: WsFactory = () => {
      const s = new FakeSocket('tok-y');
      queueMicrotask(() => {
        // 监听先于 open 挂上——open 内同步发 hello，晚挂会丢首帧
        s.on('to-server', (raw: string) => {
          const env = JSON.parse(raw) as { kind: string; method: string; id: string };
          if (env.kind !== 'req' || env.method !== RPC.hello) return; // 只回 hello
          queueMicrotask(() => s.emit('message', JSON.stringify({
            v: 1, kind: 'res', id: env.id, method: RPC.hello, ok: true,
            payload: { hubId: 'hub', protoVer: PROTOCOL_VERSION, serverTime: 0, onlineNodes: [] },
          })));
        });
        s.emit('open');
      });
      return s;
    };
    void hub2;
    const online = createHubClient({
      url: 'ws://x/ws', nodeName: 'Y', deviceToken: 'tok-y',
      onStateChange: () => undefined, onEvent: () => undefined, ws: factory2,
    });
    online.start();
    await vi.advanceTimersByTimeAsync(0);
    const groupsOnline = createGroupClient((m, p, t) => online.request(m, p, t));
    const p = expect(groupsOnline.list()).rejects.toThrow('请求超时：group.list');
    vi.advanceTimersByTime(10_100);
    await p;
    online.stop();
    offline.stop();
  });
});
