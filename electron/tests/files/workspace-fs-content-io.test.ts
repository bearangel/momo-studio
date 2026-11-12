// electron/tests/files/workspace-fs-content-io.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFS, setDefaultContentIo } from '../../src/main/files/workspace-fs';
import { DirectContentIo } from '../../src/main/files/file-io/content-io';
import type { ContentIo } from '../../src/main/files/file-io/types';
import { MSG_DIRECT_CIPHER } from '../../src/main/files/file-io/types';

const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wsfs-io-'));
});
afterEach(() => {
  setDefaultContentIo(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeIo(): ContentIo & {
  reads: string[];
  readManyBatches: string[][];
  writes: Array<{ p: string; size: number }>;
} {
  const io = {
    reads: [] as string[],
    readManyBatches: [] as string[][],
    writes: [] as Array<{ p: string; size: number }>,
    async readFile(p: string) {
      io.reads.push(p);
      return Buffer.from('via-io');
    },
    async readFiles(ps: string[]) {
      io.readManyBatches.push(ps);
      return ps.map(() => Buffer.from('via-io'));
    },
    async writeFile(p: string, d: Buffer) {
      io.writes.push({ p, size: d.length });
    },
  };
  return io;
}

describe('WorkspaceFS 默认通道（direct）', () => {
  it('读明文正常、写正常（既有行为回归）', async () => {
    const ws = new WorkspaceFS(dir);
    await ws.writeFile('a.txt', 'hello');
    expect((await ws.readFile('a.txt')).toString('utf8')).toBe('hello');
  });

  it('读到密文 → EENCRYPTED（中性文案）', async () => {
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    const ws = new WorkspaceFS(dir);
    await expect(ws.readFile('Enc.java')).rejects.toMatchObject({ code: 'EENCRYPTED' });
    await expect(ws.readFile('Enc.java')).rejects.toThrow(MSG_DIRECT_CIPHER);
  });

  it('setDefaultContentIo 对未注入实例生效', async () => {
    const io = fakeIo();
    setDefaultContentIo(io);
    const ws = new WorkspaceFS(dir);
    expect((await ws.readFile('x.txt')).toString('utf8')).toBe('via-io');
    expect(io.reads).toHaveLength(1);
  });
});

describe('WorkspaceFS 注入通道', () => {
  it('readFile/writeFile/createFile 全走注入 io，且收到绝对路径', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await ws.readFile('sub/a.txt');
    await ws.writeFile('sub/b.txt', 'xx');
    await ws.createFile('c.txt');
    expect(io.reads).toEqual([path.join(dir, 'sub', 'a.txt')]);
    expect(io.writes.map((w) => w.p)).toEqual([
      path.join(dir, 'sub', 'b.txt'),
      path.join(dir, 'c.txt'),
    ]);
  });

  it('沙箱校验先于 io：越界路径在触达 io 前抛错', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await expect(ws.readFile('../../etc/passwd')).rejects.toThrow('路径越界');
    expect(io.reads).toHaveLength(0);
  });

  it('.git 保护仍生效', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await expect(ws.readFile('.git/config')).rejects.toThrow('.git');
  });

  it('readFiles：逐路径沙箱校验后整批委托 io（绝对路径、顺序保持）', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    const bufs = await ws.readFiles(['sub/a.txt', 'b.txt']);
    expect(bufs).toHaveLength(2);
    expect(io.readManyBatches).toEqual([[path.join(dir, 'sub', 'a.txt'), path.join(dir, 'b.txt')]]);
    expect(io.reads).toHaveLength(0);
  });

  it('readFiles：批内任一路径越界 → 整批在校验期抛错，不触达 io', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await expect(ws.readFiles(['ok.txt', '../../etc/passwd'])).rejects.toThrow('路径越界');
    expect(io.readManyBatches).toHaveLength(0);
    expect(io.reads).toHaveLength(0);
  });

  it('readFiles：空数组直接空返回（不触达 io）', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    expect(await ws.readFiles([])).toEqual([]);
    expect(io.readManyBatches).toHaveLength(0);
  });

  it('listDir / rename / deletePath 不经内容通道（元数据操作）', async () => {
    const io = fakeIo();
    const spyRead = vi.spyOn(io, 'readFile');
    const ws = new WorkspaceFS(dir, { contentIo: io });
    fs.writeFileSync(path.join(dir, 'f.txt'), '1');
    await ws.listDir('.');
    await ws.rename('f.txt', 'g.txt');
    await ws.deletePath('g.txt');
    expect(spyRead).not.toHaveBeenCalled();
    expect(io.writes).toHaveLength(0);
  });
});

describe('DirectContentIo', () => {
  it('strict 时密文抛 EENCRYPTED；非 strict 原样返回', async () => {
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    await expect(new DirectContentIo(true).readFile(p)).rejects.toMatchObject({
      code: 'EENCRYPTED',
    });
    expect((await new DirectContentIo(false).readFile(p)).equals(CIPHER_HEAD)).toBe(true);
  });
});
