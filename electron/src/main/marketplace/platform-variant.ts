// electron/src/main/marketplace/platform-variant.ts
//
// 引擎整合 T5（spec §4.1）：catalog 平台变体选择——插件类条目同 id 挂
// 多平台包，安装侧按本机 platform/arch 精确匹配。有变体但无本平台匹配时
// 返回 null（不回退主条目——宁可明示无包，避免装错平台引擎包）。
import type { MarketplaceItem, MarketplaceVariant } from './types';

/** platform 形如 'darwin'，arch 形如 'arm64'（process.platform/arch 原样入参） */
export function pickVariant(
  item: Pick<MarketplaceItem, 'downloadUrl' | 'checksum' | 'sizeBytes' | 'variants'>,
  platform: string,
  arch: string,
): MarketplaceVariant | { downloadUrl: string; checksum: string; sizeBytes: number } | null {
  if (!item.variants || item.variants.length === 0) {
    return { downloadUrl: item.downloadUrl, checksum: item.checksum, sizeBytes: item.sizeBytes };
  }
  const target = `${platform}-${arch}`;
  return item.variants.find((v) => v.platform === target) ?? null;
}
