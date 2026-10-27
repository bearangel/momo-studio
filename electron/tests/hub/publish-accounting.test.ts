// electron/tests/hub/publish-accounting.test.ts
//
// 发布成功回填 hub 记账（M2.2 §2.1 泛化版回归锁——plugin 专版先例 ba7cce8f 推广）：
// 任一类型资源（agent/skill/mcp/plugin）发布到 hub 成功后本地 installed_packages
// 写 `hub:{slug}` 记账行，两个消费面：
//   1. 镜像快照构建器 resources 段（snapshot-builder 以记账反查携带）
//   2. 目标节点 installResources 已装判定①（mirror-applier loadHubAccountingSet）
// 缺行 = 分发断链（全新目标 unresolvedRefs 残留——M2.1 path2 实测形态）。
//
// 断言锚点（M2.2 Task 1 契约）：
//   1. 四类各：回填后 hub:{slug} 行落对（item_type/slug/version/checksum/cache_path）
//   2. 幂等升版：同 slug 同类型重复回填只留一行且 version/checksum 更新
//   3. 跨类型不牵连（T15a-F1）：DELETE 带 item_type——同 slug 异类行不动
//   4. Safe 壳：DB 故障注入只 warn 不抛（发布回执不翻转——§2.1 硬化）；裸函数仍上抛
//   5. 卸载竞态：卸载后立即重发回填零残留零幽灵
//   6. 同类型双源共存：marketplace 已装行 + hub 回填行并存——hub 页签不双卡、
//      卸载不互删（两个方向）
//   7. cache_path 约定：回填行 cache_path=''——卸载链 rm 空串无操作，不误伤真实目录
//   8. ipc 接线在 tests/hub/ipc.test.ts（mock 层四类型断言）
//
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 指向临时目录 + runMigrations() +
// closeDb() 复位单例。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { logger } from '../../src/main/logger';
import { hubPackageItemId, HUB_ITEM_ID_PREFIX } from '../../src/main/resource/hub/momo-hub';
import {
  recordPublishAccounting,
  recordPublishAccountingSafe,
  uninstallHubPackage,
  listHubCatalogResources,
} from '../../src/main/resource/hub-install';
import { uninstallPackage } from '../../src/main/marketplace/installer';

const tmpRoot = path.join(os.tmpdir(), `ap-publish-acc-${Date.now()}`);

/** 四类发布类型全集（与 publish.ts PublishResourceType 对齐） */
const TYPES = ['agent', 'skill', 'mcp', 'plugin'] as const;
type PubType = (typeof TYPES)[number];

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

/** 按 item_id + item_type 查记账行（uninstallPackage 同款双键圈定） */
function rowsOf(itemId: string, itemType: string): Array<Record<string, string>> {
  return getDb()
    .prepare('SELECT item_id, item_type, slug, version, cache_path, checksum FROM installed_packages WHERE item_id = ? AND item_type = ?')
    .all(itemId, itemType) as Array<Record<string, string>>;
}

/** 直插一行记账（模拟异类行 / marketplace 已装行） */
function seedRow(id: string, itemId: string, itemType: string, slug: string, version: string, cachePath: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, ?, ?, ?, ?, '')`,
    )
    .run(id, itemId, itemType, slug, version, cachePath);
}

describe('recordPublishAccounting（四类发布回填 hub 记账）', () => {
  it('四类各：回填后 installed_packages 有 hub:{slug} 行（type/slug/version/checksum 落对）', () => {
    for (const type of TYPES) {
      recordPublishAccounting(type, `pub-${type}`, '1.2.0', `sum-${type}`);
    }

    const rows = getDb()
      .prepare('SELECT item_id, item_type, slug, version, checksum FROM installed_packages ORDER BY item_type')
      .all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(4);
    for (const type of TYPES) {
      expect(rows).toContainEqual({
        item_id: hubPackageItemId(`pub-${type}`),
        item_type: type,
        slug: `pub-${type}`,
        version: '1.2.0',
        checksum: `sum-${type}`,
      });
    }
  });

  it('幂等升版：同 slug 同类型重复回填（升版本）单行更新不叠行', () => {
    for (const type of TYPES) {
      recordPublishAccounting(type, 'up-slug', '1.0.0', 'a');
      recordPublishAccounting(type, 'up-slug', '1.0.1', 'b');
    }

    const rows = getDb()
      .prepare('SELECT item_type, version, checksum FROM installed_packages WHERE item_id = ? ORDER BY item_type')
      .all(hubPackageItemId('up-slug')) as Array<{ item_type: string; version: string; checksum: string }>;
    // 每类型恰一行（四类同行数），且全部为新版本值
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.version).toBe('1.0.1');
      expect(r.checksum).toBe('b');
    }
  });

  it('跨类型不牵连（T15a-F1）：同 slug 其余三类记账行不被回填抹掉', () => {
    // 预插 agent/mcp/plugin 三行（同 slug 异类），回填 skill
    for (const other of ['agent', 'mcp', 'plugin'] as const) {
      seedRow(`seed-${other}`, hubPackageItemId('multi-slug'), other, 'multi-slug', '0.9.0', '');
    }
    recordPublishAccounting('skill', 'multi-slug', '2.0.0', 'sk-sum');

    // 四行共存：异类三行原样（version 0.9.0），skill 行为回填值
    for (const other of ['agent', 'mcp', 'plugin'] as const) {
      const rows = rowsOf(hubPackageItemId('multi-slug'), other);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe('0.9.0');
    }
    const skillRows = rowsOf(hubPackageItemId('multi-slug'), 'skill');
    expect(skillRows).toHaveLength(1);
    expect(skillRows[0]?.version).toBe('2.0.0');
    expect(skillRows[0]?.checksum).toBe('sk-sum');
  });

  it('Safe 壳：DB 故障注入只 warn 不抛（发布回执不翻转）；裸函数同故障仍上抛', () => {
    // 故障注入：在 Database 原型 prepare 上抛错（hub-install 经 getDb() 拿同一实例）
    const db = getDb();
    type DbProto = { prepare: (sql: string) => unknown };
    const proto = Object.getPrototypeOf(db) as DbProto;
    const fault = vi
      .spyOn(proto, 'prepare')
      .mockImplementation(() => {
        throw new Error('mock DB 故障注入');
      });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // 裸函数上抛（供需要严格记账的调用方感知失败）
      expect(() => recordPublishAccounting('skill', 'safe-skill', '1.0.0', 'x')).toThrow('mock DB 故障注入');
      // Safe 壳吞掉故障：发布已在 hub 侧成功，记账缺行不得翻转发布回执
      expect(() => recordPublishAccountingSafe('skill', 'safe-skill', '1.0.0', 'x')).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      // warn 载荷可检索（type/slug 定位——缺行排查入口）
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('发布记账回填失败'),
        expect.objectContaining({ type: 'skill', slug: 'safe-skill' }),
      );
    } finally {
      fault.mockRestore();
      warn.mockRestore();
    }
  });

  it('卸载竞态：uninstallHubPackage 后立即重发回填零残留零幽灵', () => {
    // skill（marketplace 缓存链卸载路径）与 plugin（注册行缺席 → 类型限定直删兜底）双轨
    const cases: Array<[PubType, string]> = [
      ['skill', 'race-skill'],
      ['plugin', 'race-plugin'],
    ];
    for (const [type, slug] of cases) {
      recordPublishAccounting(type, slug, '1.0.0', 'a');
      uninstallHubPackage(type, slug);
      // 卸载后零残留
      expect(rowsOf(hubPackageItemId(slug), type)).toHaveLength(0);

      // 立即重发回填（卸载与发布紧邻的窗口）→ 恰一行、版本为新值（无幽灵叠行）
      recordPublishAccounting(type, slug, '1.1.0', 'b');
      const after = rowsOf(hubPackageItemId(slug), type);
      expect(after).toHaveLength(1);
      expect(after[0]?.version).toBe('1.1.0');
      expect(after[0]?.checksum).toBe('b');
    }
  });

  it('同类型双源共存：marketplace 已装行 + hub 回填行并存——hub 页签不双卡、卸载不互删', async () => {
    // marketplace 已装行（superpowers 类形态：item_id 无 hub: 前缀、cache_path 指真实缓存目录）
    const mktCache = path.join(tmpRoot, 'mkt-cache', 'superpowers', '1.0.0');
    fs.mkdirSync(mktCache, { recursive: true });
    fs.writeFileSync(path.join(mktCache, 'SKILL.md'), '---\nname: x\n---\n');
    seedRow('mkt-1', 'skill-superpowers', 'skill', 'superpowers', '1.0.0', mktCache);

    // 发布回填 hub 行（同 slug 同类型、异 item_id）
    recordPublishAccounting('skill', 'superpowers', '2.0.0', 'hub-sum');

    // 两行共存（回填 DELETE 只圈 hub:{slug}，不触碰 marketplace 行）
    expect(rowsOf('skill-superpowers', 'skill')).toHaveLength(1);
    expect(rowsOf(hubPackageItemId('superpowers'), 'skill')).toHaveLength(1);

    // hub 页签不双卡：listHubCatalogResources 只出一张 hub 卡，marketplace 行不泄漏
    //（未接入 hub → 目录空 → 兜底行路径；marketplace 行因无 hub: 前缀被跳过）
    const hubView = await listHubCatalogResources('skill');
    const cards = hubView.filter((r) => r.slug === 'superpowers');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.source).toBe('hub');
    expect(cards[0]?.installed).toBe(true);

    // hub 链读取面（mirror-applier loadHubAccountingSet 同款查询——已装判定①数据源）：
    // hub: 前缀行入集，marketplace 行不入集（不污染、不双计）
    const accRows = getDb()
      .prepare('SELECT item_id, item_type FROM installed_packages')
      .all() as Array<{ item_id: string; item_type: string }>;
    const hubSlugs = new Set(
      accRows
        .filter((r) => r.item_id.startsWith(HUB_ITEM_ID_PREFIX) && r.item_type === 'skill')
        .map((r) => r.item_id.slice(HUB_ITEM_ID_PREFIX.length)),
    );
    expect(hubSlugs.has('superpowers')).toBe(true);
    expect(hubSlugs.size).toBe(1);

    // 卸载方向一：卸 hub 行 → marketplace 行与缓存目录原样
    uninstallHubPackage('skill', 'superpowers');
    expect(rowsOf(hubPackageItemId('superpowers'), 'skill')).toHaveLength(0);
    expect(rowsOf('skill-superpowers', 'skill')).toHaveLength(1);
    expect(fs.existsSync(path.join(mktCache, 'SKILL.md'))).toBe(true);

    // 卸载方向二：重发回填后卸 marketplace 行（直链 uninstallPackage）→ 缓存目录按
    // marketplace 语义删除，但 hub 行不受牵连
    recordPublishAccounting('skill', 'superpowers', '2.0.0', 'hub-sum');
    uninstallPackage('skill-superpowers', 'skill');
    expect(fs.existsSync(mktCache)).toBe(false);
    expect(rowsOf(hubPackageItemId('superpowers'), 'skill')).toHaveLength(1);
  });

  it('cache_path 约定：skill/mcp 回填行 cache_path 为空——卸载链 rm 空串无操作，不误伤真实目录', () => {
    // 哨兵目录：证明卸载 hub 回填行不会经 cache_path 目录删除语义带走任何真实路径
    //（rm '' 在 Node 层是无操作——不解析为 cwd 或根目录）
    const sentinel = path.join(tmpRoot, 'sentinel-dir');
    fs.mkdirSync(sentinel, { recursive: true });
    fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'x');

    recordPublishAccounting('skill', 'cp-skill', '1.0.0', 's');
    recordPublishAccounting('mcp', 'cp-mcp', '1.0.0', 'm');

    for (const [type, slug] of [
      ['skill', 'cp-skill'],
      ['mcp', 'cp-mcp'],
    ] as Array<[PubType, string]>) {
      const rows = rowsOf(hubPackageItemId(slug), type);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cache_path).toBe('');
    }

    // 卸载全链（uninstallPackage 的 rm cache_path 路径）零抛错 + 哨兵原样
    expect(() => uninstallHubPackage('skill', 'cp-skill')).not.toThrow();
    expect(() => uninstallHubPackage('mcp', 'cp-mcp')).not.toThrow();
    expect(fs.existsSync(path.join(sentinel, 'keep.txt'))).toBe(true);
    expect(rowsOf(hubPackageItemId('cp-skill'), 'skill')).toHaveLength(0);
    expect(rowsOf(hubPackageItemId('cp-mcp'), 'mcp')).toHaveLength(0);
  });
});
