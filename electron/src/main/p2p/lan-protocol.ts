// electron/src/main/p2p/lan-protocol.ts
//
// 局域网传输协议——TCP 上层 JSON 帧（行分隔）。
//
// 帧结构（v2，sign-then-encrypt）：
//   { v: 2, fromNodeId, nonce, ciphertext, signature }
//   - ciphertext = secretbox(JSON.stringify(payload))，
//     共享密钥 = X25519 DH(己方 box 私钥, 信任库中对端 box 公钥)
//   - signature = Ed25519 签名私钥对 ciphertext 原始字节的 detached 签名
//   - 接收方从信任库取对端签名公钥验签、box 公钥派生解密——两者都不采信帧自带数据
//
// 安全注记（v1 → v2，安全修复）：
//   - v1 帧为"仅签名不加密"——局域网嗅探可直接读取全部 payload。v2 起整帧密文化，
//     接收方只认 v2（decodeFrame 对 v !== 2 一律返回 null，v1 明文帧按坏帧丢弃）
//   - nonce 未入签名，但 secretbox 的 Poly1305 MAC 覆盖 nonce——篡改 nonce 会导致
//     解密失败，不构成攻击面
//
// 行分隔：每个帧用换行符分隔（避免 TCP 粘包问题，JSON.stringify 不产生裸换行）。
export interface LanFrame {
  /** 协议版本——v2 = 加密帧（v1 明文帧已废弃） */
  v: 2;
  /** 发送方节点 ID（明文——接收方据此查信任库，签名保证其不可伪造） */
  fromNodeId: string;
  /** secretbox nonce（base64，24 字节） */
  nonce: string;
  /** payload JSON 的 secretbox 密文（base64） */
  ciphertext: string;
  /** Ed25519 detached 签名（base64）——签名对象为 ciphertext 解码后的原始字节 */
  signature: string;
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
 * 调用方按"丢弃坏帧"处理。v1 明文帧在此被拒绝（版本不匹配）。
 */
export function decodeFrame(buf: Buffer): LanFrame | null {
  try {
    const text = buf.toString('utf-8').trim();
    if (!text) return null;
    const obj = JSON.parse(text) as LanFrame;
    if (obj.v !== 2) return null;
    if (typeof obj.fromNodeId !== 'string') return null;
    if (typeof obj.nonce !== 'string') return null;
    if (typeof obj.ciphertext !== 'string') return null;
    if (typeof obj.signature !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
