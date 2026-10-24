// electron/tests/plugin/hub-install.test.ts
//
// T12：hub 插件安装链——与本地安装等价（momo-hub M1 spec §6.2 / Task 12）。
//
// 测试形态：进程内 node:http 真 mock hub（catalog + download 真 tar.gz 流），
// 生产链全真：HubProvider 目录源（plugin 过滤解开后）→ installHubPackage plugin
// 分支 → 下载（信任集放行 + sha256 复算）→ tar 解压（成员守卫 + symlink 拒绝）
// → **复用本地安装注册链**（PluginRecord 落库 / 原子落位 installed/<id>/<version>/
// / activateDeclarativeComponents：mcp-sync + 安装 ws 单行启用）。
// 只注入「hub 上下文」一个缝（与 T10 e2e 同款）。
//
// 等价性锚点（与 installPluginZip 逐项对照）：
//   1. PluginRecord 落库（plugins 表行 state='active'，目录形态与 zip 链同轨）
//   2. 工具模块落位且可 require（components.tools 的 .js 真实可加载）
//   3. mcp_definitions 出现 source='plugin' + plugin_id 条目（mcp-sync 副作用）
//   4. plugin_enablements 安装 ws 单行启用（scoped activation §5）
//   5. installed_packages hub:{slug} 记账（item_type='plugin'，hub 页签已装态）
//
// 防线矩阵：坏 checksum 拒 / symlink 成员拒 / id 漂移（manifest.id ≠ slug）拒 /
// 空 checksum 拒（plugin 可执行内容必须有校验和）/ 重复安装幂等 /
// 卸载级联两条入口（resource:delete hub 分支 + ipc.plugin.uninstall）均清记账
// （防幽灵行——插件设置页卸载后 hub 页签不得残留「已从 momo-hub 安装」行）。
//
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 指向临时目录 + runMigrations() +
// closeDb() 复位单例。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getPlugin } from '../../src/main/plugin/registry';
import {
  uninstallPlugin,
  MAX_TOTAL_UNCOMPRESSED,
  MAX_ENTRIES,
} from '../../src/main/plugin/installer';
import { assertRegularEntries } from '../../src/main/plugin/hub-install';
import { listRegistered } from '../../src/main/mcp/host-manager';
import { listResources } from '../../src/main/resource/library';
import {
  installHubPackage,
  listHubCatalogResources,
  uninstallHubPackage,
} from '../../src/main/resource/hub-install';
import {
  __setHubContextResolverForTest,
  hubPackageItemId,
} from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest, installPackage } from '../../src/main/marketplace/installer';
import { resolvePluginInstalledDir, resolvePluginsDir } from '../../src/main/paths';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-plugin-${Date.now()}`);
const TEST_WS = 'ws-hub-plug';

/** 插件包 fixture：slug + 真归档字节 + checksum（可注入坏值） */
interface PluginFixture {
  slug: string;
  version: string;
  archive: Buffer;
  checksum: string;
}

const fixtures = new Map<string, PluginFixture>();
let hubRequests: string[] = [];
let hub: { url: string; close: () => Promise<void> } | null = null;

/** 最小合法插件目录（manifest + 工具模块 + mcp.json）；extra 允许注入额外条目 */
function mkPluginDir(dir: string, id: string, extra?: (dir: string) => void): void {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: 'Hub 演示插件',
      version: '0.2.0',
      description: 'hub 安装链测试插件',
      components: { tools: './tools', mcp: './mcp.json' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'tools', 'main.js'),
    'module.exports.createTools = () => ({ ping: { description: "ping" } });',
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({
      servers: {
        'hub-demo-mcp': { command: 'hub-demo-mcp-server', args: ['--stdio'] },
      },
    }),
  );
  extra?.(dir);
}

/** 目录 → 真 tar.gz 归档（顶层即 momo-plugin.json——T11 打包契约同形） */
function packPluginTarGz(dir: string): Buffer {
  const outPath = path.join(
    os.tmpdir(),
    `plug-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`,
  );
  execFileSync('tar', ['-czf', outPath, '-C', dir, ...fs.readdirSync(dir)]);
  const buf = fs.readFileSync(outPath);
  fs.rmSync(outPath, { force: true });
  return buf;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 注册一个插件 fixture（构建目录 → 打包 → 记账 checksum） */
function addPluginFixture(slug: string, extra?: (dir: string) => void, badChecksum?: string): void {
  const dir = path.join(tmpRoot, 'src', slug);
  fs.mkdirSync(dir, { recursive: true });
  mkPluginDir(dir, slug, extra);
  const archive = packPluginTarGz(dir);
  fixtures.set(slug, { slug, version: '0.2.0', archive, checksum: badChecksum ?? sha256(archive) });
}

/** 起 mock hub：catalog（plugin 项）+ download 真字节流 */
async function startMockHub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hubRequests.push(url);
    if (url === '/resources/catalog') {
      const items = [...fixtures.values()].map((f) => ({
        slug: f.slug,
        type: 'plugin',
        name: 'Hub 演示插件',
        version: f.version,
        author: 'node-test',
        description: 'hub 安装链演示',
        readme: '# demo',
        tags: ['test'],
        category: 'dev',
        iconEmoji: '🧩',
        verificationStatus: 'unverified',
        downloadUrl: `http://untrusted.example.com/resources/${f.slug}/${f.version}/download`,
        checksum: f.checksum,
        sizeBytes: f.archive.length,
        publishedAt: 1_700_000_000_000,
        versions: [f.version],
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0', updatedAt: '2026-10-24T00:00:00.000Z', items }));
      return;
    }
    const match = url.match(/^\/resources\/([^/]+)\/([^/]+)\/download$/);
    const fixture = match ? fixtures.get(decodeURIComponent(match[1]!)) : undefined;
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fixture.archive.length),
    });
    res.end(fixture.archive);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 真 fetch（mock 层委托回它，防自调用递归——同 T10 e2e 模式） */
const REAL_FETCH = globalThis.fetch;

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'T', '/tmp/x', '@o')`,
    )
    .run(TEST_WS);
  fixtures.clear();
  hubRequests = [];
  __resetTrustedDownloadOriginsForTest();
  // marketplace 远程目录禁网（fetch 拦截 → 回退本地 catalog，零真实外网）
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('raw.githubusercontent.com')) {
      return Promise.reject(new Error('测试环境禁外网：marketplace 远程目录不回退'));
    }
    return REAL_FETCH(input, init);
  }) as typeof fetch);

  addPluginFixture('hub-plug-a');
  hub = await startMockHub();
  __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: 'tok-plug' }));
});

afterEach(async () => {
  __setHubContextResolverForTest(null);
  if (hub) {
    await hub.close();
    hub = null;
  }
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** plugins 目录里的 staging/归档半成品残留 */
function stagingLeftovers(): string[] {
  const pluginsDir = resolvePluginsDir();
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir).filter((f) => f.startsWith('.staging') || f.endsWith('.tar.gz'));
}

describe('T12：hub 插件安装——与本地安装等价', () => {
  it('真插件包安装全链：PluginRecord 落库 + 工具模块可 require + mcp plugin 源条目 + ws 启用行 + hub 记账', async () => {
    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });

    // ① PluginRecord 落库（与 zip 链同轨：state=active、目录形态 installed 副本）
    const rec = getPlugin('hub-plug-a');
    expect(rec).not.toBeNull();
    expect(rec!.state).toBe('active');
    expect(rec!.version).toBe('0.2.0');

    // ② 原子落位 installed/<id>/<version>/，工具模块真实可加载（等价性核心——
    //    CJS 模块经动态 import 互操作，createTools 导出可直接触达）
    const dir = resolvePluginInstalledDir('hub-plug-a', '0.2.0');
    expect(fs.existsSync(path.join(dir, 'momo-plugin.json'))).toBe(true);
    const mod = (await import(pathToFileURL(path.join(dir, 'tools', 'main.js')).href)) as {
      createTools: () => unknown;
    };
    expect(typeof mod.createTools).toBe('function');

    // ③ mcp-sync 副作用：mcp_definitions 出现 source='plugin' + plugin_id 条目
    const mcp = listRegistered().find((m) => m.pluginId === 'hub-plug-a');
    expect(mcp).toBeDefined();
    expect(mcp!.source).toBe('plugin');
    expect(mcp!.name).toBe('hub-demo-mcp');
    expect(mcp!.command).toBe('hub-demo-mcp-server');

    // ④ scoped activation：安装 ws 单行启用
    const en = getDb()
      .prepare('SELECT enabled FROM plugin_enablements WHERE workspace_id = ? AND plugin_id = ?')
      .get(TEST_WS, 'hub-plug-a') as { enabled: number } | undefined;
    expect(en).toBeDefined();
    expect(en!.enabled).toBe(1);

    // ⑤ hub 记账（installed_packages，item_type='plugin'——页签已装态判定源）
    const row = getDb()
      .prepare('SELECT item_type, version FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-plug-a')) as { item_type: string; version: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.item_type).toBe('plugin');
    expect(row!.version).toBe('0.2.0');

    // 下载真的打到 mock hub（信任集放行 http origin；catalog 自报 host 未被采信）
    expect(hubRequests).toContain('/resources/hub-plug-a/0.2.0/download');
    expect(hubRequests.some((u) => u.includes('untrusted.example.com'))).toBe(false);
    // 安装完成零半成品残留
    expect(stagingLeftovers()).toEqual([]);
  });

  it('坏 checksum → 拒绝安装 + 零残留 + 不落库不注册', async () => {
    addPluginFixture('hub-plug-bad', undefined, 'f'.repeat(64));

    await expect(
      installHubPackage('plugin', 'hub-plug-bad', { appVersion: '2.1.0', workspaceId: TEST_WS }),
    ).rejects.toThrow(/校验/);

    expect(getPlugin('hub-plug-bad')).toBeNull();
    expect(stagingLeftovers()).toEqual([]);
    expect(fs.existsSync(resolvePluginInstalledDir('hub-plug-bad', '0.2.0'))).toBe(false);
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-plug-bad'));
    expect(row).toBeUndefined();
    expect(listRegistered().some((m) => m.pluginId === 'hub-plug-bad')).toBe(false);
  });

  it('symlink 成员包 → 拒绝安装（installer 域同款守卫）', async () => {
    addPluginFixture('hub-plug-link', (d) => {
      fs.symlinkSync('/etc/hosts', path.join(d, 'leak.txt'));
    });

    await expect(
      installHubPackage('plugin', 'hub-plug-link', { appVersion: '2.1.0', workspaceId: TEST_WS }),
    ).rejects.toThrow(/符号链接/);

    expect(getPlugin('hub-plug-link')).toBeNull();
    expect(stagingLeftovers()).toEqual([]);
  });

  it('manifest.id 与目录 slug 漂移 → 拒绝（记账锚定，与 T11 打包侧对称）', async () => {
    // 包内 manifest.id = other-guy ≠ 目录 slug hub-plug-drift
    const dir = path.join(tmpRoot, 'src-drift');
    fs.mkdirSync(dir, { recursive: true });
    mkPluginDir(dir, 'other-guy');
    const archive = packPluginTarGz(dir);
    fixtures.set('hub-plug-drift', {
      slug: 'hub-plug-drift',
      version: '0.2.0',
      archive,
      checksum: sha256(archive),
    });

    await expect(
      installHubPackage('plugin', 'hub-plug-drift', { appVersion: '2.1.0', workspaceId: TEST_WS }),
    ).rejects.toThrow(/不一致/);

    expect(getPlugin('other-guy')).toBeNull();
    expect(getPlugin('hub-plug-drift')).toBeNull();
  });

  it('空 checksum → 拒绝（plugin 可执行内容必须带校验和——防线纵深锁）', async () => {
    // 协议包 validateHubCatalog 对空 checksum 的目录整体拒收（条目到不了安装链），
    // 本用例直接调安装入口锁住纵深防线——防未来 catalog 校验放宽后此闸失守
    const { installPluginHubArchive } = await import('../../src/main/plugin/hub-install');
    await expect(
      installPluginHubArchive(
        {
          id: 'hub:hub-plug-nochecksum',
          type: 'plugin',
          slug: 'hub-plug-nochecksum',
          name: 'Hub 演示插件',
          version: '0.2.0',
          author: 'node-test',
          description: '',
          readme: '',
          tags: [],
          category: '',
          iconEmoji: '',
          verificationStatus: 'unverified',
          downloadUrl: `${hub!.url}/x`,
          checksum: '',
          sizeBytes: 0,
          installCount: 0,
        },
        '2.1.0',
        TEST_WS,
      ),
    ).rejects.toThrow(/校验和/);
    expect(getPlugin('hub-plug-nochecksum')).toBeNull();
  });

  it('重复安装幂等：plugins 表单行 / 记账单行 / installed 单版本目录', async () => {
    const opts = { appVersion: '2.1.0', workspaceId: TEST_WS };
    await installHubPackage('plugin', 'hub-plug-a', opts);
    await installHubPackage('plugin', 'hub-plug-a', opts);

    const pluginRows = getDb()
      .prepare('SELECT * FROM plugins WHERE id = ?')
      .all('hub-plug-a') as unknown[];
    expect(pluginRows).toHaveLength(1);

    const accRows = getDb()
      .prepare('SELECT * FROM installed_packages WHERE item_id = ?')
      .all(hubPackageItemId('hub-plug-a')) as unknown[];
    expect(accRows).toHaveLength(1);

    const versionRoot = path.dirname(resolvePluginInstalledDir('hub-plug-a', '0.2.0'));
    expect(fs.readdirSync(versionRoot)).toEqual(['0.2.0']);
    expect(stagingLeftovers()).toEqual([]);
  });
});

describe('T12：卸载级联两条入口', () => {
  it('resource:delete hub 分支（uninstallHubPackage）：PluginRecord / 目录 / MCP 定义 / 记账全清', async () => {
    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });
    const dir = resolvePluginInstalledDir('hub-plug-a', '0.2.0');

    uninstallHubPackage('plugin', 'hub-plug-a');

    expect(getPlugin('hub-plug-a')).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    expect(listRegistered().some((m) => m.pluginId === 'hub-plug-a')).toBe(false);
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-plug-a'));
    expect(row).toBeUndefined();
  });

  it('插件设置页入口（uninstallPlugin）：hub 记账同删——不残留「已从 momo-hub 安装」幽灵行', async () => {
    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });

    uninstallPlugin('hub-plug-a', true);

    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-plug-a'));
    expect(row).toBeUndefined();
  });

  it('幽灵账兜底：PluginRecord 已不存在时 uninstallHubPackage 仅清记账（幂等）', async () => {
    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });
    // 模拟插件行先行消失（如直连 plugin:uninstall 的旧版本残留账）
    getDb().prepare('DELETE FROM plugins WHERE id = ?').run('hub-plug-a');

    expect(() => uninstallHubPackage('plugin', 'hub-plug-a')).not.toThrow();
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-plug-a'));
    expect(row).toBeUndefined();
  });
});

describe('T12：hub 页签可见性与去重（消费面）', () => {
  it('未装 plugin 项在 hub 目录可见且可安装；安装后管理面归 plugins 表行（同插件不双卡）', async () => {
    // 未装：hub 目录 plugin 项可见、installable
    const before = await listHubCatalogResources('plugin');
    const catalogItem = before.find((i) => i.id === 'hub-plugin-hub-plug-a');
    expect(catalogItem).toBeDefined();
    expect(catalogItem!.installed).toBe(false);
    expect(catalogItem!.installable).toBe(true);

    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });

    // 已装：hub 目录行去重消失（管理面 = plugins 表的 custom-plugin-* 行，带
    // plugin namespace 启停/卸载）——同物理插件不得出现两张卡
    const after = await listHubCatalogResources('plugin');
    expect(after.find((i) => i.id === 'hub-plugin-hub-plug-a')).toBeUndefined();

    const page = await listResources({ type: 'plugin' });
    const pluginRow = page.find((i) => i.id === 'custom-plugin-hub-plug-a');
    expect(pluginRow).toBeDefined();
    expect(pluginRow!.plugin!.id).toBe('hub-plug-a');
    expect(pluginRow!.plugin!.enabled).toBe(true);
    // hub 目录行不再并列
    expect(page.find((i) => i.id === 'hub-plugin-hub-plug-a')).toBeUndefined();
  });

  it('幽灵账（plugins 行已删、记账残留）→ hub 目录兜底行出现，卸载后消失', async () => {
    await installHubPackage('plugin', 'hub-plug-a', {
      appVersion: '2.1.0',
      workspaceId: TEST_WS,
    });
    getDb().prepare('DELETE FROM plugins WHERE id = ?').run('hub-plug-a');

    const items = await listHubCatalogResources('plugin');
    const ghost = items.find((i) => i.id === 'hub-plugin-hub-plug-a');
    expect(ghost).toBeDefined();
    expect(ghost!.installed).toBe(true);
    expect(ghost!.removable).toBe(true);

    uninstallHubPackage('plugin', 'hub-plug-a');
    // 目录仍在线：条目回到「未装可装」态（installed=false / installable=true）
    const after = await listHubCatalogResources('plugin');
    const restored = after.find((i) => i.id === 'hub-plugin-hub-plug-a');
    expect(restored).toBeDefined();
    expect(restored!.installed).toBe(false);
    expect(restored!.installable).toBe(true);
    expect(restored!.removable).toBe(false);
  });
});

describe('T15a-F1：hub 插件重装不误删同 slug 的 hub agent 记账', () => {
  it('重装置换旧账只清 plugin 行——agent 记账与缓存原封不动', async () => {
    const opts = { appVersion: '2.1.0', workspaceId: TEST_WS };
    await installHubPackage('plugin', 'hub-plug-a', opts);
    // 同 item_id 的 hub agent 记账（真实 installPackage inline 链产出，缓存目录真落盘）
    const { cachePath } = await installPackage({
      id: hubPackageItemId('hub-plug-a'),
      type: 'agent',
      slug: 'hub-plug-a',
      name: 'Hub Agent 同名',
      version: '1.0.0',
      author: 'node-test',
      description: '与插件同 slug 的 hub agent',
      readme: '# 同名碰撞',
      tags: [],
      category: '',
      iconEmoji: '🤖',
      verificationStatus: 'unverified',
      downloadUrl: '',
      checksum: '',
      sizeBytes: 1,
      installCount: 0,
    });
    expect(fs.existsSync(path.join(cachePath, 'manifest.yaml'))).toBe(true);

    // 重装触发记账置换 DELETE（修复前：无类型过滤连坐删 agent 行）
    await installHubPackage('plugin', 'hub-plug-a', opts);

    const agentRow = getDb()
      .prepare("SELECT id FROM installed_packages WHERE item_id = ? AND item_type = 'agent'")
      .get(hubPackageItemId('hub-plug-a'));
    expect(agentRow).toBeDefined();
    expect(fs.existsSync(path.join(cachePath, 'manifest.yaml'))).toBe(true);
    // plugin 记账仍是单行（置换语义不变）
    const pluginRows = getDb()
      .prepare("SELECT id FROM installed_packages WHERE item_id = ? AND item_type = 'plugin'")
      .all(hubPackageItemId('hub-plug-a')) as unknown[];
    expect(pluginRows).toHaveLength(1);
  });
});

describe('T15a-F2：tar 解压炸弹守卫（assertRegularEntries）', () => {
  /** 造一个 N 文件目录（每文件 ~1KB），走与解压终审同一 walk 路径 */
  function makeDir(name: string, fileCount: number, fileSize = 1024): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'momo-plugin.json'), '{}');
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(dir, 'tools', `f${i}.bin`), Buffer.alloc(fileSize, 1));
    }
    return dir;
  }

  it('条目数超注入上限 → 拒（同 walk 路径）', () => {
    const dir = makeDir('bomb-entries', 3); // manifest + 3 文件 = 4 条目
    expect(() => assertRegularEntries(dir, MAX_TOTAL_UNCOMPRESSED, 3)).toThrow(/条目数超限/);
  });

  it('解压总量超注入上限 → 拒（同 walk 路径）', () => {
    const dir = makeDir('bomb-size', 2, 4096); // ≥ 8KB
    expect(() => assertRegularEntries(dir, 4096, MAX_ENTRIES)).toThrow(/解压总量超限/);
  });

  it('上限内常规包 → 放行（生产默认上限不误伤）', () => {
    const dir = makeDir('bomb-ok', 3);
    expect(() => assertRegularEntries(dir)).not.toThrow();
  });
});
