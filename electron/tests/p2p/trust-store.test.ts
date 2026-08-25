// electron/tests/p2p/trust-store.test.ts
//
// trust-store 测试（安全修复扩展）：
//   - saveAll + listTrustedNodes 往返（含可选 boxPublicKey）
//   - 无 boxPublicKey 的旧格式条目往返不损坏（字段缺省）
//   - getTrustedBoxPublicKey：有条目返回 box 公钥；无 box 字段（旧信任条目）/ 未信任返回 null
//   - getTrustedPublicKey 基本行为回归
//   - addTrustedNode 按 nodeId upsert（含 box 公钥更新）
//
// 测试隔离：独立 tmp 目录（AP_USER_DATA_DIR）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nacl from 'tweetnacl';
import {
  saveAll, listTrustedNodes, addTrustedNode, removeTrustedNode,
  isTrusted, getTrustedPublicKey, getTrustedBoxPublicKey,
} from '../../src/main/p2p/trust-store';

const tmpRoot = path.join(os.tmpdir(), `ap-trust-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function mkNode(overrides: Partial<Parameters<typeof saveAll>[0][number]> = {}) {
  const sign = nacl.sign.keyPair();
  const box = nacl.box.keyPair();
  return {
    nodeId: 'node_abc123000000000f',
    displayName: '测试节点',
    publicKey: sign.publicKey,
    boxPublicKey: box.publicKey,
    trustedAt: 1,
    ...overrides,
  };
}

describe('trust-store', () => {
  it('saveAll + listTrustedNodes 往返（含 boxPublicKey）', () => {
    const node = mkNode();
    saveAll([node]);

    const list = listTrustedNodes();
    expect(list.length).toBe(1);
    expect(list[0]!.nodeId).toBe(node.nodeId);
    expect(Array.from(list[0]!.publicKey)).toEqual(Array.from(node.publicKey));
    expect(Array.from(list[0]!.boxPublicKey!)).toEqual(Array.from(node.boxPublicKey));
  });

  it('旧格式条目（无 boxPublicKey）往返不损坏', () => {
    const node = mkNode();
    const { boxPublicKey: _omit, ...legacy } = node;
    saveAll([legacy]);

    const list = listTrustedNodes();
    expect(list.length).toBe(1);
    expect(list[0]!.boxPublicKey).toBeUndefined();
    expect(Array.from(list[0]!.publicKey)).toEqual(Array.from(node.publicKey));
  });

  it('getTrustedBoxPublicKey：有条目返回 box 公钥；无 box 字段 / 未信任返回 null', () => {
    const withBox = mkNode({ nodeId: 'node_withbox00000000' });
    const legacy = mkNode({ nodeId: 'node_legacy000000000' });
    const { boxPublicKey: _omit, ...legacyNoBox } = legacy;
    saveAll([withBox, legacyNoBox]);

    expect(getTrustedBoxPublicKey('node_withbox00000000')).not.toBeNull();
    expect(
      Buffer.from(getTrustedBoxPublicKey('node_withbox00000000')!).equals(
        Buffer.from(withBox.boxPublicKey),
      ),
    ).toBe(true);
    // 旧信任条目无 box 公钥——调用方必须按"不可加密"处理
    expect(getTrustedBoxPublicKey('node_legacy000000000')).toBeNull();
    expect(getTrustedBoxPublicKey('node_unknown00000000')).toBeNull();
  });

  it('getTrustedPublicKey / isTrusted / removeTrustedNode 基本行为', () => {
    const node = mkNode();
    saveAll([node]);

    expect(isTrusted(node.nodeId)).toBe(true);
    expect(
      Buffer.from(getTrustedPublicKey(node.nodeId)!).equals(Buffer.from(node.publicKey)),
    ).toBe(true);

    removeTrustedNode(node.nodeId);
    expect(isTrusted(node.nodeId)).toBe(false);
    expect(getTrustedPublicKey(node.nodeId)).toBeNull();
    expect(getTrustedBoxPublicKey(node.nodeId)).toBeNull();
  });

  it('addTrustedNode 按 nodeId upsert（box 公钥随之更新）', () => {
    const first = mkNode();
    saveAll([first]);

    const newBox = nacl.box.keyPair().publicKey;
    addTrustedNode({ ...first, boxPublicKey: newBox, trustedAt: 2 });

    const list = listTrustedNodes();
    expect(list.length).toBe(1);
    expect(
      Buffer.from(list[0]!.boxPublicKey!).equals(Buffer.from(newBox)),
    ).toBe(true);
  });
});
