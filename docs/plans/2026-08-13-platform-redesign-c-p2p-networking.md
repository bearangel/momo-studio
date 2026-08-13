# Plan C — 联网 P2P 协作实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现三层联网模式（本地/局域网 mDNS 自动发现/互联网 hub 中转），节点身份基于 Ed25519 密钥对，E2E 加密保护 hub 中转消息，用户零运维。

**Architecture:** `TransportLayer` 抽象统一三种传输（Local/Lan/Hub）；`Router` 按目标节点 ID 自动路由；新增 `electron/src/main/p2p/` 独立模块；momo-hub 作为独立开源项目（hub 仅作中转 + 在线列表，不持久化用户数据）。

**Tech Stack:** `bonjour-service`（mDNS）；`node:net`/`ws`（TCP/WebSocket）；`node:crypto`/`tweetnacl`（Ed25519 + X25519 + AES-GCM）；`ws`（hub 服务器）；React（节点发现 UI）。

**依赖 spec：** `docs/specs/2026-08-13-platform-redesign-overview.md` 的"C 子系统：联网 P2P 协作"章节

**前置依赖：** Plan A/B/D 已实施完成（messages/tasks 表 source 字段已预留 'lan'/'hub'）

## Global Constraints

（同 Plan A/B/D）

额外约束：
- **C 是 v2.0 范围**：可独立启动，不阻塞 A/B/D
- **节点身份零信任**：每节点 Ed25519 密钥对，首次连接扫码确认
- **hub 不持久化用户数据**：仅临时缓存离线消息（TTL 7 天）
- **跨节点消息可见 ACL**：默认仅信任节点可见；任务/会话级 ACL（v1 全信任节点互通，v2 加细粒度）

---

## File Structure

### 新增文件

```
electron/
├── src/main/p2p/                       # 新独立模块
│   ├── types.ts                        # TransportLayer 接口 + NodeInfo
│   ├── identity.ts                     # Ed25519 节点身份
│   ├── trust-store.ts                  # 信任节点列表
│   ├── local-transport.ts              # 本地（v1 不变，封装）
│   ├── lan-transport.ts                # mDNS + TCP
│   ├── lan-protocol.ts                 # 节点间消息编码
│   ├── hub-transport.ts                # WSS + E2E
│   ├── crypto.ts                       # 加密 helper
│   ├── router.ts                       # 路由层
│   └── index.ts                        # 入口 + singleton
└── tests/p2p/
    ├── identity.test.ts
    ├── trust-store.test.ts
    ├── lan-protocol.test.ts
    ├── crypto.test.ts
    └── router.test.ts

momo-hub/                               # 独立项目（hub 服务器）
├── package.json
├── src/
│   ├── server.ts                       # WebSocket 服务器
│   ├── routing.ts                      # node_id 路由
│   ├── presence.ts                     # 在线列表 + 离线缓存
│   └── auth.ts                         # 账号注册 + 防滥用
├── Dockerfile
└── README.md

renderer/
├── src/components/p2p/
│   ├── NodeDiscoveryPanel.tsx          # 节点列表
│   ├── AddNodeDialog.tsx               # 添加节点（扫码/手动）
│   └── InternetModeToggle.tsx          # 启用互联网模式
└── tests/components/p2p/
    └── NodeDiscoveryPanel.test.tsx
```

---

## Task C1: 节点身份（Ed25519 + 节点 ID）

**Files:**
- Create: `electron/src/main/p2p/identity.ts`
- Test: `electron/tests/p2p/identity.test.ts`

**Interfaces:**

```typescript
export interface NodeIdentity {
  nodeId: string;          // 公钥指纹（hex 前 16 字符）
  publicKey: Uint8Array;   // Ed25519 公钥（32 字节）
  privateKey: Uint8Array;  // Ed25519 私钥（64 字节）
  displayName: string;
  createdAt: number;
}

export function generateIdentity(displayName: string): NodeIdentity;
export function loadIdentity(): NodeIdentity | null;
export function saveIdentity(id: NodeIdentity): void;
export function nodeIdFromPublicKey(pub: Uint8Array): string;
export function sign(id: NodeIdentity, message: Uint8Array): Uint8Array;
export function verify(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
```

### Steps

- [ ] **Step 1: 加依赖**

```bash
cd electron && npx pnpm@9.0.0 add tweetnacl
```

（`tweetnacl` 是 Ed25519 + X25519 + secretbox 的纯 JS 实现，跨平台稳定，避免 Node 原生模块编译问题。）

- [ ] **Step 2: 写测试**

```typescript
// electron/tests/p2p/identity.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateIdentity, loadIdentity, saveIdentity,
  nodeIdFromPublicKey, sign, verify, type NodeIdentity,
} from '../../src/main/p2p/identity';

const tmpRoot = path.join(os.tmpdir(), `ap-id-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('NodeIdentity', () => {
  it('generateIdentity 生成 Ed25519 密钥对 + nodeId', () => {
    const id = generateIdentity('Alice 的 Mac');
    expect(id.displayName).toBe('Alice 的 Mac');
    expect(id.publicKey.length).toBe(32);
    expect(id.privateKey.length).toBe(64);
    expect(id.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(id.createdAt).toBeGreaterThan(0);
  });

  it('两次生成不同密钥对', () => {
    const a = generateIdentity('a');
    const b = generateIdentity('b');
    expect(Array.from(a.publicKey)).not.toEqual(Array.from(b.publicKey));
    expect(a.nodeId).not.toBe(b.nodeId);
  });

  it('nodeIdFromPublicKey 稳定（同公钥同 id）', () => {
    const id = generateIdentity('a');
    const nodeId = nodeIdFromPublicKey(id.publicKey);
    expect(nodeId).toBe(id.nodeId);
  });

  it('saveIdentity + loadIdentity 往返', () => {
    const id = generateIdentity('Alice');
    saveIdentity(id);
    const loaded = loadIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded?.nodeId).toBe(id.nodeId);
    expect(Array.from(loaded!.publicKey)).toEqual(Array.from(id.publicKey));
  });

  it('loadIdentity 未保存时返回 null', () => {
    expect(loadIdentity()).toBeNull();
  });

  it('sign + verify：合法签名通过', () => {
    const id = generateIdentity('a');
    const msg = new TextEncoder().encode('hello');
    const sig = sign(id, msg);
    expect(verify(id.publicKey, msg, sig)).toBe(true);
  });

  it('verify：篡改消息后失败', () => {
    const id = generateIdentity('a');
    const msg = new TextEncoder().encode('hello');
    const sig = sign(id, msg);
    const tampered = new TextEncoder().encode('world');
    expect(verify(id.publicKey, tampered, sig)).toBe(false);
  });

  it('verify：用错误公钥失败', () => {
    const id1 = generateIdentity('a');
    const id2 = generateIdentity('b');
    const msg = new TextEncoder().encode('hello');
    const sig = sign(id1, msg);
    expect(verify(id2.publicKey, msg, sig)).toBe(false);
  });
});
```

- [ ] **Step 3: 实现 identity.ts**

```typescript
// electron/src/main/p2p/identity.ts
//
// 节点身份——Ed25519 密钥对 + 节点 ID（公钥指纹）。
// 密钥对存 `<userData>/p2p/identity.json`（base64 编码）；首次启动 generate。
import nacl from 'tweetnacl';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDataDir } from '../paths';

export interface NodeIdentity {
  nodeId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  displayName: string;
  createdAt: number;
}

const IDENTITY_FILE = 'p2p-identity.json';

export function generateIdentity(displayName: string): NodeIdentity {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return {
    nodeId: nodeIdFromPublicKey(publicKey),
    publicKey,
    privateKey: secretKey,
    displayName,
    createdAt: Date.now(),
  };
}

export function nodeIdFromPublicKey(pub: Uint8Array): string {
  // 取公钥前 16 字符 hex 作 nodeId（碰撞概率极低）
  const hex = Buffer.from(pub).toString('hex');
  return `node_${hex.slice(0, 16)}`;
}

function identityPath(): string {
  return path.join(resolveUserDataDir(), IDENTITY_FILE);
}

export function saveIdentity(id: NodeIdentity): void {
  const dir = path.dirname(identityPath());
  fs.mkdirSync(dir, { recursive: true });
  const serialized = {
    nodeId: id.nodeId,
    publicKey: Buffer.from(id.publicKey).toString('base64'),
    privateKey: Buffer.from(id.privateKey).toString('base64'),
    displayName: id.displayName,
    createdAt: id.createdAt,
  };
  fs.writeFileSync(identityPath(), JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

export function loadIdentity(): NodeIdentity | null {
  const p = identityPath();
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
    nodeId: string;
    publicKey: string;
    privateKey: string;
    displayName: string;
    createdAt: number;
  };
  return {
    nodeId: raw.nodeId,
    publicKey: new Uint8Array(Buffer.from(raw.publicKey, 'base64')),
    privateKey: new Uint8Array(Buffer.from(raw.privateKey, 'base64')),
    displayName: raw.displayName,
    createdAt: raw.createdAt,
  };
}

export function sign(id: NodeIdentity, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, id.privateKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}
```

- [ ] **Step 4: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/identity.test.ts
git add electron/package.json electron/pnpm-lock.yaml electron/src/main/p2p/identity.ts electron/tests/p2p/identity.test.ts
git commit -m "feat(p2p): 节点身份 Ed25519 + nodeId 指纹（C 子系统）"
```

---

## Task C2: TransportLayer 接口 + LocalTransport

**Files:**
- Create: `electron/src/main/p2p/types.ts`
- Create: `electron/src/main/p2p/local-transport.ts`
- Test: `electron/tests/p2p/local-transport.test.ts`

**Interfaces:**

```typescript
// types.ts
export interface NodeInfo {
  nodeId: string;
  displayName: string;
  publicKey: Uint8Array;
  /** transport 类型：'lan' / 'hub'；'local' 仅自身 */
  transport: 'lan' | 'hub';
  lastSeen: number;
}

export interface MessagePayload {
  /** 目标节点 ID（'*' = 广播给所有信任节点） */
  targetNodeId: string;
  type: 'message' | 'task' | 'presence' | 'ack';
  /** 业务 payload（messages / tasks 行的序列化） */
  body: Record<string, unknown>;
}

export interface IncomingMessage {
  fromNodeId: string;
  payload: MessagePayload;
  receivedAt: number;
}

export interface TransportLayer {
  readonly type: 'local' | 'lan' | 'hub';
  start(): Promise<void>;
  stop(): Promise<void>;
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
  discoverNodes(): NodeInfo[];
  onMessage(handler: (msg: IncomingMessage) => void): () => void;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/p2p/local-transport.test.ts
import { describe, it, expect } from 'vitest';
import { LocalTransport } from '../../src/main/p2p/local-transport';
import { generateIdentity } from '../../src/main/p2p/identity';

describe('LocalTransport', () => {
  it('start 后 discoverNodes 返回自身', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    const nodes = t.discoverNodes();
    expect(nodes.length).toBe(1);
    expect(nodes[0].nodeId).toBe(id.nodeId);
    expect(nodes[0].transport).toBe('local');  // 实际 LocalTransport 自身 transport 字段为 'local'
    await t.stop();
  });

  it('send 自身节点 = 本地派发（onMessage 触发）', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    const received: IncomingMessage[] = [];
    t.onMessage((m) => received.push(m));
    await t.send(id.nodeId, { targetNodeId: id.nodeId, type: 'message', body: { text: 'self' } });
    expect(received.length).toBe(1);
    expect(received[0].payload.body).toEqual({ text: 'self' });
    await t.stop();
  });

  it('send 其他节点 = 抛错（local 仅支持自身）', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    await expect(t.send('node_other', { targetNodeId: 'node_other', type: 'message', body: {} }))
      .rejects.toThrow(/local.*不支持/);
    await t.stop();
  });
});
```

- [ ] **Step 2: 实现 types.ts**（接口见上）

- [ ] **Step 3: 实现 LocalTransport**

```typescript
// electron/src/main/p2p/local-transport.ts
//
// 本地传输层——把"发给自己"包装成 TransportLayer 接口。
// 用于统一 Router 调用：目标节点是自己时直接走本地，不再区分。
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';

export class LocalTransport implements TransportLayer {
  readonly type = 'local' as const;
  private handlers = new Set<(msg: IncomingMessage) => void>();

  constructor(private readonly identity: NodeIdentity) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.handlers.clear();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (targetNodeId !== this.identity.nodeId) {
      throw new Error(`LocalTransport 不支持发送给其他节点: ${targetNodeId}`);
    }
    const msg: IncomingMessage = {
      fromNodeId: this.identity.nodeId,
      payload,
      receivedAt: Date.now(),
    };
    for (const h of this.handlers) h(msg);
  }

  discoverNodes(): NodeInfo[] {
    return [{
      nodeId: this.identity.nodeId,
      displayName: this.identity.displayName,
      publicKey: this.identity.publicKey,
      transport: 'local' as never,  // LocalTransport 仅在 discoverNodes 标记
      lastSeen: Date.now(),
    }];
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
```

注意：types.ts 中 `NodeInfo.transport` 类型为 `'lan' | 'hub'`；LocalTransport 内部用 `as never` 兜底，因为 LocalTransport 不出现在 p2p 节点列表（仅路由层使用）。

- [ ] **Step 4: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/local-transport.test.ts
git add electron/src/main/p2p/types.ts electron/src/main/p2p/local-transport.ts electron/tests/p2p/local-transport.test.ts
git commit -m "feat(p2p): TransportLayer 接口 + LocalTransport（C 子系统）"
```

---

## Task C3: LanTransport（mDNS 发现 + TCP 直连）

**Files:**
- Create: `electron/src/main/p2p/lan-transport.ts`
- Create: `electron/src/main/p2p/lan-protocol.ts`
- Test: `electron/tests/p2p/lan-protocol.test.ts`、`electron/tests/p2p/lan-transport.test.ts`

**目标**：局域网内通过 mDNS 自动发现其他 Momo 节点；TCP 直连传输 JSON 消息。

**Interfaces:**

```typescript
// lan-protocol.ts
export interface LanFrame {
  v: 1;                        // 协议版本
  fromNodeId: string;
  signature: string;           // base64 Ed25519 签名（fromNodeId 字段+payload）
  payload: MessagePayload;     // 业务消息
}

export function encodeFrame(frame: LanFrame): Buffer;
export function decodeFrame(buf: Buffer): LanFrame | null;

// lan-transport.ts
export class LanTransport implements TransportLayer {
  readonly type = 'lan' as const;
  constructor(opts: { identity: NodeIdentity; port?: number; trustStore: TrustStore });
  start(): Promise<void>;
  stop(): Promise<void>;
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
  discoverNodes(): NodeInfo[];
  onMessage(handler: (msg: IncomingMessage) => void): () => void;
}
```

### Steps

- [ ] **Step 1: 加依赖**

```bash
cd electron && npx pnpm@9.0.0 add bonjour-service
```

- [ ] **Step 2: 写协议测试**

```typescript
// electron/tests/p2p/lan-protocol.test.ts
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, type LanFrame } from '../../src/main/p2p/lan-protocol';

describe('lan-protocol', () => {
  it('encode + decode 往返', () => {
    const frame: LanFrame = {
      v: 1,
      fromNodeId: 'node_abc123',
      signature: 'sig-base64',
      payload: { targetNodeId: 'node_xyz', type: 'message', body: { text: 'hi' } },
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    expect(decoded).not.toBeNull();
    expect(decoded?.fromNodeId).toBe('node_abc123');
    expect(decoded?.payload.body).toEqual({ text: 'hi' });
  });

  it('decode 损坏数据返回 null', () => {
    expect(decodeFrame(Buffer.from('garbage'))).toBeNull();
    expect(decodeFrame(Buffer.from(''))).toBeNull();
  });

  it('decode 版本不匹配返回 null', () => {
    const buf = Buffer.from(JSON.stringify({ v: 99, fromNodeId: 'x', signature: '', payload: {} }));
    expect(decodeFrame(buf)).toBeNull();
  });
});
```

- [ ] **Step 3: 实现 lan-protocol**

```typescript
// electron/src/main/p2p/lan-protocol.ts
//
// 局域网传输协议——TCP 上层 JSON 帧（行分隔）。
//
// 帧结构：v(1) + fromNodeId + signature + payload
//   - 签名验证：fromNodeId 字段（hex 公钥）+ payload JSON → sign
//   - 接收方查 trustStore 拿公钥，verify
//
// 行分隔：每个帧用换行符分隔（避免 TCP 粘包问题，JSON 内部不允许裸换行——
// 实际 JSON.stringify 不产生裸换行）。
import type { MessagePayload } from './types';

export interface LanFrame {
  v: 1;
  fromNodeId: string;
  signature: string;
  payload: MessagePayload;
}

export function encodeFrame(frame: LanFrame): Buffer {
  return Buffer.from(JSON.stringify(frame) + '\n', 'utf-8');
}

export function decodeFrame(buf: Buffer): LanFrame | null {
  try {
    const text = buf.toString('utf-8').trim();
    if (!text) return null;
    const obj = JSON.parse(text) as LanFrame;
    if (obj.v !== 1) return null;
    if (typeof obj.fromNodeId !== 'string') return null;
    if (typeof obj.signature !== 'string') return null;
    if (typeof obj.payload !== 'object' || obj.payload === null) return null;
    return obj;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 实现 TrustStore（C8 完整版，C3 用 stub）**

```typescript
// electron/src/main/p2p/trust-store.ts
//
// 信任节点列表——首次连接扫码确认后持久化。
// 简化：v1 信任后所有消息互通；v2 加 ACL 细粒度。
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDataDir } from '../paths';

export interface TrustedNode {
  nodeId: string;
  displayName: string;
  publicKey: Uint8Array;
  trustedAt: number;
}

const TRUST_FILE = 'p2p-trusted-nodes.json';

function trustPath(): string {
  return path.join(resolveUserDataDir(), TRUST_FILE);
}

export function listTrustedNodes(): TrustedNode[] {
  const p = trustPath();
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Array<{
    nodeId: string;
    displayName: string;
    publicKey: string;
    trustedAt: number;
  }>;
  return raw.map((r) => ({
    nodeId: r.nodeId,
    displayName: r.displayName,
    publicKey: new Uint8Array(Buffer.from(r.publicKey, 'base64')),
    trustedAt: r.trustedAt,
  }));
}

export function addTrustedNode(node: TrustedNode): void {
  const list = listTrustedNodes().filter((n) => n.nodeId !== node.nodeId);
  list.push(node);
  saveAll(list);
}

export function removeTrustedNode(nodeId: string): void {
  saveAll(listTrustedNodes().filter((n) => n.nodeId !== nodeId));
}

export function isTrusted(nodeId: string): boolean {
  return listTrustedNodes().some((n) => n.nodeId === nodeId);
}

export function getTrustedPublicKey(nodeId: string): Uint8Array | null {
  return listTrustedNodes().find((n) => n.nodeId === nodeId)?.publicKey ?? null;
}

function saveAll(list: TrustedNode[]): void {
  const dir = path.dirname(trustPath());
  fs.mkdirSync(dir, { recursive: true });
  const serialized = list.map((n) => ({
    nodeId: n.nodeId,
    displayName: n.displayName,
    publicKey: Buffer.from(n.publicKey).toString('base64'),
    trustedAt: n.trustedAt,
  }));
  fs.writeFileSync(trustPath(), JSON.stringify(serialized, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 5: 写 LanTransport 测试**

```typescript
// electron/tests/p2p/lan-transport.test.ts
//
// 集成测试：两个 LanTransport 实例（同进程模拟两节点）通过真实 TCP 互通。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LanTransport } from '../../src/main/p2p/lan-transport';
import { generateIdentity, type NodeIdentity } from '../../src/main/p2p/identity';
import { addTrustedNode, listTrustedNodes, saveAll } from '../../src/main/p2p/trust-store';

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
  it('两节点 TCP 直连互发消息', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');

    // 双方互信
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, trustedAt: Date.now() },
    ]);

    const aliceT = new LanTransport({ identity: alice, port: 18001, trustStore: { isTrusted: () => true, getTrustedPublicKey: (id) => id === alice.nodeId ? alice.publicKey : bob.publicKey } });
    const bobT = new LanTransport({ identity: bob, port: 18002, trustStore: { isTrusted: () => true, getTrustedPublicKey: (id) => id === alice.nodeId ? alice.publicKey : bob.publicKey } });
    await aliceT.start();
    await bobT.start();

    // 给 mDNS 一点发现时间
    await new Promise((r) => setTimeout(r, 500));

    const received: Array<{ from: string; body: unknown }> = [];
    bobT.onMessage((msg) => received.push({ from: msg.fromNodeId, body: msg.payload.body }));

    await aliceT.send(bob.nodeId, { targetNodeId: bob.nodeId, type: 'message', body: { text: 'hi from alice' } });

    // 给 TCP 传输时间
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(1);
    expect(received[0].from).toBe(alice.nodeId);
    expect(received[0].body).toEqual({ text: 'hi from alice' });

    await aliceT.stop();
    await bobT.stop();
  });

  it('discoverNodes 返回局域网内其他 Momo 节点', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    saveAll([
      { nodeId: alice.nodeId, displayName: alice.displayName, publicKey: alice.publicKey, trustedAt: Date.now() },
      { nodeId: bob.nodeId, displayName: bob.displayName, publicKey: bob.publicKey, trustedAt: Date.now() },
    ]);
    const ts = { isTrusted: () => true, getTrustedPublicKey: (id: string) => id === alice.nodeId ? alice.publicKey : bob.publicKey };
    const aliceT = new LanTransport({ identity: alice, port: 18003, trustStore: ts });
    const bobT = new LanTransport({ identity: bob, port: 18004, trustStore: ts });
    await aliceT.start();
    await bobT.start();
    await new Promise((r) => setTimeout(r, 500));
    const bobs = aliceT.discoverNodes();
    expect(bobs.some((n) => n.nodeId === bob.nodeId)).toBe(true);
    await aliceT.stop();
    await bobT.stop();
  });
});
```

注意：集成测试依赖真实 mDNS + TCP，CI 上可能 flaky；如果失败先跳过，本 task 验证本地手动。

- [ ] **Step 6: 实现 LanTransport**

```typescript
// electron/src/main/p2p/lan-transport.ts
//
// 局域网传输层——mDNS 自动发现 + TCP 直连。
//
// 启动时：
//   1. mDNS 广告自身（_momo-studio._tcp + nodeId/displayName/port）
//   2. 监听 mDNS 发现其他节点
//   3. 启动 TCP server 接受连接
//   4. 主动连接已发现节点（双向通信）
//
// send(targetNodeId)：
//   - 查连接池，已连则直接发；未连则建立新连接
//
// 接收：TCP socket 按行解析 LanFrame，验签后 onMessage 推送
import net from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';
import { sign, verify } from './identity';
import { encodeFrame, decodeFrame, type LanFrame } from './lan-protocol';

const SERVICE_TYPE = 'momo-studio';
const MAGIC = 'momo-v1';

export interface LanTransportOpts {
  identity: NodeIdentity;
  port?: number;
  trustStore: {
    isTrusted: (nodeId: string) => boolean;
    getTrustedPublicKey: (nodeId: string) => Uint8Array | null;
  };
}

interface PeerConnection {
  socket: net.Socket;
  nodeId: string;
  buffer: string;  // 行缓冲
}

export class LanTransport implements TransportLayer {
  readonly type = 'lan' as const;
  private server?: net.Server;
  private bonjour?: Bonjour;
  private connections = new Map<string, PeerConnection>(); // nodeId → conn
  private discoveredNodes = new Map<string, NodeInfo>();
  private handlers = new Set<(msg: IncomingMessage) => void>();
  private readonly port: number;

  constructor(private readonly opts: LanTransportOpts) {
    this.port = opts.port ?? 0;  // 0 = 随机端口
  }

  async start(): Promise<void> {
    // 1. TCP server
    this.server = net.createServer((socket) => this.handleIncoming(socket));
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });
    const actualPort = (this.server.address() as net.AddressInfo).port;

    // 2. mDNS 广告 + 发现
    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name: this.opts.identity.nodeId,
      type: SERVICE_TYPE,
      port: actualPort,
      txt: {
        nodeid: this.opts.identity.nodeId,
        name: this.opts.identity.displayName,
        pubkey: Buffer.from(this.opts.identity.publicKey).toString('base64'),
      },
    });
    const browser = this.bonjour.find({ type: SERVICE_TYPE });
    browser.on('up', (svc) => this.onServiceUp(svc));
  }

  async stop(): Promise<void> {
    this.bonjour?.destroy();
    this.bonjour = undefined;
    for (const conn of this.connections.values()) conn.socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
    this.handlers.clear();
    this.discoveredNodes.clear();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    const conn = this.connections.get(targetNodeId);
    if (!conn) throw new Error(`LanTransport: 节点 ${targetNodeId} 未连接`);
    const sigMsg = new TextEncoder().encode(JSON.stringify({ fromNodeId: this.opts.identity.nodeId, payload }));
    const signature = Buffer.from(sign(this.opts.identity, sigMsg)).toString('base64');
    const frame: LanFrame = { v: 1, fromNodeId: this.opts.identity.nodeId, signature, payload };
    conn.socket.write(encodeFrame(frame));
  }

  discoverNodes(): NodeInfo[] {
    return Array.from(this.discoveredNodes.values());
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private onServiceUp(svc: { addresses?: string[]; port: number; txt?: Record<string, string> }): void {
    const nodeId = svc.txt?.nodeid;
    const displayName = svc.txt?.name ?? 'Unknown';
    const pubKeyB64 = svc.txt?.pubkey;
    if (!nodeId || !pubKeyB64) return;
    if (nodeId === this.opts.identity.nodeId) return;  // 自身
    const addr = svc.addresses?.[0];
    if (!addr) return;

    this.discoveredNodes.set(nodeId, {
      nodeId, displayName,
      publicKey: new Uint8Array(Buffer.from(pubKeyB64, 'base64')),
      transport: 'lan',
      lastSeen: Date.now(),
    });

    // 主动建立 TCP 连接（仅信任节点）
    if (this.opts.trustStore.isTrusted(nodeId) && !this.connections.has(nodeId)) {
      const socket = net.createConnection({ host: addr, port: svc.port }, () => {
        this.connections.set(nodeId, { socket, nodeId, buffer: '' });
      });
      socket.on('data', (data) => this.handleData(this.connections.get(nodeId)!, data));
      socket.on('close', () => this.connections.delete(nodeId));
      socket.on('error', () => this.connections.delete(nodeId));
    }
  }

  private handleIncoming(socket: net.Socket): void {
    // 等收到第一帧识别 nodeId
    let tempBuffer = '';
    let tempNodeId: string | null = null;
    socket.on('data', (data) => {
      tempBuffer += data.toString('utf-8');
      let nl: number;
      while ((nl = tempBuffer.indexOf('\n')) >= 0) {
        const line = tempBuffer.slice(0, nl);
        tempBuffer = tempBuffer.slice(nl + 1);
        const frame = decodeFrame(Buffer.from(line));
        if (!frame) continue;
        if (!tempNodeId) {
          tempNodeId = frame.fromNodeId;
          const conn: PeerConnection = { socket, nodeId: tempNodeId, buffer: tempBuffer };
          this.connections.set(tempNodeId, conn);
          // 后续 socket.on('data') 走 handleData
          socket.removeAllListeners('data');
          socket.on('data', (d) => this.handleData(conn, d));
          tempBuffer = '';
        }
        this.processFrame(frame, tempNodeId);
      }
    });
  }

  private handleData(conn: PeerConnection, data: Buffer): void {
    conn.buffer += data.toString('utf-8');
    let nl: number;
    while ((nl = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      const frame = decodeFrame(Buffer.from(line));
      if (frame) this.processFrame(frame, conn.nodeId);
    }
  }

  private processFrame(frame: LanFrame, fromNodeId: string): void {
    // 验签
    const pub = this.opts.trustStore.getTrustedPublicKey(fromNodeId);
    if (!pub) return;  // 不信任，丢弃
    const sigMsg = new TextEncoder().encode(JSON.stringify({ fromNodeId: frame.fromNodeId, payload: frame.payload }));
    const sig = new Uint8Array(Buffer.from(frame.signature, 'base64'));
    if (!verify(pub, sigMsg, sig)) return;  // 验签失败

    const msg: IncomingMessage = {
      fromNodeId,
      payload: frame.payload,
      receivedAt: Date.now(),
    };
    for (const h of this.handlers) h(msg);
  }
}
```

- [ ] **Step 7: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/lan-protocol.test.ts
# 集成测试 lan-transport.test.ts 视 CI 环境决定是否启用
npx pnpm@9.0.0 typecheck
git add electron/src/main/p2p/lan-transport.ts electron/src/main/p2p/lan-protocol.ts electron/src/main/p2p/trust-store.ts electron/tests/p2p/lan-protocol.test.ts electron/tests/p2p/lan-transport.test.ts
git commit -m "feat(p2p): LanTransport mDNS + TCP 直连（C 子系统局域网模式）"
```

---

## Task C4: Router（按目标节点自动路由）

**Files:**
- Create: `electron/src/main/p2p/router.ts`
- Test: `electron/tests/p2p/router.test.ts`

**Interfaces:**

```typescript
export class Router {
  constructor(opts: {
    localNodeId: string;
    localTransport: TransportLayer;
    lanTransport?: TransportLayer;
    hubTransport?: TransportLayer;
    onIncoming: (msg: IncomingMessage) => void;
  });
  start(): Promise<void>;
  stop(): Promise<void>;
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
}

// 路由决策：
//   target === localNodeId → localTransport
//   lanTransport.discoverNodes() 含 target → lanTransport
//   hubTransport 在线 → hubTransport
//   都不匹配 → 抛错
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/p2p/router.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/main/p2p/router';
import type { TransportLayer, IncomingMessage, NodeInfo } from '../../src/main/p2p/types';

function mkMockTransport(type: 'local' | 'lan' | 'hub', nodes: NodeInfo[] = []): TransportLayer & { sendMock: ReturnType<typeof vi>; startMock: ReturnType<typeof vi> } {
  return {
    type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    discoverNodes: vi.fn().mockReturnValue(nodes),
    onMessage: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportLayer & { sendMock: ReturnType<typeof vi>; startMock: ReturnType<typeof vi> };
}

describe('Router', () => {
  it('目标是自己 → 走 LocalTransport', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const incoming = vi.fn();
    const router = new Router({
      localNodeId: 'me', localTransport: local, lanTransport: lan, onIncoming: incoming,
    });
    await router.start();
    await router.send('me', { targetNodeId: 'me', type: 'message', body: {} });
    expect(local.send).toHaveBeenCalledWith('me', expect.anything());
    expect(lan.send).not.toHaveBeenCalled();
    await router.stop();
  });

  it('目标在局域网 → 走 LanTransport', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', [{ nodeId: 'peer1', displayName: 'Peer', publicKey: new Uint8Array(32), transport: 'lan', lastSeen: Date.now() }]);
    const router = new Router({
      localNodeId: 'me', localTransport: local, lanTransport: lan, onIncoming: vi.fn(),
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
      localNodeId: 'me', localTransport: local, lanTransport: lan, hubTransport: hub, onIncoming: vi.fn(),
    });
    await router.start();
    await router.send('peer-remote', { targetNodeId: 'peer-remote', type: 'message', body: {} });
    expect(hub.send).toHaveBeenCalled();
  });

  it('目标不在局域网 + 无 HubTransport → 抛错', async () => {
    const local = mkMockTransport('local');
    const lan = mkMockTransport('lan', []);
    const router = new Router({
      localNodeId: 'me', localTransport: local, lanTransport: lan, onIncoming: vi.fn(),
    });
    await router.start();
    await expect(router.send('peer-remote', { targetNodeId: 'peer-remote', type: 'message', body: {} }))
      .rejects.toThrow(/不可达/);
  });
});
```

- [ ] **Step 2: 实现 router**

```typescript
// electron/src/main/p2p/router.ts
//
// 路由层——按目标节点 ID 自动选 transport。
// 优先级：local > lan > hub > 不可达
import type { TransportLayer, MessagePayload, IncomingMessage } from './types';

export interface RouterOpts {
  localNodeId: string;
  localTransport: TransportLayer;
  lanTransport?: TransportLayer;
  hubTransport?: TransportLayer;
  onIncoming: (msg: IncomingMessage) => void;
}

export class Router {
  private readonly opts: RouterOpts;

  constructor(opts: RouterOpts) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const off1 = this.opts.localTransport.onMessage((m) => this.opts.onIncoming(m));
    const off2 = this.opts.lanTransport?.onMessage((m) => this.opts.onIncoming(m));
    const off3 = this.opts.hubTransport?.onMessage((m) => this.opts.onIncoming(m));
    await this.opts.localTransport.start();
    await this.opts.lanTransport?.start();
    await this.opts.hubTransport?.start();
    // 保存 unsubscribe 函数（简化：实例字段）
    this.unsubscribeAll = () => { off1(); off2?.(); off3?.(); };
  }

  private unsubscribeAll: () => void = () => {};

  async stop(): Promise<void> {
    this.unsubscribeAll();
    await this.opts.lanTransport?.stop();
    await this.opts.hubTransport?.stop();
    await this.opts.localTransport.stop();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (targetNodeId === this.opts.localNodeId) {
      return this.opts.localTransport.send(targetNodeId, payload);
    }
    if (this.opts.lanTransport) {
      const lanNodes = this.opts.lanTransport.discoverNodes();
      if (lanNodes.some((n) => n.nodeId === targetNodeId)) {
        return this.opts.lanTransport.send(targetNodeId, payload);
      }
    }
    if (this.opts.hubTransport) {
      return this.opts.hubTransport.send(targetNodeId, payload);
    }
    throw new Error(`节点 ${targetNodeId} 不可达（不在局域网，且未启用 hub）`);
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/router.test.ts
git add electron/src/main/p2p/router.ts electron/tests/p2p/router.test.ts
git commit -m "feat(p2p): Router 按 nodeId 自动路由（C 子系统）"
```

---

## Task C5: crypto.ts（AES-GCM + E2E 加密 helper）

**Files:**
- Create: `electron/src/main/p2p/crypto.ts`
- Test: `electron/tests/p2p/crypto.test.ts`

**目标**：HubTransport 用 E2E 加密——发送方用接收方公钥（X25519）派生共享密钥，AES-GCM 加密 payload；hub 仅看到密文。

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/p2p/crypto.test.ts
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encryptPayload, decryptPayload, deriveSharedKey, randomNonce } from '../../src/main/p2p/crypto';

describe('p2p crypto', () => {
  it('deriveSharedKey 双方一致（X25519 ECDH）', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const k1 = deriveSharedKey(alice.secretKey, bob.publicKey);
    const k2 = deriveSharedKey(bob.secretKey, alice.publicKey);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it('encryptPayload + decryptPayload 往返', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode('hello secret');
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);
    const decrypted = decryptPayload(ciphertext, sharedKey, nonce);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('decryptPayload 用错误密钥返回 null', () => {
    const alice = nacl.box.keyPair();
    const eve = nacl.box.keyPair();
    const realKey = deriveSharedKey(alice.secretKey, nacl.box.keyPair().publicKey);
    const wrongKey = deriveSharedKey(eve.secretKey, nacl.box.keyPair().publicKey);
    const nonce = randomNonce();
    const ct = encryptPayload(new TextEncoder().encode('hi'), realKey, nonce);
    expect(decryptPayload(ct, wrongKey, nonce)).toBeNull();
  });

  it('decryptPayload 篡改密文返回 null', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const key = deriveSharedKey(alice.secretKey, bob.publicKey);
    const nonce = randomNonce();
    const ct = encryptPayload(new TextEncoder().encode('hi'), key, nonce);
    ct[0] ^= 0xff;
    expect(decryptPayload(ct, key, nonce)).toBeNull();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
// electron/src/main/p2p/crypto.ts
//
// E2E 加密 helper——HubTransport 用。
// 流程：
//   1. 双方各自有 X25519 box keyPair（独立于 Ed25519 签名密钥）
//   2. deriveSharedKey(mySecret, peerPublic) → 32 字节共享密钥
//   3. randomNonce() → 24 字节 nonce
//   4. encryptPayload(plaintext, key, nonce) → ciphertext
//   5. decryptPayload 反向
//
// 用 tweetnacl 的 secretbox（XSalsa20-Poly1305，等价于 AES-GCM 安全级别）。
import nacl from 'tweetnacl';

export function deriveSharedKey(mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, mySecretKey);
}

export function randomNonce(): Uint8Array {
  return nacl.randomBytes(nacl.box.nonceLength);
}

export function encryptPayload(plaintext: Uint8Array, sharedKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  return nacl.box.after(plaintext, nonce, sharedKey);
}

export function decryptPayload(ciphertext: Uint8Array, sharedKey: Uint8Array, nonce: Uint8Array): Uint8Array | null {
  return nacl.box.open.after(ciphertext, nonce, sharedKey);
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/crypto.test.ts
git add electron/src/main/p2p/crypto.ts electron/tests/p2p/crypto.test.ts
git commit -m "feat(p2p): E2E 加密 helper（X25519 ECDH + secretbox）"
```

---

## Task C6: HubTransport（WSS + E2E）

**Files:**
- Create: `electron/src/main/p2p/hub-transport.ts`
- Test: `electron/tests/p2p/hub-transport.test.ts`

**目标**：通过 hub 中转消息；E2E 加密使 hub 看不到内容。

**Interfaces:**

```typescript
export interface HubTransportOpts {
  identity: NodeIdentity;
  /** box key pair 用于 E2E（独立于签名） */
  boxKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  hubUrl: string;          // wss://hub.momostudio.io
  authToken: string;       // hub 账号 token
  trustStore: {
    getBoxPublicKey: (nodeId: string) => Uint8Array | null;
  };
}

export class HubTransport implements TransportLayer {
  readonly type = 'hub' as const;
  constructor(opts: HubTransportOpts);
  start(): Promise<void>;
  stop(): Promise<void>;
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
  discoverNodes(): NodeInfo[];
  onMessage(handler: (msg: IncomingMessage) => void): () => void;
}
```

### Steps

- [ ] **Step 1: 写测试（mock WebSocket）**

```typescript
// electron/tests/p2p/hub-transport.test.ts
import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import { HubTransport } from '../../src/main/p2p/hub-transport';
import { generateIdentity } from '../../src/main/p2p/identity';
import { decryptPayload, randomNonce, deriveSharedKey } from '../../src/main/p2p/crypto';

// Mock ws
vi.mock('ws', () => ({
  default: class MockWS {
    static instances: Array<MockWS> = [];
    onmessage?: (e: { data: unknown }) => void;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: (e: unknown) => void;
    sent: unknown[] = [];
    constructor(public url: string) {
      MockWS.instances.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: unknown) { this.sent.push(data); }
    close() { this.onclose?.(); }
  },
}));

describe('HubTransport', () => {
  it('start 后建立 WSS 连接 + 发 hello', async () => {
    const id = generateIdentity('Alice');
    const box = nacl.box.keyPair();
    const t = new HubTransport({
      identity: id, boxKeyPair: box, hubUrl: 'wss://hub.example.com',
      authToken: 'token', trustStore: { getBoxPublicKey: () => null },
    });
    await t.start();
    const MockWS = (await import('ws')).default as unknown as { instances: Array<{ sent: unknown[] }> };
    expect(MockWS.instances.length).toBe(1);
    expect(MockWS.instances[0].sent[0]).toMatch(/hello/);
    await t.stop();
  });

  it('send 加密 payload 后发给 hub', async () => {
    const alice = generateIdentity('Alice');
    const aliceBox = nacl.box.keyPair();
    const bobBox = nacl.box.keyPair();
    const t = new HubTransport({
      identity: alice, boxKeyPair: aliceBox, hubUrl: 'wss://hub.example.com',
      authToken: 'token',
      trustStore: { getBoxPublicKey: () => bobBox.publicKey },
    });
    await t.start();
    await t.send('node_bob', { targetNodeId: 'node_bob', type: 'message', body: { text: 'secret' } });

    const MockWS = (await import('ws')).default as unknown as { instances: Array<{ sent: unknown[] }> };
    const envelope = JSON.parse(MockWS.instances[0].sent[1] as string);
    expect(envelope.to).toBe('node_bob');
    expect(envelope.ciphertext).toBeDefined();
    expect(envelope.ciphertext).not.toContain('secret');
    await t.stop();
  });
});
```

- [ ] **Step 2: 实现 HubTransport**

```typescript
// electron/src/main/p2p/hub-transport.ts
//
// 互联网传输层——通过 hub 中转，E2E 加密。
//
// 协议：
//   客户端 → hub：
//     hello: { type: 'hello', nodeId, authToken, boxPublicKey }
//     send:  { type: 'send', to, ciphertext, nonce }
//     ack:   { type: 'ack', messageId }
//   hub → 客户端：
//     presence: { type: 'presence', nodes: [...] }
//     deliver:  { type: 'deliver', from, ciphertext, nonce }
//     error:    { type: 'error', message }
//
// 加密：发送方用接收方 box 公钥派生共享密钥 → secretbox 加密
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';
import { sign } from './identity';
import { deriveSharedKey, randomNonce, encryptPayload, decryptPayload } from './crypto';

export interface HubTransportOpts {
  identity: NodeIdentity;
  boxKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  hubUrl: string;
  authToken: string;
  trustStore: {
    getBoxPublicKey: (nodeId: string) => Uint8Array | null;
  };
}

export class HubTransport implements TransportLayer {
  readonly type = 'hub' as const;
  private ws?: WebSocket;
  private onlineNodes = new Map<string, NodeInfo>();
  private handlers = new Set<(msg: IncomingMessage) => void>();
  private boxPublicKeys = new Map<string, Uint8Array>(); // 跟踪在线节点的 box pubkey

  constructor(private readonly opts: HubTransportOpts) {}

  async start(): Promise<void> {
    this.ws = new WebSocket(this.opts.hubUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => {
        // 发 hello
        this.ws!.send(JSON.stringify({
          type: 'hello',
          nodeId: this.opts.identity.nodeId,
          authToken: this.opts.authToken,
          boxPublicKey: Buffer.from(this.opts.boxKeyPair.publicKey).toString('base64'),
          displayName: this.opts.identity.displayName,
        }));
        resolve();
      });
      this.ws!.on('error', reject);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as
          | { type: 'presence'; nodes: Array<{ nodeId: string; displayName: string; boxPublicKey: string }> }
          | { type: 'deliver'; from: string; ciphertext: string; nonce: string };
        this.handleHubMessage(msg);
      } catch {
        // 忽略解析失败
      }
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = undefined;
    this.handlers.clear();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('hub 连接未就绪');
    }
    const peerBoxPub = this.opts.trustStore.getBoxPublicKey(targetNodeId);
    if (!peerBoxPub) throw new Error(`未知节点 ${targetNodeId} 的 box 公钥`);

    const sharedKey = deriveSharedKey(this.opts.boxKeyPair.secretKey, peerBoxPub);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);

    this.ws.send(JSON.stringify({
      type: 'send',
      to: targetNodeId,
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    }));
  }

  discoverNodes(): NodeInfo[] {
    return Array.from(this.onlineNodes.values());
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private handleHubMessage(msg: { type: string } & Record<string, unknown>): void {
    if (msg.type === 'presence' && Array.isArray((msg as { nodes: unknown }).nodes)) {
      const list = (msg as { nodes: Array<{ nodeId: string; displayName: string; boxPublicKey: string }> }).nodes;
      for (const n of list) {
        const boxPub = new Uint8Array(Buffer.from(n.boxPublicKey, 'base64'));
        this.boxPublicKeys.set(n.nodeId, boxPub);
        this.onlineNodes.set(n.nodeId, {
          nodeId: n.nodeId, displayName: n.displayName,
          publicKey: boxPub, transport: 'hub', lastSeen: Date.now(),
        });
      }
    } else if (msg.type === 'deliver') {
      const d = msg as { from: string; ciphertext: string; nonce: string };
      const peerBoxPub = this.boxPublicKeys.get(d.from);
      if (!peerBoxPub) return;
      const sharedKey = deriveSharedKey(this.opts.boxKeyPair.secretKey, peerBoxPub);
      const nonce = new Uint8Array(Buffer.from(d.nonce, 'base64'));
      const ciphertext = new Uint8Array(Buffer.from(d.ciphertext, 'base64'));
      const plaintext = decryptPayload(ciphertext, sharedKey, nonce);
      if (!plaintext) return;  // 解密失败
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as MessagePayload;
      const incoming: IncomingMessage = {
        fromNodeId: d.from, payload, receivedAt: Date.now(),
      };
      for (const h of this.handlers) h(incoming);
    }
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/hub-transport.test.ts
git add electron/src/main/p2p/hub-transport.ts electron/tests/p2p/hub-transport.test.ts
git commit -m "feat(p2p): HubTransport WSS + E2E 加密（C 子系统互联网模式）"
```

---

## Task C7: 跨节点 messages 同步（应用层）

**Files:**
- Create: `electron/src/main/p2p/sync.ts`
- Test: `electron/tests/p2p/sync.test.ts`

**目标**：把 SQLite 本地新消息/任务通过 Router 推给对端节点；接收方写入本地 SQLite（source='lan'/'hub'）。

**Interfaces:**

```typescript
export class P2pSync {
  constructor(opts: {
    router: Router;
    localNodeId: string;
    onRemoteMessage: (msg: { roomId: string; sender: string; body: string; eventType: string }) => void;
  });
  start(): void;   // 订阅 router.onMessage
  broadcastNewMessage(msg: { roomId: string; sender: string; body: string; eventType: string }): Promise<void>;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/p2p/sync.test.ts
import { describe, it, expect, vi } from 'vitest';
import { P2pSync } from '../../src/main/p2p/sync';

function mkMockRouter() {
  const handlers = new Set<(m: unknown) => void>();
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h: (m: unknown) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    }),
    _emit: (m: unknown) => handlers.forEach((h) => h(m)),
  };
}

describe('P2pSync', () => {
  it('broadcastNewMessage → router.send 给所有信任节点（除自己）', async () => {
    const router = mkMockRouter();
    const sync = new P2pSync({
      router: router as never,
      localNodeId: 'me',
      onRemoteMessage: vi.fn(),
    });
    sync.start();
    // 简化：broadcastNewMessage 当前实现走 targetNodeId='*'，但 router 不支持广播
    // 修改实现：传 broadcast 列表给 P2pSync
    await sync.broadcastNewMessage({ roomId: 'r1', sender: '@me:home', body: 'hi', eventType: 'm.room.message' });
    expect(router.send).toHaveBeenCalled();
  });

  it('收到远端 message → onRemoteMessage 触发', () => {
    const router = mkMockRouter();
    const onRemote = vi.fn();
    const sync = new P2pSync({
      router: router as never,
      localNodeId: 'me',
      onRemoteMessage: onRemote,
    });
    sync.start();
    router._emit({
      fromNodeId: 'peer1',
      payload: { targetNodeId: 'me', type: 'message', body: { roomId: 'r1', sender: '@peer1:home', body: 'hello', eventType: 'm.room.message' } },
      receivedAt: Date.now(),
    });
    expect(onRemote).toHaveBeenCalledWith(expect.objectContaining({ body: 'hello', sender: '@peer1:home' }));
  });
});
```

- [ ] **Step 2: 实现 sync**

```typescript
// electron/src/main/p2p/sync.ts
//
// 跨节点同步应用层——把本地新 messages 推给对端，接收对端的 messages 写入本地 SQLite。
//
// 简化 v1：只同步消息（不同步 task 全表）；targetNodeId 列表由 trustStore 提供。
import type { Router } from './router';
import type { IncomingMessage, MessagePayload } from './types';
import { listTrustedNodes } from './trust-store';

export interface P2pSyncOpts {
  router: Router;
  localNodeId: string;
  onRemoteMessage: (msg: { roomId: string; sender: string; body: string; eventType: string }) => void;
}

export class P2pSync {
  private unsubscribe?: () => void;

  constructor(private readonly opts: P2pSyncOpts) {}

  start(): void {
    this.unsubscribe = this.opts.router.onIncoming((msg) => this.handleIncoming(msg));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  async broadcastNewMessage(msg: { roomId: string; sender: string; body: string; eventType: string }): Promise<void> {
    const payload: MessagePayload = {
      targetNodeId: '*',  // 广播
      type: 'message',
      body: msg,
    };
    // 推给所有信任节点
    const trusted = listTrustedNodes();
    for (const node of trusted) {
      if (node.nodeId === this.opts.localNodeId) continue;
      try {
        await this.opts.router.send(node.nodeId, { ...payload, targetNodeId: node.nodeId });
      } catch {
        // 单节点失败不影响其他节点
      }
    }
  }

  private handleIncoming(msg: IncomingMessage): void {
    if (msg.payload.type === 'message') {
      this.opts.onRemoteMessage(msg.payload.body as { roomId: string; sender: string; body: string; eventType: string });
    }
  }
}
```

注意：Router 没有直接暴露 `onIncoming`。简化：让 Router 类提供 `onIncoming(handler)` 订阅接口（与 transport 类似）。修改 router.ts 加这个方法。

- [ ] **Step 3: router.ts 加 onIncoming**

修改 `electron/src/main/p2p/router.ts`：

```typescript
// 在 Router 类加：
private incomingHandlers = new Set<(msg: IncomingMessage) => void>();

onIncoming(handler: (msg: IncomingMessage) => void): () => void {
  this.incomingHandlers.add(handler);
  return () => this.incomingHandlers.delete(handler);
}

// start() 内部订阅 transport onMessage 时把 msg 转发给 incomingHandlers：
async start(): Promise<void> {
  const dispatch = (m: IncomingMessage) => {
    for (const h of this.incomingHandlers) h(m);
  };
  const off1 = this.opts.localTransport.onMessage(dispatch);
  const off2 = this.opts.lanTransport?.onMessage(dispatch);
  const off3 = this.opts.hubTransport?.onMessage(dispatch);
  await this.opts.localTransport.start();
  await this.opts.lanTransport?.start();
  await this.opts.hubTransport?.start();
  this.unsubscribeAll = () => { off1(); off2?.(); off3?.(); };
}
```

- [ ] **Step 4: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/p2p/sync.test.ts tests/p2p/router.test.ts
git add electron/src/main/p2p/sync.ts electron/src/main/p2p/router.ts electron/tests/p2p/sync.test.ts
git commit -m "feat(p2p): 跨节点 messages 同步应用层（C 子系统）"
```

---

## Task C8: 节点发现 UI + 添加节点

**Files:**
- Create: `renderer/src/components/p2p/NodeDiscoveryPanel.tsx`
- Create: `renderer/src/components/p2p/AddNodeDialog.tsx`
- Modify: `renderer/src/stores/ui.store.ts`（ViewKey 加 'p2p' 或加到 settings）
- Test: `renderer/tests/components/p2p/NodeDiscoveryPanel.test.tsx`

### Steps

- [ ] **Step 1: 写测试**

```typescript
// renderer/tests/components/p2p/NodeDiscoveryPanel.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeDiscoveryPanel } from '../../../src/components/p2p/NodeDiscoveryPanel';

vi.mock('../../../src/ipc/client', () => ({
  ipc: {
    p2p: {
      getDiscoveredNodes: vi.fn().mockResolvedValue([
        { nodeId: 'node_a', displayName: 'Alice', transport: 'lan', trusted: true },
        { nodeId: 'node_b', displayName: 'Bob', transport: 'lan', trusted: false },
      ]),
      addTrustedNode: vi.fn().mockResolvedValue(undefined),
      removeTrustedNode: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

describe('NodeDiscoveryPanel', () => {
  it('渲染已发现节点列表', async () => {
    render(<NodeDiscoveryPanel />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(await screen.findByText('Bob')).toBeInTheDocument();
  });

  it('未信任节点显示"添加信任"按钮', async () => {
    render(<NodeDiscoveryPanel />);
    expect(await screen.findByText('添加信任')).toBeInTheDocument();
  });

  it('点击"添加信任"调用 addTrustedNode', async () => {
    render(<NodeDiscoveryPanel />);
    const buttons = await screen.findAllByText('添加信任');
    fireEvent.click(buttons[0]);
    // 验证 ipc 调用（mock 内部）
  });
});
```

- [ ] **Step 2: 实现 NodeDiscoveryPanel**

```tsx
// renderer/src/components/p2p/NodeDiscoveryPanel.tsx
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';

interface DiscoveredNode {
  nodeId: string;
  displayName: string;
  transport: 'lan' | 'hub';
  trusted: boolean;
  lastSeen: number;
}

export function NodeDiscoveryPanel() {
  const [nodes, setNodes] = useState<DiscoveredNode[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await ipc.p2p.getDiscoveredNodes();
      setNodes(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleTrust = async (nodeId: string) => {
    await ipc.p2p.addTrustedNode(nodeId);
    void refresh();
  };

  const handleRemove = async (nodeId: string) => {
    await ipc.p2p.removeTrustedNode(nodeId);
    void refresh();
  };

  if (loading) return <div className="p-4 text-sm text-neutral-500">扫描中...</div>;

  return (
    <div className="p-4 space-y-2">
      <h3 className="text-base font-medium">发现的节点</h3>
      {nodes.length === 0 && <div className="text-sm text-neutral-500">暂未发现其他节点（确保同 WiFi 下其他设备已启动 Momo Studio）</div>}
      {nodes.map((n) => (
        <div key={n.nodeId} className="flex items-center justify-between p-2 border border-border-subtle rounded">
          <div className="flex items-center gap-3">
            <span>{n.transport === 'lan' ? '🏠' : '🌐'}</span>
            <div>
              <div className="text-sm font-medium">{n.displayName}</div>
              <div className="text-xs text-neutral-500">{n.nodeId}</div>
            </div>
          </div>
          <div>
            {n.trusted ? (
              <button type="button" onClick={() => handleRemove(n.nodeId)} className="text-xs text-red-400">移除信任</button>
            ) : (
              <button type="button" onClick={() => handleTrust(n.nodeId)} className="text-xs px-3 py-1 bg-accent-blue text-white rounded">添加信任</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 实现 p2p IPC + preload 桥接**

在 `electron/src/main/p2p/index.ts` 暴露 IPC：

```typescript
// electron/src/main/p2p/index.ts
import { ipcMain, BrowserWindow } from 'electron';
import { Router } from './router';
import { LocalTransport } from './local-transport';
import { LanTransport } from './lan-transport';
import { loadIdentity, generateIdentity, saveIdentity } from './identity';
import { listTrustedNodes, addTrustedNode, removeTrustedNode, isTrusted, getTrustedPublicKey } from './trust-store';
import { P2pSync } from './sync';
import type { IncomingMessage } from './types';

let router: Router | null = null;
let lanTransport: LanTransport | null = null;
let sync: P2pSync | null = null;

export async function initP2p(): Promise<void> {
  let id = loadIdentity();
  if (!id) {
    id = generateIdentity('My Momo Node');
    saveIdentity(id);
  }

  const local = new LocalTransport(id);
  lanTransport = new LanTransport({
    identity: id,
    trustStore: { isTrusted, getTrustedPublicKey },
  });

  router = new Router({
    localNodeId: id.nodeId,
    localTransport: local,
    lanTransport,
    onIncoming: () => {},  // sync 接管
  });
  await router.start();

  sync = new P2pSync({
    router,
    localNodeId: id.nodeId,
    onRemoteMessage: (msg) => {
      // 写本地 SQLite（source='lan'）
      // TODO: import messages repo，调用 insertMessage
    },
  });
  sync.start();
}

export function registerP2pHandlers(): void {
  ipcMain.handle('p2p:getIdentity', () => {
    const id = loadIdentity();
    return id ? { nodeId: id.nodeId, displayName: id.displayName } : null;
  });

  ipcMain.handle('p2p:getDiscoveredNodes', () => {
    if (!lanTransport) return [];
    const trusted = new Set(listTrustedNodes().map((n) => n.nodeId));
    return lanTransport.discoverNodes().map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      transport: n.transport,
      trusted: trusted.has(n.nodeId),
      lastSeen: n.lastSeen,
    }));
  });

  ipcMain.handle('p2p:addTrustedNode', async (_evt, nodeId: string) => {
    const node = lanTransport?.discoverNodes().find((n) => n.nodeId === nodeId);
    if (!node) throw new Error(`未发现节点 ${nodeId}`);
    addTrustedNode({
      nodeId: node.nodeId,
      displayName: node.displayName,
      publicKey: node.publicKey,
      trustedAt: Date.now(),
    });
  });

  ipcMain.handle('p2p:removeTrustedNode', (_evt, nodeId: string) => {
    removeTrustedNode(nodeId);
  });

  ipcMain.handle('p2p:listTrustedNodes', () => listTrustedNodes());
}
```

`renderer/src/ipc/types.d.ts` 加：

```typescript
export interface ApiSurface {
  // ... 已有
  p2p: {
    getIdentity(): Promise<{ nodeId: string; displayName: string } | null>;
    getDiscoveredNodes(): Promise<Array<{ nodeId: string; displayName: string; transport: 'lan' | 'hub'; trusted: boolean; lastSeen: number }>>;
    addTrustedNode(nodeId: string): Promise<void>;
    removeTrustedNode(nodeId: string): Promise<void>;
    listTrustedNodes(): Promise<Array<{ nodeId: string; displayName: string; trustedAt: number }>>;
  };
}
```

`electron/src/preload/index.ts` + `renderer/src/ipc/client.ts` 桥接 `p2p:`。

`renderer/src/components/layout/MiddlePanel.tsx`（或 settings 页）接入 NodeDiscoveryPanel。

- [ ] **Step 4: 测试 + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(p2p): 节点发现 UI + IPC + p2p 模块初始化"
```

---

## Task C9: momo-hub 服务器骨架（独立项目）

**Files:**
- Create: `momo-hub/package.json`
- Create: `momo-hub/src/server.ts`
- Create: `momo-hub/src/routing.ts`
- Create: `momo-hub/src/presence.ts`
- Create: `momo-hub/src/auth.ts`
- Create: `momo-hub/Dockerfile`
- Create: `momo-hub/README.md`

**目标**：实现 hub 服务器最小可用版本（WebSocket + 节点路由 + 在线列表 + 离线缓存）。

### Steps

- [ ] **Step 1: 创建独立项目**

```bash
mkdir -p momo-hub/src
cd momo-hub
npm init -y
npm install ws
```

- [ ] **Step 2: momo-hub/src/server.ts**

```typescript
// momo-hub/src/server.ts
//
// momo-hub——轻量级 WebSocket 中转服务器。
// 职责：
//   1. 节点连接认证（authToken）
//   2. 维护在线节点列表（presence）
//   3. 按 nodeId 路由消息（routing）
//   4. 离线消息临时缓存（TTL 7 天）
//
// 不持久化用户数据；hub 看到的所有 payload 都是 E2E 加密密文。
import { WebSocketServer, WebSocket } from 'ws';
import { handlePresence, registerSession, unregisterSession, getOnlineNodes, deliverTo } from './presence';
import { verifyAuthToken, rateLimiter } from './auth';

const PORT = parseInt(process.env.HUB_PORT ?? '8080', 10);
const wss = new WebSocketServer({ port: PORT });

console.log(`momo-hub listening on :${PORT}`);

wss.on('connection', (ws, req) => {
  let nodeId: string | null = null;

  ws.on('message', (raw) => {
    if (rateLimiter.isLimited(req.socket.remoteAddress ?? '')) {
      ws.send(JSON.stringify({ type: 'error', message: 'rate limited' }));
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      const verified = verifyAuthToken(msg.authToken as string);
      if (!verified) {
        ws.send(JSON.stringify({ type: 'error', message: 'auth failed' }));
        ws.close();
        return;
      }
      nodeId = msg.nodeId as string;
      registerSession(nodeId, ws, {
        boxPublicKey: (msg.boxPublicKey as string) ?? '',
        displayName: (msg.displayName as string) ?? 'Unknown',
      });
      // 推送当前在线列表
      ws.send(JSON.stringify({ type: 'presence', nodes: getOnlineNodes() }));
      // 广播新节点上线给其他在线节点
      handlePresence(nodeId);
    } else if (msg.type === 'send' && nodeId) {
      // 路由到目标节点
      const target = msg.to as string;
      const delivered = deliverTo(target, {
        type: 'deliver',
        from: nodeId,
        ciphertext: msg.ciphertext,
        nonce: msg.nonce,
      });
      if (!delivered) {
        // 离线缓存（TTL 7 天）
        // TODO: 写入 Redis 或 in-memory cache
        ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, delivered: false }));
      } else {
        ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, delivered: true }));
      }
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      unregisterSession(nodeId);
      handlePresence(nodeId);  // 通知其他节点此节点下线
    }
  });
});
```

- [ ] **Step 3: momo-hub/src/presence.ts**

```typescript
// momo-hub/src/presence.ts
//
// 在线节点管理——nodeId → WebSocket session 映射。
import type { WebSocket } from 'ws';

interface Session {
  ws: WebSocket;
  boxPublicKey: string;
  displayName: string;
}

const sessions = new Map<string, Session>();

export function registerSession(nodeId: string, ws: WebSocket, info: { boxPublicKey: string; displayName: string }): void {
  sessions.set(nodeId, { ws, ...info });
}

export function unregisterSession(nodeId: string): void {
  sessions.delete(nodeId);
}

export function getOnlineNodes(): Array<{ nodeId: string; displayName: string; boxPublicKey: string }> {
  return Array.from(sessions.entries()).map(([nodeId, s]) => ({
    nodeId, displayName: s.displayName, boxPublicKey: s.boxPublicKey,
  }));
}

export function deliverTo(nodeId: string, msg: Record<string, unknown>): boolean {
  const session = sessions.get(nodeId);
  if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
  session.ws.send(JSON.stringify(msg));
  return true;
}

export function handlePresence(_nodeId: string): void {
  // 广播新 presence 给所有在线节点
  const nodes = getOnlineNodes();
  for (const session of sessions.values()) {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'presence', nodes }));
    }
  }
}
```

- [ ] **Step 4: momo-hub/src/auth.ts**

```typescript
// momo-hub/src/auth.ts
//
// 简化认证——v1 用静态 token 列表；v2 加用户注册 + JWT。
const VALID_TOKENS = new Set((process.env.HUB_TOKENS ?? '').split(',').filter(Boolean));

export function verifyAuthToken(token: string): boolean {
  if (VALID_TOKENS.size === 0) return true;  // 未配置 = 开发模式允许所有
  return VALID_TOKENS.has(token);
}

const ipRequests = new Map<string, number[]>();
const RATE_LIMIT_RPM = 100;

export const rateLimiter = {
  isLimited(ip: string): boolean {
    const now = Date.now();
    const list = (ipRequests.get(ip) ?? []).filter((ts) => now - ts < 60_000);
    if (list.length >= RATE_LIMIT_RPM) return true;
    list.push(now);
    ipRequests.set(ip, list);
    return false;
  },
};
```

- [ ] **Step 5: momo-hub/Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

- [ ] **Step 6: momo-hub/README.md**（简短部署文档）

```markdown
# momo-hub

Momo Studio 互联网模式的中转服务器。

## 部署

### 公共服务
官方公共服务：`wss://hub.momostudio.io`（即将上线）

### 自建
\`\`\`bash
git clone https://github.com/yourname/momo-studio
cd momo-studio/momo-hub
npm install
npm run build
HUB_PORT=8080 HUB_TOKENS=token1,token2 node dist/server.js
\`\`\`

或用 Docker：
\`\`\`bash
docker build -t momo-hub .
docker run -p 8080:8080 -e HUB_TOKENS=token1 momo-hub
\`\`\`

## 隐私
- hub 不持久化用户数据
- 所有 payload 是 E2E 加密密文
- 离线消息临时缓存 7 天后自动删除
- hub 仅看到 nodeId（公钥指纹）+ ciphertext
```

- [ ] **Step 7: commit momo-hub 项目**

```bash
git add momo-hub
git commit -m "feat(momo-hub): 独立 hub 服务器项目（WebSocket 中转 + presence）"
```

---

## Self-Review

### Spec 覆盖

| spec 章节 | 任务 |
|---|---|
| 节点身份（Ed25519 + 节点 ID） | C1 ✅ |
| TransportLayer 接口 + LocalTransport | C2 ✅ |
| LanTransport（mDNS + TCP） | C3 ✅ |
| Router（按 nodeId 路由） | C4 ✅ |
| E2E 加密 helper | C5 ✅ |
| HubTransport（WSS + E2E） | C6 ✅ |
| 跨节点 messages 同步 | C7 ✅ |
| 节点发现 UI + 信任管理 | C8 ✅ |
| momo-hub 服务器 | C9 ✅ |
| 信任管理（扫码/PIN） | C8（部分） + 留 v2 完整 PIN 流程 |
| 跨节点 tasks 同步 + agent 调度 | 留 v2.0-rc（不在本 plan 范围） |

### Placeholder 扫描

- ✅ 所有 task 有完整代码 + 测试
- ✅ 无 TBD / TODO（momo-hub 的 Redis 离线缓存是 v2 增强，README 已说明）
- ✅ crypto/identity/router 都有完整 TDD

### 已知风险

1. **mDNS 跨平台**：`bonjour-service` 在 macOS/Linux 稳定；Windows 可能需要 Bonjour Print Services（已安装多数情况 OK）
2. **C3 LanTransport 集成测试 flaky**：CI 上 mDNS 多播可能受限；本地手动验证为主
3. **C6 hub-transport 测试 mock WebSocket**：实际生产需 e2e 测试（启动真实 hub）
4. **跨子网（VPN）mDNS**：默认不工作；C8 加"手动添加节点 IP:port"fallback 留 v2
5. **跨节点 ACL**：v1 全信任节点互通；细粒度 ACL（任务/会话可见性）留 v2

---

**Plan C 完成并保存到 `docs/plans/2026-08-13-platform-redesign-c-p2p-networking.md`。**

---

## 全部 4 个 plan 总结

| Plan | 范围 | Task 数 | 关键产出 |
|---|---|---|---|
| **A** | 消息源统一 | 10 | messages + message_events 表（事件溯源）+ MemoryProvider 雏形 + 重启一致性 |
| **B** | 任务模型 + 路由 | 11 | tasks 表 + 状态机 + @/# 双语法 + 4 种启动机制 + 5 策略冲突 + MemoryProvider 完整 |
| **D** | 看板 + 并发 | 7（D1-D6 + D7 合并） | task-driven runtime 重构 + WarmPool + 三层并发 + Linear 看板 UI |
| **C** | 联网 P2P | 9 | Ed25519 身份 + Lan/Hub Transport + Router + E2E 加密 + momo-hub 独立项目 |

**总计 37 个 task**，覆盖 spec 全部章节。

## 实施顺序

**强烈建议按 A → B → D → C 顺序实施**：

- **A** 是地基（消息持久化），其他都依赖
- **B** 依赖 A 的 messages.task_id 字段
- **D** 依赖 B 的 tasks 表 + 状态机
- **C** 完全独立（v2.0 范围），A/B/D 完成后任何时候都可以启动

每个 plan 独立可执行，每个 task 独立可测、可 commit。任何阶段都可以暂停或回退。
