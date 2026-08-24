// electron/tests/p2p/sync.test.ts
//
// P2pSync（C 子系统 C7 + P4 协议扩展）测试：
//   - broadcastNewMessage：遍历信任节点，逐个 router.send（跳过自己）
//   - 远端 message 抵达 → onRemoteMessage 触发
//   - P4 多路分发：task-snapshot / resource-catalog / resource-request / resource-provide
//     入站分发（对象 + fromNodeId）、畸形 body 静默丢弃、出站广播遍历信任节点、单发指定节点
//
// 设计说明：
//   - Router 用 mock 替代（不依赖 transport/router 真实实例）
//   - trust-store 用 vi.spyOn 模拟 listTrustedNodes 返回固定列表
//   - 不依赖文件 IO
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { P2pSync } from '../../src/main/p2p/sync';
import type {
  TaskSnapshot,
  ResourceCatalogEntry,
  ResourceRequest,
  ResourceProvide,
} from '../../src/main/p2p/protocols';
import * as trustStore from '../../src/main/p2p/trust-store';
import type { Router } from '../../src/main/p2p/router';
import type { IncomingMessage, MessagePayload } from '../../src/main/p2p/types';

/**
 * 构造一个最小 mock Router。
 * - onIncoming 注册的 handler 存进 Set，_emit 触发全部
 * - send 是 vi.fn 返回 undefined（async）
 *
 * 注：原 brief 的 mock 用了 `onMessage`，但 Router 暴露的是 `onIncoming(handler)`
 * （与 TransportLayer.onMessage 不同——Router 是应用层订阅点）。这里以实现为准。
 */
type MockRouter = {
  send: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onIncoming: any;
  _emit: (m: IncomingMessage) => void;
};

function mkMockRouter(): MockRouter {
  const handlers = new Set<(m: IncomingMessage) => void>();
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onIncoming: vi.fn((h: (m: IncomingMessage) => void) => {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    }),
    _emit: (m: IncomingMessage) => {
      handlers.forEach((h) => h(m));
    },
  };
}

/** P4 测试夹具：合法的 TaskSnapshot（tasks 元素是 TaskRow Pick 子集） */
const SNAPSHOT: TaskSnapshot = {
  nodeId: 'peer1',
  nodeName: 'Peer1',
  tasks: [
    {
      id: 'T-1',
      title: '写设计文档',
      status: 'in_progress',
      assigneeAgentId: 'pm-agent',
      priority: 1,
      createdAt: 100,
      updatedAt: 200,
    },
    {
      id: 'T-2',
      title: '修复登录 bug',
      status: 'draft',
      assigneeAgentId: null,
      priority: 2,
      createdAt: 101,
      updatedAt: 201,
    },
  ],
  takenAt: 12345,
};

/** P4 测试夹具：合法的 ResourceCatalogEntry（agent + mcp 各一条） */
const CATALOG: ResourceCatalogEntry = {
  nodeId: 'peer1',
  nodeName: 'Peer1',
  items: [
    {
      type: 'agent',
      slug: 'code-reviewer',
      name: 'Code Reviewer',
      description: '代码审查 agent',
      version: '1.0.0',
    },
    { type: 'mcp', slug: 'github', name: 'GitHub MCP', description: 'GitHub 工具集' },
  ],
  takenAt: 12345,
};

function mkSync(router: MockRouter, opts?: Partial<ConstructorOpts>): P2pSync {
  return new P2pSync({
    router: router as unknown as Router,
    localNodeId: 'me',
    onRemoteMessage: vi.fn(),
    ...opts,
  });
}

type ConstructorOpts = ConstructorParameters<typeof P2pSync>[0];

describe('P2pSync', () => {
  beforeEach(() => {
    // 模拟信任节点列表：3 个远程节点 + 1 个自己
    vi.spyOn(trustStore, 'listTrustedNodes').mockReturnValue([
      { nodeId: 'me', displayName: 'Me', publicKey: new Uint8Array(32), trustedAt: 1 },
      { nodeId: 'peer1', displayName: 'Peer1', publicKey: new Uint8Array(32), trustedAt: 2 },
      { nodeId: 'peer2', displayName: 'Peer2', publicKey: new Uint8Array(32), trustedAt: 3 },
      { nodeId: 'peer3', displayName: 'Peer3', publicKey: new Uint8Array(32), trustedAt: 4 },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcastNewMessage → router.send 给所有信任节点（跳过自己）', async () => {
    const router = mkMockRouter();
    const sync = new P2pSync({
      router: router as unknown as Router,
      localNodeId: 'me',
      onRemoteMessage: vi.fn(),
    });
    sync.start();

    await sync.broadcastNewMessage({
      roomId: 'r1',
      sender: '@me:home',
      body: 'hi',
      eventType: 'm.room.message',
    });

    // 期望给 peer1/peer2/peer3 各发一次（共 3 次），跳过自己
    expect(router.send).toHaveBeenCalledTimes(3);
    expect(router.send).toHaveBeenCalledWith(
      'peer1',
      expect.objectContaining({
        targetNodeId: 'peer1',
        type: 'message',
        body: expect.objectContaining({ body: 'hi', sender: '@me:home' }),
      }),
    );
    expect(router.send).toHaveBeenCalledWith(
      'peer2',
      expect.objectContaining({ targetNodeId: 'peer2', type: 'message' }),
    );
    expect(router.send).toHaveBeenCalledWith(
      'peer3',
      expect.objectContaining({ targetNodeId: 'peer3', type: 'message' }),
    );
    // 验证没发给 'me'（自己）
    expect(router.send).not.toHaveBeenCalledWith('me', expect.anything());
  });

  it('收到远端 message → onRemoteMessage 触发', () => {
    const router = mkMockRouter();
    const onRemote = vi.fn();
    const sync = new P2pSync({
      router: router as unknown as Router,
      localNodeId: 'me',
      onRemoteMessage: onRemote,
    });
    sync.start();

    // 模拟 router 派发一条来自 peer1 的 message
    router._emit({
      fromNodeId: 'peer1',
      payload: {
        targetNodeId: 'me',
        type: 'message',
        body: {
          roomId: 'r1',
          sender: '@peer1:home',
          body: 'hello',
          eventType: 'm.room.message',
        },
      },
      receivedAt: Date.now(),
    });

    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(onRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        sender: '@peer1:home',
        body: 'hello',
        eventType: 'm.room.message',
      }),
    );
  });

  it('收到非 message 类型 → onRemoteMessage 不触发', () => {
    const router = mkMockRouter();
    const onRemote = vi.fn();
    const sync = new P2pSync({
      router: router as unknown as Router,
      localNodeId: 'me',
      onRemoteMessage: onRemote,
    });
    sync.start();

    // task-snapshot 占用原 presence 的"非 message 类型"角色（枚举收敛后 presence 不在联合内）
    router._emit({
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'task-snapshot', body: { online: true } },
      receivedAt: Date.now(),
    });

    expect(onRemote).not.toHaveBeenCalled();
  });

  it('收到远端 task-snapshot → onRemoteTaskSnapshot 收到解析后对象 + fromNodeId', () => {
    const router = mkMockRouter();
    const onSnap = vi.fn();
    const sync = mkSync(router, { onRemoteTaskSnapshot: onSnap });
    sync.start();

    router._emit({
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'task-snapshot', body: { ...SNAPSHOT } },
      receivedAt: Date.now(),
    });

    expect(onSnap).toHaveBeenCalledTimes(1);
    expect(onSnap).toHaveBeenCalledWith(SNAPSHOT, 'peer1');
  });

  it('收到远端 resource-catalog → onRemoteResourceCatalog 收到解析后对象 + fromNodeId', () => {
    const router = mkMockRouter();
    const onCatalog = vi.fn();
    const sync = mkSync(router, { onRemoteResourceCatalog: onCatalog });
    sync.start();

    router._emit({
      fromNodeId: 'peer2',
      payload: { targetNodeId: 'me', type: 'resource-catalog', body: { ...CATALOG } },
      receivedAt: Date.now(),
    });

    expect(onCatalog).toHaveBeenCalledTimes(1);
    expect(onCatalog).toHaveBeenCalledWith(CATALOG, 'peer2');
  });

  it('收到远端 resource-request → onResourceRequest 收到请求 + fromNodeId', () => {
    const router = mkMockRouter();
    const onReq = vi.fn();
    const sync = mkSync(router, { onResourceRequest: onReq });
    sync.start();

    const req: ResourceRequest = { requestId: 'req-1', resourceType: 'agent', slug: 'code-reviewer' };
    router._emit({
      fromNodeId: 'peer3',
      payload: { targetNodeId: 'me', type: 'resource-request', body: { ...req } },
      receivedAt: Date.now(),
    });

    expect(onReq).toHaveBeenCalledTimes(1);
    expect(onReq).toHaveBeenCalledWith(req, 'peer3');
  });

  it('收到远端 resource-provide → onResourceProvide 收到定义 + fromNodeId', () => {
    const router = mkMockRouter();
    const onProv = vi.fn();
    const sync = mkSync(router, { onResourceProvide: onProv });
    sync.start();

    const prov: ResourceProvide = {
      requestId: 'req-1',
      definition: { slug: 'code-reviewer', prompt: '你是代码审查专家' },
    };
    router._emit({
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'resource-provide', body: { ...prov } },
      receivedAt: Date.now(),
    });

    expect(onProv).toHaveBeenCalledTimes(1);
    expect(onProv).toHaveBeenCalledWith(prov, 'peer1');
  });

  it('畸形 body / 未知 type 静默丢弃（不抛、不触发任何回调）', () => {
    const router = mkMockRouter();
    const onMsg = vi.fn();
    const onSnap = vi.fn();
    const onCatalog = vi.fn();
    const onReq = vi.fn();
    const onProv = vi.fn();
    const sync = mkSync(router, {
      onRemoteMessage: onMsg,
      onRemoteTaskSnapshot: onSnap,
      onRemoteResourceCatalog: onCatalog,
      onResourceRequest: onReq,
      onResourceProvide: onProv,
    });
    sync.start();

    const malformed: Array<MessagePayload> = [
      // task-snapshot：字段类型错 / tasks 非数组
      { targetNodeId: 'me', type: 'task-snapshot', body: { nodeId: 1, nodeName: 'x', tasks: 'nope', takenAt: 1 } },
      // task-snapshot：tasks 元素缺 title
      {
        targetNodeId: 'me',
        type: 'task-snapshot',
        body: { nodeId: 'p', nodeName: 'x', tasks: [{ id: 'T-1', status: 'draft' }], takenAt: 1 },
      },
      // resource-catalog：items 非数组
      { targetNodeId: 'me', type: 'resource-catalog', body: { nodeId: 'p', nodeName: 'x', items: null, takenAt: 1 } },
      // resource-catalog：item 的 type 非法
      {
        targetNodeId: 'me',
        type: 'resource-catalog',
        body: { nodeId: 'p', nodeName: 'x', items: [{ type: 'skill', slug: 's', name: 'n', description: 'd' }], takenAt: 1 },
      },
      // resource-request：resourceType 非法
      { targetNodeId: 'me', type: 'resource-request', body: { requestId: 'r', resourceType: 'skill', slug: 's' } },
      // resource-provide：definition 缺失
      { targetNodeId: 'me', type: 'resource-provide', body: { requestId: 'r' } },
      // 未知 type（传输层对端可能是旧/新版本，运行时会收到联合外的字符串）
      { targetNodeId: 'me', type: 'mystery' as MessagePayload['type'], body: { whatever: true } },
      // message：缺 sender（既有 guard 行为回归确认）
      { targetNodeId: 'me', type: 'message', body: { roomId: 'r1', body: 'hi', eventType: 'e' } },
    ];

    for (const payload of malformed) {
      expect(() =>
        router._emit({ fromNodeId: 'peer1', payload, receivedAt: Date.now() }),
      ).not.toThrow();
    }

    expect(onMsg).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
    expect(onCatalog).not.toHaveBeenCalled();
    expect(onReq).not.toHaveBeenCalled();
    expect(onProv).not.toHaveBeenCalled();
  });

  it('broadcastTaskSnapshot → 遍历信任节点发送（payload.type=task-snapshot，跳过自己）', async () => {
    const router = mkMockRouter();
    const sync = mkSync(router);
    sync.start();

    await sync.broadcastTaskSnapshot(SNAPSHOT);

    expect(router.send).toHaveBeenCalledTimes(3);
    for (const peer of ['peer1', 'peer2', 'peer3']) {
      expect(router.send).toHaveBeenCalledWith(
        peer,
        expect.objectContaining({ targetNodeId: peer, type: 'task-snapshot', body: SNAPSHOT }),
      );
    }
    expect(router.send).not.toHaveBeenCalledWith('me', expect.anything());
  });

  it('broadcastResourceCatalog → 遍历信任节点发送（payload.type=resource-catalog，跳过自己）', async () => {
    const router = mkMockRouter();
    const sync = mkSync(router);
    sync.start();

    await sync.broadcastResourceCatalog(CATALOG);

    expect(router.send).toHaveBeenCalledTimes(3);
    for (const peer of ['peer1', 'peer2', 'peer3']) {
      expect(router.send).toHaveBeenCalledWith(
        peer,
        expect.objectContaining({ targetNodeId: peer, type: 'resource-catalog', body: CATALOG }),
      );
    }
    expect(router.send).not.toHaveBeenCalledWith('me', expect.anything());
  });

  it('sendResourceRequest → 单发指定节点', async () => {
    const router = mkMockRouter();
    const sync = mkSync(router);

    const req: ResourceRequest = { requestId: 'req-9', resourceType: 'mcp', slug: 'github' };
    await sync.sendResourceRequest('peer2', req);

    expect(router.send).toHaveBeenCalledTimes(1);
    expect(router.send).toHaveBeenCalledWith('peer2', {
      targetNodeId: 'peer2',
      type: 'resource-request',
      body: { ...req },
    });
  });

  it('sendResourceProvide → 单发指定节点', async () => {
    const router = mkMockRouter();
    const sync = mkSync(router);

    const prov: ResourceProvide = { requestId: 'req-9', definition: { command: 'github-mcp' } };
    await sync.sendResourceProvide('peer3', prov);

    expect(router.send).toHaveBeenCalledTimes(1);
    expect(router.send).toHaveBeenCalledWith('peer3', {
      targetNodeId: 'peer3',
      type: 'resource-provide',
      body: { ...prov },
    });
  });

  it('start 后 unsubscribe 清理订阅', () => {
    const router = mkMockRouter();
    const onRemote = vi.fn();
    const sync = new P2pSync({
      router: router as unknown as Router,
      localNodeId: 'me',
      onRemoteMessage: onRemote,
    });
    sync.start();
    sync.stop();

    router._emit({
      fromNodeId: 'peer1',
      payload: {
        targetNodeId: 'me',
        type: 'message',
        body: { roomId: 'r1', sender: '@peer1:home', body: 'after-stop', eventType: 'm.room.message' },
      },
      receivedAt: Date.now(),
    });

    expect(onRemote).not.toHaveBeenCalled();
  });
});
