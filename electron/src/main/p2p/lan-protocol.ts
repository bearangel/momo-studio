// electron/src/main/p2p/lan-protocol.ts
//
// 局域网传输协议——TCP 上层 JSON 帧（行分隔）。
//
// 帧结构：v(1) + fromNodeId + signature + payload
//   - 签名验证：fromNodeId 字段（hex 公钥）+ payload JSON → sign
//   - 接收方查 trustStore 拿公钥，verify
//
// 行分隔：每个帧用换行符分隔（避免 TCP 粘包问题，JSON 内部不允许裸换行——
// 实际 JSON.stringify 不产生裸换行）。
import type { MessagePayload } from './types';

export interface LanFrame {
  v: 1;
  fromNodeId: string;
  signature: string;
  payload: MessagePayload;
}

/**
 * 编码 LanFrame 为带换行符的 Buffer（行分隔协议）。
 * 单个帧 = JSON.stringify(frame) + '\n'。
 */
export function encodeFrame(frame: LanFrame): Buffer {
  return Buffer.from(JSON.stringify(frame) + '\n', 'utf-8');
}

/**
 * 解码 Buffer 为 LanFrame。
 * 任何不一致（JSON 解析失败 / 版本不匹配 / 字段缺失 / 空 Buffer）都返回 null，
 * 调用方按"丢弃坏帧"处理。
 */
export function decodeFrame(buf: Buffer): LanFrame | null {
  try {
    const text = buf.toString('utf-8').trim();
    if (!text) return null;
    const obj = JSON.parse(text) as LanFrame;
    if (obj.v !== 1) return null;
    if (typeof obj.fromNodeId !== 'string') return null;
    if (typeof obj.signature !== 'string') return null;
    if (typeof obj.payload !== 'object' || obj.payload === null) return null;
    return obj;
  } catch {
    return null;
  }
}
