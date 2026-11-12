// electron/tests/files/file-io/content-io.test.ts
//
// DirectContentIo / ProxyContentIo 批量读 readFiles 单测（B 方案工具层收口）。
// 直接读真实 tmp 文件；密文样本沿用 cipher-detect.test.ts 的实测容器头。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectContentIo, ProxyContentIo } from '../../../src/main/files/file-io/content-io';
import { MSG_DIRECT_CIPHER } from '../../../src/main/files/file-io/types';

const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-content-io-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DirectContentIo.readFiles', () => {
  it('顺序返回与入参同序的缓冲', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'BB');
    const bufs = await new DirectContentIo(true).readFiles([
      path.join(dir, 'b.txt'),
      path.join(dir, 'a.txt'),
    ]);
    expect(bufs.map((b) => b.toString('utf8'))).toEqual(['BB', 'A']);
  });

  it('空数组返回空数组（不触 fs）', async () => {
    expect(await new DirectContentIo(true).readFiles([])).toEqual([]);
  });

  it('strict 时批内含密文 → 整批 EENCRYPTED（中性文案）', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    await expect(
      new DirectContentIo(true).readFiles([path.join(dir, 'a.txt'), path.join(dir, 'Enc.java')]),
    ).rejects.toMatchObject({ code: 'EENCRYPTED' });
    await expect(
      new DirectContentIo(true).readFiles([path.join(dir, 'Enc.java')]),
    ).rejects.toThrow(MSG_DIRECT_CIPHER);
  });

  it('非 strict 时密文原样返回（strict 语义与单文件一致）', async () => {
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    const bufs = await new DirectContentIo(false).readFiles([path.join(dir, 'Enc.java')]);
    expect(bufs[0]!.equals(CIPHER_HEAD)).toBe(true);
  });

  it('任一文件读失败 → 整批抛 EREAD', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    await expect(
      new DirectContentIo(true).readFiles([path.join(dir, 'a.txt'), path.join(dir, 'nope.txt')]),
    ).rejects.toMatchObject({ code: 'EREAD' });
  });
});

describe('ProxyContentIo.readFiles', () => {
  it('委托被包对象 readFiles（含返回值与参数透传）', async () => {
    const calls: string[][] = [];
    const io = {
      readFile: (p: string) => Promise.resolve(Buffer.from(p)),
      readFiles: (ps: string[]) => {
        calls.push(ps);
        return Promise.resolve(ps.map((p) => Buffer.from(`via-proxy:${p}`)));
      },
      writeFile: () => Promise.resolve(),
    };
    const out = await new ProxyContentIo(io).readFiles(['/a', '/b']);
    expect(calls).toEqual([['/a', '/b']]);
    expect(out.map((b) => b.toString('utf8'))).toEqual(['via-proxy:/a', 'via-proxy:/b']);
  });

  it('被包对象抛错原样透传', async () => {
    const io = {
      readFile: () => Promise.resolve(Buffer.alloc(0)),
      readFiles: () => Promise.reject(new Error('boom')),
      writeFile: () => Promise.resolve(),
    };
    await expect(new ProxyContentIo(io).readFiles(['/a'])).rejects.toThrow('boom');
  });
});
