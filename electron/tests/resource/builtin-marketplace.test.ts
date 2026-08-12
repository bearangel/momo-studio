// electron/tests/resource/builtin-marketplace.test.ts
//
// v1.7 Task 2：builtin + marketplace 两源的 list 函数测试。
// 覆盖：
//   - builtin 过滤 downloadUrl="" 项 + installed/installable/removable 标记 + id 命名 + marketplace 元数据保留
//   - marketplace 过滤 downloadUrl 非空项 + installable/removable（未装态）+ id 命名
//
// DB 隔离：fromCatalogItem 内部调用 marketplace/installer.listInstalled() → getDb()，
// 因此每个用例 runMigrations() 建 installed_packages 表（空表），closeDb() 收尾。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { listBuiltinResources } from '../../src/main/resource/builtin';
import { listMarketplaceResources } from '../../src/main/resource/marketplace';
import type { Catalog } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-resource-task2-test-${Date.now()}`);

const mockCatalog: Catalog = {
  version: '1.0',
  updatedAt: '2026-08-11T00:00:00Z',
  items: [
    // 内联预置（downloadUrl 空）→ builtin 源
    {
      id: 'agent-pm',
      type: 'agent',
      slug: 'pm-agent',
      name: '项目经理',
      version: '1.0.0',
      author: 'Momo Studio',
      description: '协调',
      readme: '...',
      tags: [],
      category: 'dev',
      iconEmoji: '👔',
      verificationStatus: 'official',
      downloadUrl: '',
      checksum: '',
      sizeBytes: 2048,
      installCount: 0,
    },
    // 真远程下载（downloadUrl 非空）→ marketplace 源
    {
      id: 'skill-remote',
      type: 'skill',
      slug: 'remote-skill',
      name: 'Remote',
      version: '2.0.0',
      author: '@thirdparty',
      description: '远程',
      readme: '...',
      tags: ['remote'],
      category: 'community',
      iconEmoji: '🌐',
      verificationStatus: 'community',
      downloadUrl: 'https://example.com/skill.zip',
      checksum: 'abc123',
      sizeBytes: 10240,
      installCount: 5,
    },
  ],
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('listBuiltinResources', () => {
  it('只返回 downloadUrl="" 的 catalog 项', () => {
    const items = listBuiltinResources(mockCatalog);
    expect(items).toHaveLength(1);
    expect(items[0]!.slug).toBe('pm-agent');
    expect(items[0]!.source).toBe('builtin');
  });

  it('builtin 项 installed=true / installable=false / removable=false', () => {
    const items = listBuiltinResources(mockCatalog);
    expect(items[0]).toMatchObject({
      installed: true,
      installable: false,
      removable: false,
    });
  });

  it('builtin 项 id 形如 builtin-${type}-${slug}', () => {
    const items = listBuiltinResources(mockCatalog);
    expect(items[0]!.id).toBe('builtin-agent-pm-agent');
  });

  it('包含 marketplace 字段（保留原 catalog 元数据，详情面板用）', () => {
    const items = listBuiltinResources(mockCatalog);
    expect(items[0]!.marketplace).toMatchObject({
      author: 'Momo Studio',
      verificationStatus: 'official',
      tags: [],
    });
  });
});

describe('listMarketplaceResources', () => {
  it('只返回 downloadUrl 非空的 catalog 项', () => {
    const items = listMarketplaceResources(mockCatalog);
    expect(items).toHaveLength(1);
    expect(items[0]!.slug).toBe('remote-skill');
    expect(items[0]!.source).toBe('marketplace');
  });

  it('marketplace 项 installable=true / removable=false（未装时可 install）', () => {
    const items = listMarketplaceResources(mockCatalog);
    expect(items[0]).toMatchObject({
      installable: true,
      removable: false,
    });
  });

  it('marketplace 项 id 形如 marketplace-${type}-${slug}', () => {
    const items = listMarketplaceResources(mockCatalog);
    expect(items[0]!.id).toBe('marketplace-skill-remote-skill');
  });
});
