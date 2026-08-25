// electron/tests/p2p/ipc-fingerprint.test.ts
//
// P2P IPC handler 指纹契约测试（P2 安全修复）：
//   - p2p:getIdentity 返回结构含 fingerprint 字段（hex 32 字符）
//   - p2p:getDiscoveredNodes 返回节点列表每项含 fingerprint 字段（来自签名公钥）
//   - 指纹值 = publicKeyFingerprint(node.publicKey)，与本机/对端带外比对用
//   - trusted=true 时返回的 fingerprint 不变（信任不重算指纹）
//
// 模式：与 remote-cache.test.ts 一致——vi.hoisted + vi.mock 捕获 ipcMain.handle
// 注册表；LanTransport mock 返回受控 discoveredNodes；identity 模块用真实实现
// 让 publicKeyFingerprint 跑真实计算（非桩），与远端 UI 带外核对用的是同一函数。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';

const {
  ipcHandlers,
  lanDiscover,
  incomingHandler,
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  lanDiscover: {
    /** 当前 LanTransport 实例对外暴露的 discoveredNodes 快照（mock 控制） */
    current: [] as Array<{
      nodeId: string;
      displayName: string;
      publicKey: Uint8Array;
      boxPublicKey?: Uint8Array;
      transport: 'lan' | 'hub';
      lastSeen: number;
    }>,
  },
  incomingHandler: {
    current: undefined as ((msg: unknown) => void) | undefined,
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Router 桩——onIncoming 捕获 handler 供测试注入（initP2p 必走）
vi.mock('../../src/main/p2p/router', () => ({
  Router: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    onIncoming = vi.fn((h: (msg: unknown) => void) => {
      incomingHandler.current = h;
      return () => {};
    });
    send = vi.fn(async () => {});
  },
}));

vi.mock('../../src/main/p2p/local-transport', () => ({
  LocalTransport: class {},
}));

// LanTransport 桩——discoverNodes 返回 lanDiscover.current；让测试直接控制快照
vi.mock('../../src/main/p2p/lan-transport', () => ({
  LanTransport: class {
    discoverNodes = vi.fn(() => lanDiscover.current);
  },
}));

// identity 用真实实现——让 publicKeyFingerprint 跑真实 sha512 计算（远端 UI 共用）
vi.mock('../../src/main/p2p/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/identity')>()),
  loadIdentity: vi.fn(() => ({
    nodeId: 'node_me00000000000',
    displayName: '本机节点',
    publicKey: new Uint8Array(32),
    boxPublicKey: new Uint8Array(32),
    boxPrivateKey: new Uint8Array(32),
  })),
  generateIdentity: vi.fn(),
  saveIdentity: vi.fn(),
}));

vi.mock('../../src/main/p2p/trust-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/trust-store')>()),
  listTrustedNodes: vi.fn(() => []),
  addTrustedNode: vi.fn(),
  removeTrustedNode: vi.fn(),
  isTrusted: vi.fn(() => false),
  getTrustedPublicKey: vi.fn(() => null),
  getTrustedBoxPublicKey: vi.fn(() => null),
}));

vi.mock('../../src/main/storage/tasks/repo', () => ({
  listTasks: vi.fn(() => []),
}));

import { initP2p, stopP2p, registerP2pHandlers } from '../../src/main/p2p/index';
import { publicKeyFingerprint } from '../../src/main/p2p/identity';

beforeEach(() => {
  ipcHandlers.clear();
  lanDiscover.current = [];
  incomingHandler.current = undefined;
});

afterEach(async () => {
  await stopP2p();
});

/** 构造 mDNS 发现数据 fixture——签名公钥用真实 nacl 生成（让指纹算有意义） */
function mkDiscovered(overrides: { nodeId: string; displayName: string; trusted?: boolean } = {
  nodeId: 'node_x0000000000000',
  displayName: 'X',
}) {
  return {
    nodeId: overrides.nodeId,
    displayName: overrides.displayName,
    publicKey: nacl.sign.keyPair().publicKey,
    boxPublicKey: nacl.box.keyPair().publicKey,
    transport: 'lan' as const,
    lastSeen: Date.now(),
  };
}

describe('P2P IPC handler 指纹契约（P2 安全修复）', () => {
  it('p2p:getIdentity 返回结构含 fingerprint（hex 32 字符）', async () => {
    await initP2p();
    registerP2pHandlers();

    const handler = ipcHandlers.get('p2p:getIdentity');
    expect(handler).toBeTruthy();

    const id = (await handler!()) as {
      nodeId: string;
      displayName: string;
      fingerprint: string;
    };

    expect(id).toMatchObject({
      nodeId: 'node_me00000000000',
      displayName: '本机节点',
    });
    expect(typeof id.fingerprint).toBe('string');
    expect(id.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('p2p:getDiscoveredNodes 返回每节点均含 fingerprint 字段（来自签名公钥）', async () => {
    const a = mkDiscovered({ nodeId: 'node_a0000000000000', displayName: 'Alice' });
    const b = mkDiscovered({ nodeId: 'node_b0000000000000', displayName: 'Bob' });
    lanDiscover.current = [a, b];
    await initP2p();
    registerP2pHandlers();

    const handler = ipcHandlers.get('p2p:getDiscoveredNodes');
    expect(handler).toBeTruthy();

    const list = (await handler!()) as Array<{
      nodeId: string;
      displayName: string;
      fingerprint: string;
      trusted: boolean;
    }>;

    expect(list).toHaveLength(2);
    for (const n of list) {
      expect(typeof n.fingerprint).toBe('string');
      expect(n.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    }
    // 指纹必须等于对应节点签名公钥的真实指纹——远端 UI 与本机 UI 共用同一函数
    expect(list.find((n) => n.nodeId === a.nodeId)!.fingerprint).toBe(
      publicKeyFingerprint(a.publicKey),
    );
    expect(list.find((n) => n.nodeId === b.nodeId)!.fingerprint).toBe(
      publicKeyFingerprint(b.publicKey),
    );
  });

  it('p2p:getDiscoveredNodes 不同节点指纹不同（同公钥指纹必一致）', async () => {
    const a = mkDiscovered({ nodeId: 'node_a0000000000000', displayName: 'A' });
    const b = mkDiscovered({ nodeId: 'node_b0000000000000', displayName: 'B' });
    lanDiscover.current = [a, b];
    await initP2p();
    registerP2pHandlers();

    const list = (await ipcHandlers.get('p2p:getDiscoveredNodes')!()) as Array<{
      nodeId: string;
      fingerprint: string;
    }>;
    const fpA = list.find((n) => n.nodeId === a.nodeId)!.fingerprint;
    const fpB = list.find((n) => n.nodeId === b.nodeId)!.fingerprint;
    expect(fpA).not.toBe(fpB);
  });

  it('p2p:getDiscoveredNodes 空列表返回 []（lanTransport 未发现任何节点）', async () => {
    lanDiscover.current = [];
    await initP2p();
    registerP2pHandlers();

    const list = (await ipcHandlers.get('p2p:getDiscoveredNodes')!()) as unknown[];
    expect(list).toEqual([]);
  });

  it('p2p:getIdentity 未初始化时返回 null', () => {
    registerP2pHandlers();
    const handler = ipcHandlers.get('p2p:getIdentity');
    expect(handler).toBeTruthy();
    // registerP2pHandlers 调用早于 initP2p——currentIdentity 为 null
    const id = handler!() as unknown;
    expect(id).toBeNull();
  });
});
