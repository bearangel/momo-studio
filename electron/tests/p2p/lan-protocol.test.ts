// electron/tests/p2p/lan-protocol.test.ts
//
// lan-protocol（C 子系统 C3，v2 安全修复后）测试：
//   - encode + decode 往返：帧字段完整还原（v/nonce/ciphertext/signature）
//   - decode 损坏数据返回 null：garbage / 空串都不可解析
//   - decode 版本不匹配返回 null：v !== 2 视为不兼容帧
//   - v1 明文帧（旧协议：payload 裸露在帧内）被拒绝——降级攻击防护
//   - 字段缺失 / 类型错误返回 null
//
// 不依赖网络/文件 IO，纯内存编解码。
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, type LanFrame } from '../../src/main/p2p/lan-protocol';

function mkFrame(): LanFrame {
  return {
    v: 2,
    fromNodeId: 'node_abc123',
    nonce: 'bm9uY2U=', // 任意 base64——解码层不校验语义，由传输层负责
    ciphertext: 'Y2lwaGVydGV4dA==',
    signature: 'c2lnLWJhc2U2NA==',
  };
}

describe('lan-protocol', () => {
  it('encode + decode 往返（v2 加密帧）', () => {
    const frame = mkFrame();
    const buf = encodeFrame(frame);
    // 行分隔协议：编码产物以换行符结尾
    expect(buf[buf.length - 1]).toBe(0x0a);
    const decoded = decodeFrame(buf);
    expect(decoded).not.toBeNull();
    expect(decoded?.v).toBe(2);
    expect(decoded?.fromNodeId).toBe('node_abc123');
    expect(decoded?.nonce).toBe(frame.nonce);
    expect(decoded?.ciphertext).toBe(frame.ciphertext);
    expect(decoded?.signature).toBe(frame.signature);
  });

  it('decode 损坏数据返回 null', () => {
    expect(decodeFrame(Buffer.from('garbage'))).toBeNull();
    expect(decodeFrame(Buffer.from(''))).toBeNull();
  });

  it('decode 版本不匹配返回 null（v !== 2）', () => {
    const buf = Buffer.from(JSON.stringify({
      v: 99,
      fromNodeId: 'x',
      nonce: 'n',
      ciphertext: 'c',
      signature: 's',
    }));
    expect(decodeFrame(buf)).toBeNull();
  });

  it('v1 明文帧被拒绝——旧协议 payload 字段裸露，不可再进入处理链', () => {
    const v1Frame = {
      v: 1,
      fromNodeId: 'node_abc123',
      signature: 'sig-base64',
      payload: { targetNodeId: 'node_xyz', type: 'message', body: { text: '明文内容' } },
    };
    expect(decodeFrame(Buffer.from(JSON.stringify(v1Frame)))).toBeNull();
  });

  it('字段缺失 / 类型错误返回 null', () => {
    const base = {
      v: 2,
      fromNodeId: 'node_abc123',
      nonce: 'n',
      ciphertext: 'c',
      signature: 's',
    };
    expect(decodeFrame(Buffer.from(JSON.stringify({ ...base, nonce: undefined })))).toBeNull();
    expect(decodeFrame(Buffer.from(JSON.stringify({ ...base, ciphertext: 123 })))).toBeNull();
    expect(decodeFrame(Buffer.from(JSON.stringify({ ...base, signature: null })))).toBeNull();
    expect(decodeFrame(Buffer.from(JSON.stringify({ ...base, fromNodeId: 42 })))).toBeNull();
  });
});
