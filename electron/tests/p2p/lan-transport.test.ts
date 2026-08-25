// electron/tests/p2p/lan-transport.test.ts
//
// LanTransport（C 子系统 C3，v2 安全修复后）测试：
//   - 两个 LanTransport 实例（同进程模拟两节点）通过真实 mDNS + TCP 互通
//     （v2 帧：sign-then-encrypt——明文不出现在 TCP 流上）
//   - discoverNodes 在 mDNS 发现窗口内能见到对方节点（含 box 公钥捕获）
//   - 安全修复回归锁：入站连接发送超长行（>1MB 无换行）→ 销毁 socket（DoS 防御）
//   - 安全修复回归锁：单条完整超长行（带换行）→ 同样销毁
//   - 安全修复回归锁：v1 明文帧被丢弃（不进 onMessage）
//   - 发送目标缺少 box 公钥（旧版本信任条目）→ 抛错（禁止明文降级）
//
// 依赖真实 mDNS（组播）+ TCP 端口；CI 环境若禁用组播可能 flaky。
// 失败时先确认 lan-protocol.test.ts 通过（核心编解码逻辑稳定）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { LanTransport } from '../../src/main/p2p/lan-transport';
import { generateIdentity, type NodeIdentity } from '../../src/main/p2p/identity';
import { saveAll } from '../../src/main/p2p/trust-store';

const tmpRoot = path.join(os.tmpdir(), `ap-lan-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造互信两节点的测试 trustStore stub（v2 帧需要签名 + box 双公钥） */
function mkTrustStore(alice: NodeIdentity, bob: NodeIdentity) {
  return {
    isTrusted: () => true,
    getTrustedPublicKey: (id: string): Uint8Array | null =>
      id === alice.nodeId ? alice.publicKey : bob.publicKey,
    getTrustedBoxPublicKey: (id: string): Uint8Array | null =>
      id === alice.nodeId ? alice.boxPublicKey : bob.boxPublicKey,
  };
}

describe('LanTransport', () => {
  // 集成测试依赖真实 mDNS（组播）+ TCP；CI 环境禁用组播会超时。
  it('两节点 TCP 直连互发消息（v2 加密帧）', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');

    // 双方互信（含 box 公钥）
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, boxPublicKey: alice.boxPublicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, boxPublicKey: bob.boxPublicKey, trustedAt: Date.now() },
    ]);

    // 测试用 trustStore stub：不查盘，直接按 nodeId 返回对应公钥
    const ts = mkTrustStore(alice, bob);
    const aliceT = new LanTransport({ identity: alice, port: 18001, trustStore: ts });
    const bobT = new LanTransport({ identity: bob, port: 18002, trustStore: ts });
    await aliceT.start();
    await bobT.start();

    // 给 mDNS 发现 + 主动建连一点时间
    await new Promise((r) => setTimeout(r, 1500));

    const received: Array<{ from: string; body: unknown }> = [];
    bobT.onMessage((msg) => received.push({ from: msg.fromNodeId, body: msg.payload.body }));

    await aliceT.send(bob.nodeId, { targetNodeId: bob.nodeId, type: 'message', body: { text: 'hi from alice' } });

    // 给 TCP 传输 + 验签解密派发一点时间
    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(1);
    expect(received[0].from).toBe(alice.nodeId);
    expect(received[0].body).toEqual({ text: 'hi from alice' });

    await aliceT.stop();
    await bobT.stop();
  }, 15000);

  it('discoverNodes 返回局域网内其他 Momo 节点（含 box 公钥）', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, boxPublicKey: alice.boxPublicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, boxPublicKey: bob.boxPublicKey, trustedAt: Date.now() },
    ]);
    const ts = mkTrustStore(alice, bob);
    const aliceT = new LanTransport({ identity: alice, port: 18003, trustStore: ts });
    const bobT = new LanTransport({ identity: bob, port: 18004, trustStore: ts });
    await aliceT.start();
    await bobT.start();
    await new Promise((r) => setTimeout(r, 1500));
    const bobs = aliceT.discoverNodes();
    const found = bobs.find((n) => n.nodeId === bob.nodeId);
    expect(found).toBeTruthy();
    // box 公钥随发现数据捕获（信任时写入信任库的来源）
    expect(
      Buffer.from(found!.boxPublicKey!).equals(Buffer.from(bob.boxPublicKey)),
    ).toBe(true);
    await aliceT.stop();
    await bobT.stop();
  }, 15000);

  it('安全修复回归锁：入站连接灌超长数据（>1MB 无换行）→ 销毁 socket', async () => {
    const bob = generateIdentity('Bob');
    const ts = mkTrustStore(bob, bob);
    const bobT = new LanTransport({ identity: bob, port: 18005, trustStore: ts });
    await bobT.start();

    const sock = net.createConnection({ host: '127.0.0.1', port: 18005 });
    // 服务端 destroy 会给恶意客户端回 RST——真实客户端需处理 error 才不崩测试进程
    sock.on('error', () => {});
    const closed = new Promise<void>((resolve) => sock.on('close', () => resolve()));
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    // 恶意客户端：永不发换行符的巨量数据——信任验证前的内存耗尽 DoS 载荷
    sock.write('A'.repeat(2 * 1024 * 1024));

    await closed; // 超限 → 服务端 destroy

    await bobT.stop();
  }, 15000);

  it('安全修复回归锁：单条完整超长行（带换行）→ 同样销毁 socket', async () => {
    const bob = generateIdentity('Bob');
    const ts = mkTrustStore(bob, bob);
    const bobT = new LanTransport({ identity: bob, port: 18006, trustStore: ts });
    await bobT.start();

    const sock = net.createConnection({ host: '127.0.0.1', port: 18006 });
    sock.on('error', () => {});
    const closed = new Promise<void>((resolve) => sock.on('close', () => resolve()));
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    // 完整（带换行）但超长的单帧——同样不被接受
    sock.write('B'.repeat(2 * 1024 * 1024) + '\n');

    await closed;

    await bobT.stop();
  }, 15000);

  it('安全修复回归锁：v1 明文帧被丢弃（不进 onMessage）', async () => {
    const bob = generateIdentity('Bob');
    const ts = mkTrustStore(bob, bob);
    const bobT = new LanTransport({ identity: bob, port: 18007, trustStore: ts });
    await bobT.start();

    const received: unknown[] = [];
    bobT.onMessage((msg) => received.push(msg));

    const sock = net.createConnection({ host: '127.0.0.1', port: 18007 });
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));
    // 伪造 v1 明文帧（声称来自 bob 自身——即使签名格式合法也因版本不符被拒）
    sock.write(JSON.stringify({
      v: 1,
      fromNodeId: bob.nodeId,
      signature: Buffer.from(new Uint8Array(64)).toString('base64'),
      payload: { targetNodeId: bob.nodeId, type: 'message', body: { text: '明文' } },
    }) + '\n');

    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(0);

    sock.destroy();
    await bobT.stop();
  }, 15000);

  it('发送目标缺少 box 公钥（旧版本信任条目）→ 抛错，不降级明文', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const ts = {
      isTrusted: () => true,
      getTrustedPublicKey: (id: string): Uint8Array | null =>
        id === alice.nodeId ? alice.publicKey : bob.publicKey,
      // 模拟旧版本信任条目：签名公钥在，box 公钥缺失
      getTrustedBoxPublicKey: () => null,
    };
    const aliceT = new LanTransport({ identity: alice, port: 18008, trustStore: ts });
    await aliceT.start();

    // 直接对未建立连接的节点 send 会在连接检查处抛错——为触达 box 公钥检查，
    // 先手工注入一条伪连接（绕过 mDNS 依赖）
    const fakeSocket = new net.Socket();
    (aliceT as unknown as { connections: Map<string, { socket: net.Socket; nodeId: string; buffer: string }> })
      .connections.set(bob.nodeId, { socket: fakeSocket, nodeId: bob.nodeId, buffer: '' });

    await expect(
      aliceT.send(bob.nodeId, { targetNodeId: bob.nodeId, type: 'message', body: { text: 'x' } }),
    ).rejects.toThrow(/box 公钥/);

    fakeSocket.destroy();
    await aliceT.stop();
  }, 15000);
});
