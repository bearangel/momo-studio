// electron/tests/p2p/lan-protocol.test.ts
//
// lan-protocol（C 子系统 C3）测试：
//   - encode + decode 往返：帧字段 + payload.body 完整还原
//   - decode 损坏数据返回 null：garbage / 空串都不可解析
//   - decode 版本不匹配返回 null：v !== 1 视为不兼容帧
//
// 不依赖网络/文件 IO，纯内存编解码。
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, type LanFrame } from '../../src/main/p2p/lan-protocol';

describe('lan-protocol', () => {
  it('encode + decode 往返', () => {
    const frame: LanFrame = {
      v: 1,
      fromNodeId: 'node_abc123',
      signature: 'sig-base64',
      payload: { targetNodeId: 'node_xyz', type: 'message', body: { text: 'hi' } },
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    expect(decoded).not.toBeNull();
    expect(decoded?.fromNodeId).toBe('node_abc123');
    expect(decoded?.payload.body).toEqual({ text: 'hi' });
  });

  it('decode 损坏数据返回 null', () => {
    expect(decodeFrame(Buffer.from('garbage'))).toBeNull();
    expect(decodeFrame(Buffer.from(''))).toBeNull();
  });

  it('decode 版本不匹配返回 null', () => {
    const buf = Buffer.from(JSON.stringify({ v: 99, fromNodeId: 'x', signature: '', payload: {} }));
    expect(decodeFrame(buf)).toBeNull();
  });
});
