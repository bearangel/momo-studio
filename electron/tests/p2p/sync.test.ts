// electron/tests/p2p/sync.test.ts
//
// P2pSync（C 子系统 C7）测试：
//   - broadcastNewMessage：遍历信任节点，逐个 router.send（跳过自己）
//   - 远端 message 抵达 → onRemoteMessage 触发
//
// 设计说明：
//   - Router 用 mock 替代（不依赖 transport/router 真实实例）
//   - trust-store 用 vi.spyOn 模拟 listTrustedNodes 返回固定列表
//   - 不依赖文件 IO
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { P2pSync } from '../../src/main/p2p/sync';
import * as trustStore from '../../src/main/p2p/trust-store';
import type { Router } from '../../src/main/p2p/router';
import type { IncomingMessage } from '../../src/main/p2p/types';

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

    router._emit({
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'presence', body: { online: true } },
      receivedAt: Date.now(),
    });

    expect(onRemote).not.toHaveBeenCalled();
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
