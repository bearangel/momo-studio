import { describe, expect, it } from 'vitest';
import { looksEncrypted } from '../../../src/main/files/file-io/cipher-detect';
import { FileIoError, MSG_DIRECT_CIPHER, MSG_PROXY_CIPHER } from '../../../src/main/files/file-io/types';

// 真实密文头（上游 PoC §1.1 实测）：62 14 23 65 DA 00 ... "E-SafeNet" ... "LOCK"
const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

describe('looksEncrypted', () => {
  it('空/过短缓冲返回 false', () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
    expect(looksEncrypted(Buffer.alloc(0))).toBe(false);
    expect(looksEncrypted(Buffer.alloc(11))).toBe(false);
  });

  it('真实密文头命中', () => {
    expect(looksEncrypted(CIPHER_HEAD)).toBe(true);
  });

  it('魔数出现在 64 字节之后不算', () => {
    const buf = Buffer.alloc(96, 0x20);
    buf.write('E-SafeNet', 70, 'latin1');
    expect(looksEncrypted(buf)).toBe(false);
  });

  it('普通源码文本不误报', () => {
    expect(looksEncrypted(Buffer.from('package com.ecs.dape;\n', 'utf8'))).toBe(false);
  });
});

describe('FileIoError 与文案常量', () => {
  it('携带 code 且 instanceof Error', () => {
    const e = new FileIoError('EENCRYPTED', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('EENCRYPTED');
    expect(e.name).toBe('FileIoError');
  });

  it('错误文案中性化（不含敏感字样）', () => {
    for (const msg of [MSG_DIRECT_CIPHER, MSG_PROXY_CIPHER]) {
      expect(msg).not.toMatch(/亿赛通|白名单|安全部门|合规/);
      expect(msg).toContain('设置 → 文件访问');
    }
  });
});
