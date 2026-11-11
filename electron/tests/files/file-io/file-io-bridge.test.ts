import { afterEach, describe, expect, it } from 'vitest';
import {
  BridgeContentIo,
  handleFileIoResp,
} from '../../../src/main/files/file-io/file-io-bridge';

const origSend = process.send;
afterEach(() => {
  // 还原 process.send（测试环境本来为 undefined）
  if (origSend === undefined) delete (process as { send?: unknown }).send;
  else (process as { send?: unknown }).send = origSend;
});

describe('file-io-bridge（子进程侧）', () => {
  it('非 fork 环境立即 reject（绝不挂等）', async () => {
    await expect(new BridgeContentIo().readFile('/x')).rejects.toThrow('process.send');
  });

  it('请求经 process.send 以方法调用形式发出，应答经 handleFileIoResp 配对', async () => {
    const sent: Array<Record<string, unknown>> = [];
    (process as { send?: unknown }).send = (msg: Record<string, unknown>) => {
      sent.push(msg);
    };
    const reading = new BridgeContentIo().readFile('/abs/a.java');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'file-io:req', op: 'read', path: '/abs/a.java' });
    const requestId = String(sent[0]!.requestId);
    handleFileIoResp({
      type: 'file-io:resp',
      requestId,
      ok: true,
      dataBase64: Buffer.from('class A {}').toString('base64'),
    });
    expect((await reading).toString('utf8')).toBe('class A {}');
  });

  it('主进程错误载荷 → reject 且 code 保留', async () => {
    const sent: Array<Record<string, unknown>> = [];
    (process as { send?: unknown }).send = (msg: Record<string, unknown>) => sent.push(msg);
    const writing = new BridgeContentIo().writeFile('/abs/b.java', Buffer.from('x'));
    handleFileIoResp({
      type: 'file-io:resp',
      requestId: String(sent[0]!.requestId),
      ok: false,
      error: { code: 'EENCRYPTED', message: '密文' },
    });
    await expect(writing).rejects.toMatchObject({ code: 'EENCRYPTED' });
  });

  it('未知 requestId / 非本协议消息静默忽略', () => {
    expect(() => handleFileIoResp({ type: 'file-io:resp', requestId: 'nope', ok: true })).not.toThrow();
    expect(() => handleFileIoResp({ type: 'other' })).not.toThrow();
  });
});
