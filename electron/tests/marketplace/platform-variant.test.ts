// electron/tests/marketplace/platform-variant.test.ts
//
// 引擎整合 T5 RED（spec §4.1）：catalog 平台变体——同一条目挂多平台包，
// 安装侧按 process.platform/arch 精确匹配；无 variants 回退主条目。
import { describe, expect, it } from 'vitest';
import { pickVariant } from '../../src/main/marketplace/platform-variant';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const BASE = {
  id: 'plugin-codegraph',
  type: 'plugin',
  slug: 'codegraph',
  name: 'Codegraph',
  version: '2.0.0',
  author: 'Momo Studio',
  description: '',
  readme: '',
  tags: [],
  category: 'tools',
  iconEmoji: '',
  verificationStatus: 'official',
  downloadUrl: '',
  checksum: '',
  sizeBytes: 0,
  installCount: 0,
} as unknown as MarketplaceItem;

const WITH_VARIANTS = {
  ...BASE,
  downloadUrl: 'https://x/fallback.zip',
  variants: [
    { platform: 'darwin-arm64', downloadUrl: 'https://x/darwin-arm64.zip', checksum: 'a', sizeBytes: 55 },
    { platform: 'darwin-x64', downloadUrl: 'https://x/darwin-x64.zip', checksum: 'b', sizeBytes: 56 },
    { platform: 'linux-x64', downloadUrl: 'https://x/linux-x64.zip', checksum: 'c', sizeBytes: 57 },
  ],
} as unknown as MarketplaceItem;

describe('pickVariant', () => {
  it('精确匹配 darwin/arm64 → 命中对应变体', () => {
    expect(pickVariant(WITH_VARIANTS, 'darwin', 'arm64')).toEqual(
      WITH_VARIANTS.variants?.[0],
    );
  });
  it('无 variants 字段 → 回退主条目（downloadUrl/checksum）', () => {
    expect(pickVariant(BASE, 'darwin', 'arm64')).toEqual({
      downloadUrl: BASE.downloadUrl,
      checksum: BASE.checksum,
      sizeBytes: BASE.sizeBytes,
    });
  });
  it('变体列表无本平台匹配 → null（安装侧报「本平台无可用包」）', () => {
    expect(pickVariant(WITH_VARIANTS, 'win32', 'x64')).toBeNull();
  });
  it('有 variants 但全部不匹配时不回退主条目（避免装错平台包）', () => {
    // 主条目兜底会装到 win32 上错包——宁可 null 让安装侧明示
    expect(pickVariant(WITH_VARIANTS, 'linux', 'arm64')).toBeNull();
  });
});
