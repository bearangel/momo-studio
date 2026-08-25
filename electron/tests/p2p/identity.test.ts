// electron/tests/p2p/identity.test.ts
//
// NodeIdentity（C 子系统 C1）测试：
//   - generateIdentity 产出 Ed25519 签名密钥对 + X25519 box 密钥对 + nodeId 指纹
//   - nodeIdFromPublicKey 稳定（同公钥同 id）
//   - saveIdentity + loadIdentity 往返一致（含 box 密钥）
//   - loadIdentity 未保存时返回 null
//   - 加载时迁移：旧文件缺 box 密钥 → 现场生成 + 回写磁盘（nodeId 不变）
//   - sign + verify 合法签名通过；篡改消息 / 错误公钥都失败
//   - publicKeyFingerprint：sha512 前 16 字节 hex（32 字符）、稳定、不同公钥不同指纹
//
// 测试隔离：每个用例独立 tmp 目录，通过 AP_USER_DATA_DIR 覆盖 resolveUserDataDir。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateIdentity, loadIdentity, saveIdentity,
  nodeIdFromPublicKey, publicKeyFingerprint, sign, verify,
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
  it('generateIdentity 生成 Ed25519 签名密钥对 + X25519 box 密钥对 + nodeId', () => {
    const id = generateIdentity('Alice 的 Mac');
    expect(id.displayName).toBe('Alice 的 Mac');
    expect(id.publicKey.length).toBe(32);
    expect(id.privateKey.length).toBe(64);
    expect(id.boxPublicKey.length).toBe(32);
    expect(id.boxPrivateKey.length).toBe(32);
    expect(id.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(id.createdAt).toBeGreaterThan(0);
  });

  it('box 密钥对与签名密钥对相互独立（无字节重合语义）', () => {
    const id = generateIdentity('a');
    // X25519 公钥不应恰好等于签名公钥（独立随机生成，相等概率 ~2^-256）
    expect(Buffer.from(id.boxPublicKey).equals(Buffer.from(id.publicKey))).toBe(false);
    expect(Buffer.from(id.boxPrivateKey).equals(Buffer.from(id.privateKey))).toBe(false);
  });

  it('两次生成不同密钥对', () => {
    const a = generateIdentity('a');
    const b = generateIdentity('b');
    expect(Array.from(a.publicKey)).not.toEqual(Array.from(b.publicKey));
    expect(Array.from(a.boxPublicKey)).not.toEqual(Array.from(b.boxPublicKey));
    expect(a.nodeId).not.toBe(b.nodeId);
  });

  it('nodeIdFromPublicKey 稳定（同公钥同 id）', () => {
    const id = generateIdentity('a');
    const nodeId = nodeIdFromPublicKey(id.publicKey);
    expect(nodeId).toBe(id.nodeId);
  });

  it('saveIdentity + loadIdentity 往返（含 box 密钥）', () => {
    const id = generateIdentity('Alice');
    saveIdentity(id);
    const loaded = loadIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded?.nodeId).toBe(id.nodeId);
    expect(Array.from(loaded!.publicKey)).toEqual(Array.from(id.publicKey));
    expect(Array.from(loaded!.privateKey)).toEqual(Array.from(id.privateKey));
    expect(Array.from(loaded!.boxPublicKey)).toEqual(Array.from(id.boxPublicKey));
    expect(Array.from(loaded!.boxPrivateKey)).toEqual(Array.from(id.boxPrivateKey));
  });

  it('loadIdentity 未保存时返回 null', () => {
    expect(loadIdentity()).toBeNull();
  });

  it('加载时迁移：旧文件缺 box 密钥 → 现场生成 + 回写磁盘 + nodeId 不变', () => {
    const id = generateIdentity('旧节点');
    // 手写旧格式文件（无 box 字段——v2.0 安全修复之前的形态）
    const legacy = {
      nodeId: id.nodeId,
      publicKey: Buffer.from(id.publicKey).toString('base64'),
      privateKey: Buffer.from(id.privateKey).toString('base64'),
      displayName: id.displayName,
      createdAt: id.createdAt,
    };
    const p = path.join(tmpRoot, 'p2p-identity.json');
    fs.writeFileSync(p, JSON.stringify(legacy, null, 2), { mode: 0o600 });

    const loaded = loadIdentity();

    expect(loaded).not.toBeNull();
    expect(loaded?.nodeId).toBe(id.nodeId);
    expect(loaded?.boxPublicKey.length).toBe(32);
    expect(loaded?.boxPrivateKey.length).toBe(32);
    // 回写磁盘：再次加载得到同一 box 密钥对（不是每次重新生成）
    const again = loadIdentity();
    expect(Array.from(again!.boxPublicKey)).toEqual(Array.from(loaded!.boxPublicKey));
    // 磁盘文件已含 box 字段
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8')) as { boxPublicKey?: string };
    expect(typeof onDisk.boxPublicKey).toBe('string');
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

describe('publicKeyFingerprint', () => {
  it('32 位 hex 字符（sha512 前 16 字节）', () => {
    const id = generateIdentity('a');
    const fp = publicKeyFingerprint(id.publicKey);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('稳定：同公钥同指纹', () => {
    const id = generateIdentity('a');
    expect(publicKeyFingerprint(id.publicKey)).toBe(publicKeyFingerprint(id.publicKey));
  });

  it('不同公钥不同指纹', () => {
    const a = generateIdentity('a');
    const b = generateIdentity('b');
    expect(publicKeyFingerprint(a.publicKey)).not.toBe(publicKeyFingerprint(b.publicKey));
  });
});