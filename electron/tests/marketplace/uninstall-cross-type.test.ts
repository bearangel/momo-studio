// electron/tests/marketplace/uninstall-cross-type.test.ts
//
// T15a-F1 回归锁：installed_packages.item_id（`hub:{slug}`）跨类型碰撞——
// hub agent slug='x' 与本地 zip 插件 id='x' 共用 item_id='hub:x' 时，卸载一方
// 不得误删另一方的记账行与缓存目录（T12 终审 Important①）。
//
// 生产链全真：本地插件经 installPluginZip 真实安装（AdmZip 真包 + installed 目录
// 落位）；hub agent 记账行经 installPackage 真实产出（inline 包真写 cache 目录 +
// DB 行 + agent 定义注册）。零手写中间数据——记账行形状（item_id/item_type/
// cache_path）由生产者落库。
//
// 覆盖：
//   ① 卸载本地 zip 插件（uninstallPlugin 级联 uninstallPackage）→ agent 记账/缓存不动
//   ② 卸载 hub agent（uninstallHubPackage 上下文路由）→ 插件 PluginRecord/目录不动
//   ③ uninstallPackage 直删类型过滤：同 item_id 双类型行并存，删一留一
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { installPackage, uninstallPackage } from '../../src/main/marketplace/installer';
import { installPluginZip, uninstallPlugin } from '../../src/main/plugin/installer';
import { uninstallHubPackage } from '../../src/main/resource/hub-install';
import { getPlugin } from '../../src/main/plugin/registry';
import { resolvePluginInstalledDir } from '../../src/main/paths';
import { hubPackageItemId } from '../../src/main/resource/hub/momo-hub';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xtype-'));
const SLUG = 'x';
const WS = 'ws-xtype';

/** hub agent 目录项（与 toMarketplaceItem 产出同形：id 带 hub: 前缀、无 downloadUrl → inline 链） */
function hubAgentItem(): MarketplaceItem {
  return {
    id: hubPackageItemId(SLUG),
    type: 'agent',
    slug: SLUG,
    name: 'Hub Agent X',
    version: '1.0.0',
    author: 'node-test',
    description: '跨类型碰撞回归用 hub agent',
    readme: '# x\n\n碰撞回归。',
    tags: ['test'],
    category: 'dev',
    iconEmoji: '🤖',
    verificationStatus: 'unverified',
    downloadUrl: '',
    checksum: '',
    sizeBytes: 1,
    installCount: 0,
  };
}

/** 本地 zip 插件包（id 与 hub agent slug 同名——碰撞前提） */
function zipPlugin(): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'momo-plugin.json',
    Buffer.from(
      JSON.stringify({
        id: SLUG,
        name: 'Collide',
        version: '0.1.0',
        description: '与 hub agent 同名 slug 的本地插件',
        components: { tools: './tools' },
      }),
    ),
  );
  zip.addFile('tools/main.js', Buffer.from('module.exports.createTools = () => ({});'));
  return zip.toBuffer();
}

function agentRow(): unknown {
  return getDb()
    .prepare("SELECT id FROM installed_packages WHERE item_id = ? AND item_type = 'agent'")
    .get(hubPackageItemId(SLUG));
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'T', '/tmp/x', '@o')`,
    )
    .run(WS);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('T15a-F1：hub:{slug} 跨类型记账碰撞', () => {
  it('① 卸载本地 zip 插件 → 同名 hub agent 的记账行与缓存目录不动', async () => {
    await installPluginZip(zipPlugin(), '2.1.0', WS);
    const { cachePath } = await installPackage(hubAgentItem());
    expect(fs.existsSync(path.join(cachePath, 'manifest.yaml'))).toBe(true);

    await uninstallPlugin(SLUG, true);

    expect(getPlugin(SLUG)).toBeNull(); // 插件本体确已卸载
    // 记账行仍在 + 缓存目录仍在（修复前：级联 uninstallPackage 无类型过滤，连坐清掉）
    expect(agentRow()).toBeDefined();
    expect(fs.existsSync(path.join(cachePath, 'manifest.yaml'))).toBe(true);
  });

  it('② 卸载 hub agent → 本地 zip 插件的 PluginRecord 与 installed 目录不动', async () => {
    await installPluginZip(zipPlugin(), '2.1.0', WS);
    const { cachePath } = await installPackage(hubAgentItem());
    const pluginDir = resolvePluginInstalledDir(SLUG, '0.1.0');

    uninstallHubPackage('agent', SLUG);

    // agent 记账行与缓存确已删除（删对了目标）
    expect(agentRow()).toBeUndefined();
    expect(fs.existsSync(cachePath)).toBe(false);
    // 插件面原封不动
    expect(getPlugin(SLUG)).not.toBeNull();
    expect(fs.existsSync(path.join(pluginDir, 'momo-plugin.json'))).toBe(true);
  });

  it('③ uninstallPackage 类型过滤直删：同 item_id 双类型行并存，删一留一（含缓存）', async () => {
    const agentPkg = await installPackage(hubAgentItem());
    const skillPkg = await installPackage({
      ...hubAgentItem(),
      type: 'skill',
      name: 'Hub Skill X',
    });
    expect(agentRow()).toBeDefined();

    uninstallPackage(hubPackageItemId(SLUG), 'agent');

    expect(agentRow()).toBeUndefined();
    expect(fs.existsSync(agentPkg.cachePath)).toBe(false);
    // skill 行与缓存原封不动
    const skillRow = getDb()
      .prepare("SELECT id FROM installed_packages WHERE item_id = ? AND item_type = 'skill'")
      .get(hubPackageItemId(SLUG));
    expect(skillRow).toBeDefined();
    expect(fs.existsSync(skillPkg.cachePath)).toBe(true);
  });
});
