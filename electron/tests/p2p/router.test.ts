// electron/tests/p2p/router.test.ts
//
// Router（C 子系统 C4）测试：
//   - 路由决策优先级：local > lan > hub > 不可达
//   - onIncoming 接口——各 transport 的 onMessage 透传给统一 handler
//
// 不依赖真实网络，全部用 vi.fn 模拟 TransportLayer。
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/main/p2p/router';
import type { TransportLayer, IncomingMessage, NodeInfo } from '../../src/main/p2p/types';

/**
 * 构造一个 mock TransportLayer。
 * type 字段用来声明 transport 类型，discoverNodes 返回给定节点列表，
 * 其余方法均为 vi.fn()。
 */
function mkMockTransport(
  type: 'local' | 'lan' | 'hub',
  nodes: NodeInfo[] = [],
): TransportLayer & {
  sendMock: ReturnType<typeof vi>;
  startMock: ReturnType<typeof vi>;
} {
  return {
    type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    discoverNodes: vi.fn().mockReturnValue(nodes),
    onMessage: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportLayer & {
    sendMock: ReturnType<typeof vi>;
    startMock: ReturnType<typeof vi>;
  };
}

describe('Router', () => {
  it('目标是自己 → 走 LocalTransport', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const incoming = vi.fn();
    const router = new Router({
      localNodeId: 'me',
      localTransport: local,
      lanTransport: lan,
      onIncoming: incoming,
    });
    await router.start();
    await router.send('me', { targetNodeId: 'me', type: 'message', body: {} });
    expect(local.send).toHaveBeenCalledWith('me', expect.anything());
    expect(lan.send).not.toHaveBeenCalled();
    await router.stop();
  });

  it('目标在局域网 → 走 LanTransport', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', [{
      nodeId: 'peer1',
      displayName: 'Peer',
      publicKey: new Uint8Array(32),
      transport: 'lan',
      lastSeen: Date.now(),
    }]);
    const router = new Router({
      localNodeId: 'me',
      localTransport: local,
      lanTransport: lan,
      onIncoming: vi.fn(),
    });
    await router.start();
    await router.send('peer1', { targetNodeId: 'peer1', type: 'message', body: {} });
    expect(lan.send).toHaveBeenCalledWith('peer1', expect.anything());
    expect(local.send).not.toHaveBeenCalled();
  });

  it('目标不在局域网 + 有 HubTransport → 走 Hub', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const hub = mkMockTransport('hub');
    const router = new Router({
      localNodeId: 'me',
      localTransport: local,
      lanTransport: lan,
      hubTransport: hub,
      onIncoming: vi.fn(),
    });
    await router.start();
    await router.send('peer-remote', {
      targetNodeId: 'peer-remote',
      type: 'message',
      body: {},
    });
    expect(hub.send).toHaveBeenCalled();
  });

  it('目标不在局域网 + 无 HubTransport → 抛"不可达"', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const router = new Router({
      localNodeId: 'me',
      localTransport: local,
      lanTransport: lan,
      onIncoming: vi.fn(),
    });
    await router.start();
    await expect(
      router.send('peer-remote', {
        targetNodeId: 'peer-remote',
        type: 'message',
        body: {},
      }),
    ).rejects.toThrow(/不可达/);
  });

  it('onIncoming：各 transport 的 onMessage 触发后统一派发给 onIncoming handler', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const hub = mkMockTransport('hub');
    const incoming = vi.fn();

    // 捕获 mock 上注册的 handler
    const localHandlers: Array<(m: IncomingMessage) => void> = [];
    const lanHandlers: Array<(m: IncomingMessage) => void> = [];
    const hubHandlers: Array<(m: IncomingMessage) => void> = [];
    (local.onMessage as ReturnType<typeof vi>).mockImplementation((h: (m: IncomingMessage) => void) => {
      localHandlers.push(h);
      return () => {
        const i = localHandlers.indexOf(h);
        if (i >= 0) localHandlers.splice(i, 1);
      };
    });
    (lan.onMessage as ReturnType<typeof vi>).mockImplementation((h: (m: IncomingMessage) => void) => {
      lanHandlers.push(h);
      return () => {
        const i = lanHandlers.indexOf(h);
        if (i >= 0) lanHandlers.splice(i, 1);
      };
    });
    (hub.onMessage as ReturnType<typeof vi>).mockImplementation((h: (m: IncomingMessage) => void) => {
      hubHandlers.push(h);
      return () => {
        const i = hubHandlers.indexOf(h);
        if (i >= 0) hubHandlers.splice(i, 1);
      };
    });

    const router = new Router({
      localNodeId: 'me',
      localTransport: local,
      lanTransport: lan,
      hubTransport: hub,
      onIncoming: incoming,
    });
    await router.start();

    // 三个 transport 各推一条消息
    const msg1: IncomingMessage = {
      fromNodeId: 'me',
      payload: { targetNodeId: 'me', type: 'message', body: { src: 'local' } },
      receivedAt: 1,
    };
    const msg2: IncomingMessage = {
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'message', body: { src: 'lan' } },
      receivedAt: 2,
    };
    const msg3: IncomingMessage = {
      fromNodeId: 'remote',
      payload: { targetNodeId: 'me', type: 'message', body: { src: 'hub' } },
      receivedAt: 3,
    };
    expect(localHandlers.length).toBe(1);
    expect(lanHandlers.length).toBe(1);
    expect(hubHandlers.length).toBe(1);
    localHandlers[0](msg1);
    lanHandlers[0](msg2);
    hubHandlers[0](msg3);

    expect(incoming).toHaveBeenCalledTimes(3);
    expect(incoming).toHaveBeenNthCalledWith(1, msg1);
    expect(incoming).toHaveBeenNthCalledWith(2, msg2);
    expect(incoming).toHaveBeenNthCalledWith(3, msg3);

    await router.stop();
    // stop 后 handler 解注册
    expect(localHandlers.length).toBe(0);
    expect(lanHandlers.length).toBe(0);
    expect(hubHandlers.length).toBe(0);
  });
});