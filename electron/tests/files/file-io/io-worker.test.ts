// io-worker 协议核心单测：只测纯函数 handleWorkerRequest（循环入口 startWorkerLoop 不在本套件覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleWorkerRequest, type WorkerRequest } from '../../../src/main/files/file-io/io-worker';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ioworker-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('handleWorkerRequest', () => {
  it('read 返回 base64 + size', () => {
    const p = path.join(dir, 'a.java');
    fs.writeFileSync(p, 'class A {}');
    const r = handleWorkerRequest({ id: 7, op: 'read', path: p });
    expect(r).toMatchObject({ id: 7, ok: true, size: 10 });
    expect(Buffer.from(r.dataBase64!, 'base64').toString('utf8')).toBe('class A {}');
  });

  it('read 不存在的文件 → ok:false + 错误码透传', () => {
    const r = handleWorkerRequest({ id: 1, op: 'read', path: path.join(dir, 'none.java') });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ENOENT');
  });

  it('readMany 保持入参顺序，单条失败不影响其余', () => {
    const p1 = path.join(dir, 'a.txt');
    fs.writeFileSync(p1, 'AAA');
    const r = handleWorkerRequest({
      id: 2,
      op: 'readMany',
      paths: [p1, path.join(dir, 'missing.txt')],
    });
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(Buffer.from(r.items![0]!.dataBase64!, 'base64').toString('utf8')).toBe('AAA');
    expect(r.items![1]!.ok).toBe(false);
  });

  it('write 自动创建父目录并落盘', () => {
    const p = path.join(dir, 'nested', 'deep', 'B.java');
    const r = handleWorkerRequest({
      id: 3,
      op: 'write',
      path: p,
      dataBase64: Buffer.from('class B {}').toString('base64'),
    });
    expect(r).toMatchObject({ ok: true, size: 10 });
    expect(fs.readFileSync(p, 'utf8')).toBe('class B {}');
  });

  it('stat 返回 size', () => {
    const p = path.join(dir, 'c.txt');
    fs.writeFileSync(p, '12345');
    expect(handleWorkerRequest({ id: 4, op: 'stat', path: p })).toMatchObject({
      ok: true,
      size: 5,
    });
  });

  it('非法 op → EBADREQ（不崩）', () => {
    const r = handleWorkerRequest({ id: 5, op: 'explode' } as unknown as WorkerRequest);
    expect(r).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });
});
