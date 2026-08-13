// electron/tests/p2p/lan-transport.test.ts
//
// LanTransport（C 子系统 C3）集成测试：
//   - 两个 LanTransport 实例（同进程模拟两节点）通过真实 mDNS + TCP 互通
//   - discoverNodes 在 mDNS 发现窗口内能见到对方节点
//
// 依赖真实 mDNS（组播）+ TCP 端口；CI 环境若禁用组播可能 flaky。
// 失败时先确认 lan-protocol.test.ts 通过（核心编解码逻辑稳定）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

describe('LanTransport', () => {
  // 集成测试依赖真实 mDNS（组播）+ TCP；CI 环境禁用组播会超时。
  it('两节点 TCP 直连互发消息', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');

    // 双方互信
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, trustedAt: Date.now() },
    ]);

    // 测试用 trustStore stub：不查盘，直接按 nodeId 返回对应公钥
    const ts = {
      isTrusted: () => true,
      getTrustedPublicKey: (id: string): Uint8Array =>
        id === alice.nodeId ? alice.publicKey : bob.publicKey,
    };
    const aliceT = new LanTransport({ identity: alice, port: 18001, trustStore: ts });
    const bobT = new LanTransport({ identity: bob, port: 18002, trustStore: ts });
    await aliceT.start();
    await bobT.start();

    // 给 mDNS 发现 + 主动建连一点时间
    await new Promise((r) => setTimeout(r, 1500));

    const received: Array<{ from: string; body: unknown }> = [];
    bobT.onMessage((msg) => received.push({ from: msg.fromNodeId, body: msg.payload.body }));

    await aliceT.send(bob.nodeId, { targetNodeId: bob.nodeId, type: 'message', body: { text: 'hi from alice' } });

    // 给 TCP 传输 + 验签派发一点时间
    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(1);
    expect(received[0].from).toBe(alice.nodeId);
    expect(received[0].body).toEqual({ text: 'hi from alice' });

    await aliceT.stop();
    await bobT.stop();
  }, 15000);

  it('discoverNodes 返回局域网内其他 Momo 节点', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, trustedAt: Date.now() },
    ]);
    const ts = {
      isTrusted: () => true,
      getTrustedPublicKey: (id: string): Uint8Array =>
        id === alice.nodeId ? alice.publicKey : bob.publicKey,
    };
    const aliceT = new LanTransport({ identity: alice, port: 18003, trustStore: ts });
    const bobT = new LanTransport({ identity: bob, port: 18004, trustStore: ts });
    await aliceT.start();
    await bobT.start();
    await new Promise((r) => setTimeout(r, 1500));
    const bobs = aliceT.discoverNodes();
    expect(bobs.some((n) => n.nodeId === bob.nodeId)).toBe(true);
    await aliceT.stop();
    await bobT.stop();
  }, 15000);
});
