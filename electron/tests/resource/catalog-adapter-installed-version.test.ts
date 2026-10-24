// electron/tests/resource/catalog-adapter-installed-version.test.ts
//
// D7（M2 Task 1）：ResourceItem.installedVersion——已装版本的透出面。
// 根因（M1 终审 Important）：hub 已装项「可更新」角标锚目录 head 版本（item.version）
// 而非已装版本——目录先行 + 事件迟到时物理旧版显示「已是最新」。数据在
// installed_packages.version 可得；本文件锁 fromCatalogItem 的透出契约：
//   - 已装（marketplace/hub 源）→ installedVersion = 记账行版本（≠ 目录 head）
//   - 未装 → undefined
//   - builtin 源 → undefined（builtin 无记账行，语义为随应用分发）
// 与 renderer types.d.ts / ResourceCard 角标锚点构成三处 boundary 一致（T7）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { fromCatalogItem } from '../../src/main/resource/catalog-adapter';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-catalog-instver-${Date.now()}`);

const HUB_ITEM: MarketplaceItem = {
  id: 'hub:meeting', type: 'agent', slug: 'meeting', name: '会议纪要生成器',
  version: '1.2.0', // 目录 head（发布方已升版；本机还装着 1.0.0）
  author: 'node-a', description: '纪要', readme: '# m', tags: [], category: 'dev',
  iconEmoji: '📝', verificationStatus: 'unverified', downloadUrl: '', checksum: '',
  sizeBytes: 1, installCount: 0,
};

const MKT_ITEM: MarketplaceItem = {
  ...HUB_ITEM, id: 'agent-coder', type: 'agent', slug: 'coder', name: '程序员',
  version: '2.0.0',
};

const BUILTIN_ITEM: MarketplaceItem = { ...HUB_ITEM, id: 'builtin-x', slug: 'x', name: '预置' };

/** 直接落 installed_packages 记账行（镜像 installer.installPackage 落库形状） */
function recordInstalled(itemId: string, itemType: string, slug: string, version: string): void {
  getDb().prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, ?, ?, ?, '', '')`,
  ).run(randomUUID(), itemId, itemType, slug, version);
}

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

describe('fromCatalogItem — installedVersion 透出（D7 角标锚点数据面）', () => {
  it('hub 源已装：installedVersion = 记账版本（≠ 目录 head version）', () => {
    recordInstalled('hub:meeting', 'agent', 'meeting', '1.0.0');
    const r = fromCatalogItem(HUB_ITEM, 'hub');
    expect(r.installed).toBe(true);
    expect(r.version).toBe('1.2.0'); // 目录 head（展示面）
    expect(r.installedVersion).toBe('1.0.0'); // 已装版（角标判定锚点）
  });

  it('marketplace 源已装：同口径透出（同表同判定）', () => {
    recordInstalled('agent-coder', 'agent', 'coder', '1.9.0');
    const r = fromCatalogItem(MKT_ITEM, 'marketplace');
    expect(r.installed).toBe(true);
    expect(r.version).toBe('2.0.0');
    expect(r.installedVersion).toBe('1.9.0');
  });

  it('未装 → installed=false 且 installedVersion 不携带', () => {
    const r = fromCatalogItem(HUB_ITEM, 'hub');
    expect(r.installed).toBe(false);
    expect(r.installedVersion).toBeUndefined();
  });

  it('builtin 源 → installedVersion 恒 undefined（无记账行语义）', () => {
    const r = fromCatalogItem(BUILTIN_ITEM, 'builtin');
    expect(r.installed).toBe(true);
    expect(r.installedVersion).toBeUndefined();
  });
});
