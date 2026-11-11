//
// E-SafeNet 容器魔数检测（上游 PoC §9.3「黄金标准」）：前 64 字节是否含
// "E-SafeNet"。direct 读到它 = 通道不对，必须硬失败（spec §5.3）。
const CIPHER_MAGIC = Buffer.from('E-SafeNet', 'latin1');

/** 判断字节流是否为亿赛通加密容器 */
export function looksEncrypted(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 12) return false;
  return buf.subarray(0, 64).indexOf(CIPHER_MAGIC) !== -1;
}
