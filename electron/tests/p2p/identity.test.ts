// electron/tests/p2p/identity.test.ts
//
// NodeIdentity（C 子系统 C1）测试：
//   - generateIdentity 产出 Ed25519 密钥对 + nodeId 指纹
//   - nodeIdFromPublicKey 稳定（同公钥同 id）
//   - saveIdentity + loadIdentity 往返一致
//   - loadIdentity 未保存时返回 null
//   - sign + verify 合法签名通过；篡改消息 / 错误公钥都失败
//
// 测试隔离：每个用例独立 tmp 目录，通过 AP_USER_DATA_DIR 覆盖 resolveUserDataDir。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateIdentity, loadIdentity, saveIdentity,
  nodeIdFromPublicKey, sign, verify,
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