import { describe, expect, it } from 'vitest';
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

describe('handleFileIoRequestMsg 工作空间囚禁（I1：opts.workspaceDir）', () => {
  const WS = '/ws';
  const INSIDE = '/ws/src/A.java';
  const OUTSIDE = '/etc/passwd';

  it('工作空间内 read / write 正常放行', async () => {
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
      { type: 'file-io:req', requestId: 'x1', op: 'read', path: OUTSIDE },
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
      { type: 'file-io:req', requestId: 'x2', op: 'write', path: OUTSIDE, dataBase64: 'eA==' },
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
      { type: 'file-io:req', requestId: 'x3', op: 'readMany', paths: [INSIDE, OUTSIDE, '/ws/B.md'] },
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

  it('兄弟前缀路径（/wsfoo.txt）不误伤为工作空间内', async () => {
    const reads: string[] = [];
    const svc = fakeSvc({
      readFile: async (p) => {
        reads.push(p);
        return Buffer.from('x');
      },
    });
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'p1', op: 'read', path: '/wsfoo.txt' },
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
      { type: 'file-io:req', requestId: 'p2', op: 'read', path: '/ws/../secret.key' },
      (p) => out.push(p),
      svc as never,
      { workspaceDir: WS },
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
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'l1', op: 'read', path: OUTSIDE },
      (p) => out.push(p),
      svc as never,
    );
    expect(reads).toEqual([OUTSIDE]);
    expect(out[0]).toMatchObject({ requestId: 'l1', ok: true });
  });
});
