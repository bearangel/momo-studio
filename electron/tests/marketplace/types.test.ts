// electron/tests/marketplace/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Catalog, MarketplaceItem } from '../../src/main/marketplace/types';

describe('marketplace/types', () => {
  it('Catalog 包含 items 数组', () => {
    const catalog: Catalog = { version: '1.0', updatedAt: '2026-01-01', items: [] };
    expect(catalog.items).toEqual([]);
  });

  it('MarketplaceItem 含所有字段', () => {
    const item: MarketplaceItem = {
      id: 'test',
      type: 'agent',
      slug: 'test',
      name: '测试',
      version: '1.0.0',
      author: 'test',
      description: 'desc',
      readme: '# Test',
      tags: [],
      category: 'dev',
      iconEmoji: '🤖',
      verificationStatus: 'official',
      downloadUrl: 'https://example.com/pkg.tar.gz',
      checksum: 'abc123',
      sizeBytes: 100,
      installCount: 0,
    };
    expect(item.type).toBe('agent');
  });
});
