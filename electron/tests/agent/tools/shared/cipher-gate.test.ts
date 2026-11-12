// electron/tests/agent/tools/shared/cipher-gate.test.ts
// 工具层密文安全闸单元测试（B 方案收口）：拒绝型闸门 + 快照优雅降级。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNotCipher,
  readJournalSnapshot,
} from '../../../../src/main/agent/tools/shared/cipher-gate';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { DirectContentIo } from '../../../../src/main/files/file-io/content-io';

const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cipher-gate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertNotCipher', () => {
  it('明文缓冲直接通过（no-op）', () => {
    expect(() => assertNotCipher(Buffer.from('plain text'), 'a.ts')).not.toThrow();
  });

  it('密文缓冲抛 EENCRYPTED，文案含路径', () => {
    expect(() => assertNotCipher(CIPHER_HEAD, 'Enc.java')).toThrow(/已加密（E-SafeNet 容器）[\s\S]*Enc\.java/);
  });
});

describe('readJournalSnapshot', () => {
  it('明文经通道读取返回字节', async () => {
    const ws = new WorkspaceFS(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'plain');
    expect((await readJournalSnapshot(ws, 'a.txt'))?.toString('utf8')).toBe('plain');
  });

  it('strict 通道 EENCRYPTED → null（优雅降级）', async () => {
    const ws = new WorkspaceFS(dir);
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    expect(await readJournalSnapshot(ws, 'Enc.java')).toBeNull();
  });

  it('非 strict 通道读到密文 → 魔数自检同样 null', async () => {
    const ws = new WorkspaceFS(dir, { contentIo: new DirectContentIo(false) });
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    expect(await readJournalSnapshot(ws, 'Enc.java')).toBeNull();
  });

  it('非密文读错误原样抛（不吞权限/IO 错误）', async () => {
    const ws = new WorkspaceFS(dir);
    await expect(readJournalSnapshot(ws, 'no-such.txt')).rejects.toThrow();
  });
});
