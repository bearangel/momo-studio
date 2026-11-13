import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleFileIoRequestMsg } from '../../../src/main/files/file-io/main-bridge';
import { FileIoError } from '../../../src/main/files/file-io/types';

function fakeSvc(overrides?: Partial<{ readFile: (p: string) => Promise<Buffer>; writeFile: (p: string, d: Buffer) => Promise<void>; readFiles: (ps: string[]) => Promise<Buffer[]> }>) {
  return {
    readFile: overrides?.readFile ?? (async () => Buffer.from('read')),
    writeFile: overrides?.writeFile ?? (async () => undefined),
    readFiles: overrides?.readFiles ?? (async (ps: string[]) => ps.map(() => Buffer.from('many'))),
  };
}

describe('handleFileIoRequestMsg（主进程侧）', () => {
  it('read → ok + dataBase64', async () => {
    const out: Array<Record<string, unknown>> = [];
    const consumed = await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r1', op: 'read', path: '/a.java' },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect(consumed).toBe(true);
    expect(out[0]).toMatchObject({ type: 'file-io:resp', requestId: 'r1', ok: true });
    expect(Buffer.from(String(out[0]!.dataBase64), 'base64').toString('utf8')).toBe('read');
  });

  it('write → ok:true；readMany → items 数组', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r2', op: 'write', path: '/b.java', dataBase64: 'eA==' },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect(out[0]).toMatchObject({ requestId: 'r2', ok: true });

    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r3', op: 'readMany', paths: ['/x', '/y'] },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect((out[1]!.items as unknown[]).length).toBe(2);
  });

  it('FileIoError → error.code 原样透传', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r4', op: 'read', path: '/enc.java' },
      (p) => out.push(p),
      fakeSvc({ readFile: async () => { throw new FileIoError('EENCRYPTED', '密文'); } }) as never,
    );
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EENCRYPTED' } });
  });

  it('非本协议消息返回 false（不消费）', async () => {
    expect(await handleFileIoRequestMsg({ type: 'other' }, () => {}, fakeSvc() as never)).toBe(false);
    expect(await handleFileIoRequestMsg(null, () => {}, fakeSvc() as never)).toBe(false);
  });
});

describe('handleFileIoRequestMsg 工作空间囚禁（I1：opts.workspaceDir；M1：symlink 防线）', () => {
  // M1 后囚禁触真实 fs（锚点 realpath 上溯）——假路径会被 fail-closed 拒掉，
  // 故本块全部用真实临时目录（beforeEach 重建，afterEach 清理）
  let root: string;
  let WS: string;
  let OUTSIDE: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'momo-fiobridge-'));
    WS = path.join(root, 'ws');
    OUTSIDE = path.join(root, 'outside');
    mkdirSync(WS, { recursive: true });
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(path.join(WS, 'A.java'), 'plain');
    writeFileSync(path.join(OUTSIDE, 'secret.key'), 'top-secret');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('工作空间内 read / write 正常放行', async () => {
    const INSIDE = path.join(WS, 'A.java');
    const reads: string[] = [];
    const writes: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('ok');
      },
      writeFile: async (p) => {
        writes.push(p);
      },
    });
    const out: Array<Record<string, unknown>> = [];
    const opts = { workspaceDir: WS };
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'i1', op: 'read', path: INSIDE },
      (p) => out.push(p),
      svc as never,
      opts,
    );
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'i2', op: 'write', path: INSIDE, dataBase64: 'eA==' },
      (p) => out.push(p),
      svc as never,
      opts,
    );
    expect(reads).toEqual([INSIDE]);
    expect(writes).toEqual([INSIDE]);
    expect(out[0]).toMatchObject({ requestId: 'i1', ok: true });
    expect(out[1]).toMatchObject({ requestId: 'i2', ok: true });
  });

  it('工作空间外 read → EBADREQ 且不触碰服务', async () => {
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('leak');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'x1', op: 'read', path: path.join(OUTSIDE, 'secret.key') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({
      requestId: 'x1',
      ok: false,
      error: { code: 'EBADREQ', message: '路径越界：文件读写请求超出工作空间' },
    });
  });

  it('工作空间外 write → EBADREQ 且不触碰服务', async () => {
    const writes: string[] = [];
    const svc = fakeSvc({
      writeFile: async (p) => {
        writes.push(p);
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'x2', op: 'write', path: path.join(OUTSIDE, 'evil.bin'), dataBase64: 'eA==' },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(writes).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('readMany 混入单个越界路径 → 整批 EBADREQ 且不触碰服务', async () => {
    const batches: string[][] = [];
    const svc = fakeSvc({
      readFiles: async (ps) => {
        batches.push(ps);
        return ps.map(() => Buffer.from('x'));
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'x3', op: 'readMany', paths: [path.join(WS, 'A.java'), path.join(OUTSIDE, 'secret.key'), path.join(WS, 'B.md')] },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(batches).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('readMany 空数组（边界输入）放行且透传空批', async () => {
    const batches: string[][] = [];
    const svc = fakeSvc({
      readFiles: async (ps) => {
        batches.push(ps);
        return [];
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'e1', op: 'readMany', paths: [] },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(batches).toEqual([[]]);
    expect(out[0]).toMatchObject({ requestId: 'e1', ok: true, items: [] });
  });

  it('兄弟前缀路径（wsfoo.txt）不误伤为工作空间内', async () => {
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('x');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'p1', op: 'read', path: path.join(root, 'wsfoo.txt') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('相对路径（../ 逃逸形态）resolve 后越界 → EBADREQ', async () => {
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('x');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'p2', op: 'read', path: path.join(WS, '..', 'secret.key') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  // ─── M1（2026-11-13 审查）：symlink plant 旁路回归锁 ───────────────────────

  it('M1：工作空间内 symlink 指向外部文件 → read 拒（文本在内、realpath 在外）', async () => {
    const link = path.join(WS, 'leak.key');
    symlinkSync(path.join(OUTSIDE, 'secret.key'), link);
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('leak');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's1', op: 'read', path: link },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('M1：工作空间内 symlink 指向外部文件 → write 拒（防穿透写坏策略外目标）', async () => {
    const link = path.join(WS, 'steal.key');
    symlinkSync(path.join(OUTSIDE, 'secret.key'), link);
    const writes: string[] = [];
    const svc = fakeSvc({
      writeFile: async (p) => {
        writes.push(p);
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's2', op: 'write', path: link, dataBase64: 'eA==' },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(writes).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('M1：symlink 目录本身在空间外（链接整个外部目录）→ 其下路径拒', async () => {
    const linkDir = path.join(WS, 'lnk-out');
    symlinkSync(OUTSIDE, linkDir);
    const reads: string[] = [];
    const svc = fakeSvc({ readFile: async (p) => { reads.push(p); return Buffer.from('x'); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's3', op: 'read', path: path.join(linkDir, 'secret.key') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('M1：symlink 指向工作空间内部 → 放行（正常软链不受影响）', async () => {
    const link = path.join(WS, 'alias.java');
    symlinkSync(path.join(WS, 'A.java'), link);
    const reads: string[] = [];
    const svc = fakeSvc({ readFile: async (p) => { reads.push(p); return Buffer.from('x'); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's4', op: 'read', path: link },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([link]);
    expect(out[0]).toMatchObject({ ok: true });
  });

  it('M1：symlink 环（病态构造）→ realpath 抛错按越界拒（fail-closed）', async () => {
    symlinkSync(path.join(WS, 'loop2'), path.join(WS, 'loop1'));
    symlinkSync(path.join(WS, 'loop1'), path.join(WS, 'loop2'));
    const reads: string[] = [];
    const svc = fakeSvc({ readFile: async (p) => { reads.push(p); return Buffer.from('x'); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's5', op: 'read', path: path.join(WS, 'loop1') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('M1：悬链（dangling symlink）指向外部 → write 拒（防穿透在链接目标处创建文件）', async () => {
    // 悬链 stat 语义不存在——若锚点上溯用 existsSync 会跳到根放行，worker 的
    // writeFileSync 随后穿透悬链在 /outside 处创建 newfile；lstat 锚点 + realpath
    // ENOENT 按越界拒
    const link = path.join(WS, 'dang.newfile');
    symlinkSync(path.join(OUTSIDE, 'newfile'), link);
    const writes: string[] = [];
    const svc = fakeSvc({ writeFile: async (p) => { writes.push(p); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's5b', op: 'write', path: link, dataBase64: 'eA==' },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(writes).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('M1：尚不存在的写目标（父链无 symlink）→ 放行（新建文件场景）', async () => {
    const target = path.join(WS, 'newdir', 'new.java');
    const writes: string[] = [];
    const svc = fakeSvc({ writeFile: async (p) => { writes.push(p); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's6', op: 'write', path: target, dataBase64: 'eA==' },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
    );
    expect(writes).toEqual([target]);
    expect(out[0]).toMatchObject({ ok: true });
  });

  it('M1：工作空间根本身不存在 → fail-closed 全拒（防「删根重建任意目录」旁路）', async () => {
    const ghost = path.join(root, 'ghost-ws');
    const reads: string[] = [];
    const svc = fakeSvc({ readFile: async (p) => { reads.push(p); return Buffer.from('x'); } });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 's7', op: 'read', path: path.join(ghost, 'a.java') },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: ghost },
    );
    expect(reads).toEqual([]);
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });

  it('不传 workspaceDir → 遗留行为：越界路径也放行（既有受信调用方兼容）', async () => {
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('legacy');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    const outsidePath = path.join(OUTSIDE, 'secret.key');
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'l1', op: 'read', path: outsidePath },
      (p) => out.push(p),
      svc as never,
    );
    expect(reads).toEqual([outsidePath]);
    expect(out[0]).toMatchObject({ requestId: 'l1', ok: true });
  });
});
