// electron/tests/p2p/hub-transport.test.ts
//
// HubTransport（C 子系统 C6）单元测试：
//   - start 建立 WSS 连接 + 立刻发 hello（含 nodeId/authToken/boxPublicKey/displayName）
//   - send 用对端 box 公钥派生共享密钥 → 加密 payload → 发密文给 hub（明文不外渗）
//   - deliver 路径：trustStore 提供 Bob 的 box 公钥时，Bob 的密文能被解密并推 onMessage
//   - 安全修复回归锁：未信任节点的 deliver 丢弃（presence 学到的公钥不救场）
//   - 安全修复回归锁：恶意 hub 换 key（nodeId → 攻击者 box 公钥）无法冒充受害者
//
// Mock ws 库。真实 ws 是 EventEmitter 子类（on('open'|'message'|'close'|'error')），
// 这里用自包含 mini EventEmitter 实现——vi.mock 工厂不能引用外部变量（hoisting TDZ）。
// mock 在构造后异步 emit 'open'，模拟真实连接建立时序。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import nacl from 'tweetnacl';

// vi.mock 自动 hoist 到所有 import 之前——工厂必须自包含，不引用外部变量
vi.mock('ws', () => {
  type Listener = (...args: unknown[]) => void;

  class MockWS {
    private listeners = new Map<string, Listener[]>();
    static instances: MockWS[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWS.OPEN;
    sent: unknown[] = [];

    constructor(public url: string) {
      MockWS.instances.push(this);
      setTimeout(() => this.emit('open'), 0);
    }

    on(event: string, cb: Listener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const list = this.listeners.get(event);
      if (list) for (const cb of list) cb(...args);
      return true;
    }

    send(data: unknown): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWS.CLOSED;
      this.emit('close');
    }
  }
  return { default: MockWS };
});

import WebSocket from 'ws';
import { HubTransport } from '../../src/main/p2p/hub-transport';
import { generateIdentity } from '../../src/main/p2p/identity';
import { deriveSharedKey, randomNonce, encryptPayload } from '../../src/main/p2p/crypto';

/** Mock 实例的最小接口——用于 emit 注入消息 + 读 sent */
interface MockWSInstance {
  sent: unknown[];
  emit(event: string, ...args: unknown[]): boolean;
}

function mockInstances(): MockWSInstance[] {
  return (WebSocket as unknown as { instances: MockWSInstance[] }).instances;
}

describe('HubTransport', () => {
  beforeEach(() => {
    // 静态 instances 跨测试保留——每个测试前清空
    mockInstances().length = 0;
  });

  it('start 后建立 WSS 连接 + 发 hello', async () => {
    const id = generateIdentity('Alice');
    const box = nacl.box.keyPair();
    const t = new HubTransport({
      identity: id,
      boxKeyPair: box,
      hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      trustStore: { getBoxPublicKey: () => null },
    });
    await t.start();

    const instances = mockInstances();
    expect(instances.length).toBe(1);
    expect(instances[0].sent[0]).toMatch(/hello/);

    await t.stop();
  });

  it('send 加密 payload 后发给 hub', async () => {
    const alice = generateIdentity('Alice');
    const aliceBox = nacl.box.keyPair();
    const bobBox = nacl.box.keyPair();
    const t = new HubTransport({
      identity: alice,
      boxKeyPair: aliceBox,
      hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      trustStore: { getBoxPublicKey: () => bobBox.publicKey },
    });
    await t.start();
    await t.send('node_bob', { targetNodeId: 'node_bob', type: 'message', body: { text: 'secret' } });

    const instances = mockInstances();
    // sent[0] = hello；sent[1] = 加密 send 包
    const envelope = JSON.parse(instances[0].sent[1] as string) as {
      to: string;
      ciphertext: string;
      nonce: string;
    };
    expect(envelope.to).toBe('node_bob');
    expect(envelope.ciphertext).toBeDefined();
    expect(envelope.nonce).toBeDefined();
    // 密文是 base64——绝不能包含明文 "secret"
    expect(envelope.ciphertext).not.toContain('secret');

    await t.stop();
  });

  it('deliver 解密后推 onMessage（解密公钥来自 trustStore）', async () => {
    const alice = generateIdentity('Alice');
    const aliceBox = nacl.box.keyPair();
    const bobBox = nacl.box.keyPair();
    const t = new HubTransport({
      identity: alice,
      boxKeyPair: aliceBox,
      hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      // 安全修复后：deliver 解密用信任库的 box 公钥（与出站 send 对称）
      trustStore: {
        getBoxPublicKey: (nodeId: string) =>
          nodeId === 'node_bob' ? bobBox.publicKey : null,
      },
    });
    await t.start();

    // 模拟 hub 推送 presence——告知 Alice 节点 Bob 在线及其 box 公钥（仅展示用）
    const conn = mockInstances()[0];
    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'presence',
      nodes: [{ nodeId: 'node_bob', displayName: 'Bob', boxPublicKey: Buffer.from(bobBox.publicKey).toString('base64') }],
    })));

    // Bob 用自己的 box 私钥 + Alice 的 box 公钥派生共享密钥，加密一条消息发过来
    const sharedKey = deriveSharedKey(bobBox.secretKey, aliceBox.publicKey);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify({
      targetNodeId: alice.nodeId,
      type: 'message',
      body: { text: 'hi from bob' },
    }));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);

    const received: Array<{ from: string; text: string }> = [];
    t.onMessage((msg) => received.push({ from: msg.fromNodeId, text: (msg.payload.body as { text: string }).text }));

    // 模拟 hub deliver
    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'deliver',
      from: 'node_bob',
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    })));

    expect(received.length).toBe(1);
    expect(received[0].from).toBe('node_bob');
    expect(received[0].text).toBe('hi from bob');

    await t.stop();
  });

  it('安全修复回归锁：未信任节点的 deliver 直接丢弃（即使 presence 已学得其 box 公钥）', async () => {
    const alice = generateIdentity('Alice');
    const aliceBox = nacl.box.keyPair();
    const bobBox = nacl.box.keyPair();
    const t = new HubTransport({
      identity: alice,
      boxKeyPair: aliceBox,
      hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      trustStore: { getBoxPublicKey: () => null }, // Bob 未在信任列表
    });
    await t.start();

    const conn = mockInstances()[0];
    // presence 学到 Bob 的 box 公钥（修复后仅展示用，不参与解密决策）
    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'presence',
      nodes: [{ nodeId: 'node_bob', displayName: 'Bob', boxPublicKey: Buffer.from(bobBox.publicKey).toString('base64') }],
    })));

    // Bob 正常加密的消息
    const sharedKey = deriveSharedKey(bobBox.secretKey, aliceBox.publicKey);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify({
      targetNodeId: alice.nodeId,
      type: 'message',
      body: { text: 'hi' },
    }));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);

    const received: unknown[] = [];
    t.onMessage((msg) => received.push(msg));

    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'deliver',
      from: 'node_bob',
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    })));

    expect(received.length).toBe(0);

    await t.stop();
  });

  it('安全修复回归锁：恶意 hub 把受害者 nodeId 映射到攻击者 box 公钥 → 解密失败丢弃', async () => {
    const alice = generateIdentity('Alice');
    const aliceBox = nacl.box.keyPair();
    const victimBox = nacl.box.keyPair(); // 受害者 Bob 真实的 box 密钥（Alice 信任）
    const attackerBox = nacl.box.keyPair(); // 攻击者的 box 密钥（hub 换 key 用）
    const t = new HubTransport({
      identity: alice,
      boxKeyPair: aliceBox,
      hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      // Alice 信任的是 Bob 的真实 box 公钥
      trustStore: {
        getBoxPublicKey: (nodeId: string) =>
          nodeId === 'node_bob' ? victimBox.publicKey : null,
      },
    });
    await t.start();

    const conn = mockInstances()[0];
    // 恶意 hub：presence 声称 node_bob 的 box 公钥是攻击者的
    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'presence',
      nodes: [{ nodeId: 'node_bob', displayName: 'Bob(被冒充)', boxPublicKey: Buffer.from(attackerBox.publicKey).toString('base64') }],
    })));

    // 攻击者用（hub 声称的）自己的 box 私钥加密——修复前会用 presence 学到的
    // 攻击者公钥解密成功并冒充 Bob；修复后用信任库的受害者公钥解密必然失败
    const sharedKey = deriveSharedKey(attackerBox.secretKey, aliceBox.publicKey);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify({
      targetNodeId: alice.nodeId,
      type: 'message',
      body: { text: '伪造的 Bob 消息' },
    }));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);

    const received: unknown[] = [];
    t.onMessage((msg) => received.push(msg));

    conn.emit('message', Buffer.from(JSON.stringify({
      type: 'deliver',
      from: 'node_bob',
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    })));

    expect(received.length).toBe(0);

    await t.stop();
  });
});
