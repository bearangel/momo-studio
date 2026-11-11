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
