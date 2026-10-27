// electron/tests/hub/publish-accounting.test.ts
//
// 发布成功回填 hub 记账（P2 修复回归锁——2026-10-27 path2 验收发现）：
// plugin 发布到 hub 成功后本地 installed_packages 写 `hub:{slug}` 记账行，
// 使镜像快照构建器 collectPlugins 的记账反查命中（插件入 pluginsEnabled +
// resources 补装位），闭合「发布 → 镜像自带引用」分发链。
//
// 断言锚点（与 installHubPackage 记账同构，tests/plugin/hub-install.test.ts ⑤）：
//   1. 回填后出现 item_type='plugin' 行（slug/version/checksum 落对）
//   2. 幂等：同 slug 重复发布（升版本）只留一行且 version 更新
//   3. 跨类型不牵连（T15a-F1 语义）：同 slug 的 agent 记账行不被回填抹掉
//   4. 卸载级联（uninstallHubPackage plugin 分支）同样清掉发布回填行——
//      防幽灵行（插件卸载后 hub 页签不得残留「已发布」记账）
//
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 指向临时目录 + runMigrations() +
// closeDb() 复位单例。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { hubPackageItemId } from '../../src/main/resource/hub/momo-hub';
import {
  recordPluginPublishAccounting,
  uninstallHubPackage,
} from '../../src/main/resource/hub-install';

const tmpRoot = path.join(os.tmpdir(), `ap-publish-acc-${Date.now()}`);

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

describe('recordPluginPublishAccounting（发布回填 hub 记账）', () => {
  it('回填后出现 hub:{slug} plugin 记账行，slug/version/checksum 落对', () => {
    recordPluginPublishAccounting('codegraph', '2.0.0', 'deadbeef');

    const row = getDb()
      .prepare('SELECT item_id, item_type, slug, version, checksum FROM installed_packages')
      .get() as Record<string, string>;
    expect(row).toBeDefined();
    expect(row.item_id).toBe(hubPackageItemId('codegraph'));
    expect(row.item_type).toBe('plugin');
    expect(row.slug).toBe('codegraph');
    expect(row.version).toBe('2.0.0');
    expect(row.checksum).toBe('deadbeef');
  });

  it('幂等：同 slug 重复发布（升版本）只留一行且 version 更新', () => {
    recordPluginPublishAccounting('codegraph', '2.0.0', 'a');
    recordPluginPublishAccounting('codegraph', '2.0.1', 'b');

    const rows = getDb()
      .prepare('SELECT version, checksum FROM installed_packages')
      .all() as Array<{ version: string; checksum: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe('2.0.1');
    expect(rows[0]?.checksum).toBe('b');
  });

  it('跨类型不牵连：同 slug 的 agent 记账行不被 plugin 回填抹掉（T15a-F1）', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES ('acc-agent-1', ?, 'agent', 'codegraph', '1.0.0', '', 'x')`,
    ).run(hubPackageItemId('codegraph'));

    recordPluginPublishAccounting('codegraph', '2.0.0', 'deadbeef');

    const types = (
      db
        .prepare('SELECT item_type FROM installed_packages ORDER BY item_type')
        .all() as Array<{ item_type: string }>
    ).map((r) => r.item_type);
    expect(types).toEqual(['agent', 'plugin']);
  });

  it('卸载级联清掉发布回填行（防幽灵行）', () => {
    recordPluginPublishAccounting('codegraph', '2.0.0', 'deadbeef');
    // 插件本体不存在（发布场景源是本地目录）——uninstall 走 plugin 级联的
    // 「记账行清理」路径，即便插件注册行缺席也须清账
    uninstallHubPackage('plugin', 'codegraph');

    const row = getDb()
      .prepare("SELECT id FROM installed_packages WHERE item_id = ? AND item_type = 'plugin'")
      .get(hubPackageItemId('codegraph'));
    expect(row).toBeUndefined();
  });
});
