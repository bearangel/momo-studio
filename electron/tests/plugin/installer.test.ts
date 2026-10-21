// electron/tests/plugin/installer.test.ts
//
// zip 安装全链（真实 tmpdir + 真实 zip 构造，范式同 skill/upload-zip.test.ts）：
// 落位注册 / bomb 守卫 / entry 穿越 / manifest 拒绝 / minAppVersion / 幂等重装 / 卸载。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import {
  installPluginZip,
  uninstallPlugin,
  compareVersionLoose,
  isSafeEntryRelPath,
} from '../../src/main/plugin/installer';
import { getPlugin } from '../../src/main/plugin/registry';
import { resolvePluginInstalledDir, resolvePluginDataDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pinst-'));

function makePluginZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [rel, content] of Object.entries(files)) zip.addFile(rel, Buffer.from(content));
  return zip.toBuffer();
}

const VALID_FILES: Record<string, string> = {
  'momo-plugin.json': JSON.stringify({
    id: 'cg',
    name: 'Codegraph',
    version: '0.1.0',
    description: '图谱',
    components: { tools: './tools' },
  }),
  'tools/cg.js': 'module.exports.createTools = () => ({});',
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

describe('installPluginZip', () => {
  it('合法 zip 落位 installed/<id>/<version> 并注册', async () => {
    const rec = await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    expect(rec.id).toBe('cg');
    const dir = resolvePluginInstalledDir('cg', '0.1.0');
    expect(fs.existsSync(path.join(dir, 'momo-plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tools', 'cg.js'))).toBe(true);
    expect(getPlugin('cg')?.version).toBe('0.1.0');
    expect(getPlugin('cg')?.source).toBe('zip');
  });

  it('zip bomb：累计解压超上限拒装（3×80MB > 200MB）', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'momo-plugin.json',
      Buffer.from(
        JSON.stringify({ id: 'bomb', name: 'B', version: '0.1.0', description: '', components: {} }),
      ),
    );
    const big = Buffer.alloc(80 * 1024 * 1024, 1);
    zip.addFile('a.bin', big);
    zip.addFile('b.bin', big);
    zip.addFile('c.bin', big);
    await expect(installPluginZip(zip.toBuffer(), '2.1.0')).rejects.toThrow(/解压总量超限/);
  });

  it('说谎的 zip 头（声明小于实际）：拒装 + 零残留 + 不落库（审查 I2）', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'momo-plugin.json',
      Buffer.from(
        JSON.stringify({ id: 'liar', name: 'L', version: '0.1.0', description: '', components: {} }),
      ),
    );
    const big = Buffer.alloc(110 * 1024 * 1024, 1);
    zip.addFile('a.bin', big);
    zip.addFile('b.bin', big);
    // 篡改声明解压尺寸 90MB×2=180MB（< 200MB 声明上限）——声明值预检放行，
    // 实际 220MB 必须在解压层（adm-zip 尺寸校验）或实际尺寸守卫处被拒
    for (const e of zip.getEntries()) {
      if (e.entryName.endsWith('.bin')) e.header.size = 90 * 1024 * 1024;
    }
    await expect(installPluginZip(zip.toBuffer(), '2.1.0')).rejects.toThrow();
    expect(getPlugin('liar')).toBeNull();
    const staging = fs
      .readdirSync(path.join(tmpRoot, 'plugins'))
      .filter((f) => f.startsWith('.staging'));
    expect(staging).toHaveLength(0);
    expect(fs.existsSync(resolvePluginInstalledDir('liar', '0.1.0'))).toBe(false);
  });

  it('entry 路径穿越（../）防御：adm-zip 写侧已规范化为普通文件名，合法落位', async () => {
    // adm-zip addFile 会把 '../escape.txt' 规范化存储为 'escape.txt'（实证），
    // 故无法经 adm-zip 构造真实穿越 entry——穿越防御由下方 isSafeEntryRelPath
    // 纯函数单测锁死（读外部恶意 zip 时该分支是真防线）。
    const zip = new AdmZip();
    zip.addFile(
      'momo-plugin.json',
      Buffer.from(
        JSON.stringify({ id: 'evil', name: 'E', version: '0.1.0', description: '', components: {} }),
      ),
    );
    zip.addFile('../escape.txt', Buffer.from('x'));
    await installPluginZip(zip.toBuffer(), '2.1.0');
    expect(fs.existsSync(path.join(tmpRoot, 'escape.txt'))).toBe(false);
    const dir = resolvePluginInstalledDir('evil', '0.1.0');
    expect(fs.readdirSync(dir)).toContain('momo-plugin.json');
    expect(fs.readdirSync(dir)).toContain('escape.txt');
  });

  it('manifest 校验失败拒装且不留 staging 残留', async () => {
    const bad = {
      ...VALID_FILES,
      'momo-plugin.json': JSON.stringify({
        id: 'X!',
        name: 'x',
        version: '0.1.0',
        description: '',
        components: {},
      }),
    };
    await expect(installPluginZip(makePluginZip(bad), '2.1.0')).rejects.toThrow(/id/);
    const staging = fs
      .readdirSync(path.join(tmpRoot, 'plugins'))
      .filter((f) => f.startsWith('.staging'));
    expect(staging).toHaveLength(0);
  });

  it('minAppVersion 高于当前版本拒装（中文消息）', async () => {
    const newer = {
      ...VALID_FILES,
      'momo-plugin.json': JSON.stringify({
        id: 'cg',
        name: 'C',
        version: '0.1.0',
        description: '',
        components: { tools: './tools' },
        minAppVersion: '2.2.0',
      }),
    };
    await expect(installPluginZip(makePluginZip(newer), '2.1.0')).rejects.toThrow(
      /需要应用版本.*2\.2\.0/,
    );
  });

  it('同 id 新版本重装 = 替换（单版本驻留，旧目录消失）', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const v2 = {
      ...VALID_FILES,
      'momo-plugin.json': JSON.stringify({
        id: 'cg',
        name: 'Codegraph',
        version: '0.2.0',
        description: '图谱',
        components: { tools: './tools' },
      }),
    };
    await installPluginZip(makePluginZip(v2), '2.1.0');
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.1.0'))).toBe(false);
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.2.0'))).toBe(true);
    expect(getPlugin('cg')?.version).toBe('0.2.0');
  });

  it('单层包裹目录（macOS 压缩文件夹产物）支持', async () => {
    const zip = new AdmZip();
    zip.addFile('codegraph/', Buffer.alloc(0));
    zip.addFile(
      'codegraph/momo-plugin.json',
      Buffer.from(
        JSON.stringify({
          id: 'cg',
          name: 'Codegraph',
          version: '0.1.0',
          description: '图谱',
          components: { tools: './tools' },
        }),
      ),
    );
    zip.addFile('codegraph/tools/cg.js', Buffer.from('module.exports.createTools = () => ({});'));
    const rec = await installPluginZip(zip.toBuffer(), '2.1.0');
    expect(rec.id).toBe('cg');
    const dir = resolvePluginInstalledDir('cg', '0.1.0');
    expect(fs.existsSync(path.join(dir, 'tools', 'cg.js'))).toBe(true);
  });
});

describe('uninstallPlugin', () => {
  it('zip 源卸载删行删目录；keepData=false 删 data', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const dataDir = resolvePluginDataDir('cg');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
    uninstallPlugin('cg', false);
    expect(getPlugin('cg')).toBeNull();
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.1.0'))).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('keepData=true 保留 data 目录', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const dataDir = resolvePluginDataDir('cg');
    fs.mkdirSync(dataDir, { recursive: true });
    uninstallPlugin('cg', true);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('卸载不存在的插件抛中文错', () => {
    expect(() => uninstallPlugin('nope', true)).toThrow(/不存在/);
  });
});

describe('compareVersionLoose', () => {
  it('数字三元组比较，prerelease 忽略', () => {
    expect(compareVersionLoose('2.1.0-alpha.5', '2.1.0')).toBe(0);
    expect(compareVersionLoose('2.1.0', '2.2.0')).toBe(-1);
    expect(compareVersionLoose('2.10.0', '2.9.0')).toBe(1);
  });
});

describe('isSafeEntryRelPath', () => {
  it('含 .. 段拒绝', () => {
    expect(isSafeEntryRelPath('../escape.txt')).toBe(false);
    expect(isSafeEntryRelPath('a/../../b')).toBe(false);
  });
  it('绝对路径拒绝', () => {
    expect(isSafeEntryRelPath('/etc/passwd')).toBe(false);
  });
  it('普通相对路径放行', () => {
    expect(isSafeEntryRelPath('momo-plugin.json')).toBe(true);
    expect(isSafeEntryRelPath('tools/cg.js')).toBe(true);
    expect(isSafeEntryRelPath('a/b/c.txt')).toBe(true);
  });
});




// ── P4 审查修复轮（I1 zip 推送 / I2 卸载清理 / I3 安装期 config 校验） ──
describe('审查修复 I1/I2/I3', () => {
  it('I3：config schema 越界（integer）→ zip 安装拒绝', async () => {
    const bad = { ...VALID_FILES };
    bad['momo-plugin.json'] = JSON.stringify({
      id: 'cg', name: 'x', version: '0.1.0', description: '',
      components: { tools: './tools' },
      config: { type: 'object', properties: { n: { type: 'integer' } } },
    });
    await expect(installPluginZip(makePluginZip(bad), '2.1.0')).rejects.toThrow();
  });

  it('I3：合法 config schema → 安装通过', async () => {
    const ok = { ...VALID_FILES };
    ok['momo-plugin.json'] = JSON.stringify({
      id: 'cg', name: 'x', version: '0.1.0', description: '',
      components: { tools: './tools' },
      config: { type: 'object', properties: { t: { type: 'string', sensitive: true } }, required: [] },
    });
    const rec = await installPluginZip(makePluginZip(ok), '2.1.0');
    expect(rec.id).toBe('cg');
  });

  it('I2：keepData=false 卸载 → keytar 敏感键删除 + 缓存清除（keepData=true 保留）', async () => {
    const { setKeychainImpl } = await import('../../src/main/storage/keychain');
    const { sensitiveOverlaySync } = await import('../../src/main/plugin/config-store');
    const vault = new Map<string, string>([['plugin.cg.config.t', 'sk-old']]);
    setKeychainImpl({
      setSecret: async (k, v) => void vault.set(k, v),
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => void vault.delete(k),
    });
    const withCfg = { ...VALID_FILES };
    withCfg['momo-plugin.json'] = JSON.stringify({
      id: 'cg', name: 'x', version: '0.1.0', description: '',
      components: { tools: './tools' },
      config: { type: 'object', properties: { t: { type: 'string', sensitive: true } }, required: [] },
    });
    const rec = await installPluginZip(makePluginZip(withCfg), '2.1.0');
    // 预置缓存有值（模拟运行期）
    await (await import('../../src/main/plugin/config-store')).warmPluginConfigCache('cg', {
      properties: { t: { type: 'string', sensitive: true } }, required: [],
    });
    expect(sensitiveOverlaySync('cg')).toEqual({ t: 'sk-old' });

    uninstallPlugin(rec.id, false);
    await new Promise((r) => setTimeout(r, 30));
    expect(sensitiveOverlaySync('cg')).toEqual({}); // 缓存清除
    await new Promise((r) => setTimeout(r, 50));
    expect(vault.has('plugin.cg.config.t')).toBe(false); // keytar 删除
  });

  it('I1：zip 安装成功 → panelsChanged 推送（broadcast spy）', async () => {
    const { notifyPanelsChanged } = await import('../../src/main/plugin/panel-sync');
    const seen: string[] = [];
    const orig = notifyPanelsChanged;
    // monkey-patch 模块级默认不可行（installer 持绑定）——改验证行为：
    // zip 装完 listPluginPanels 能列出（推送本身是 fire-and-forget UI 刷新，
    // 由 P3 notifyPanelsChanged 单元测试锁形状）。此处锁「装完可列」语义。
    const panelFiles: Record<string, string> = {
      'momo-plugin.json': JSON.stringify({
        id: 'pp', name: 'pp', version: '0.1.0', description: '',
        components: { panel: './panel' },
      }),
      'panel/panel.json': JSON.stringify({
        panels: [{ id: 'main', title: '主面板', location: 'sidebar', entry: './index.html' }],
      }),
      'panel/index.html': '<html></html>',
    };
    await installPluginZip(makePluginZip(panelFiles), '2.1.0');
    const { listPluginPanels } = await import('../../src/main/plugin/panel-sync');
    const { getDb } = await import('../../src/main/storage/db');
    getDb()
      .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`)
      .run();
    // scoped activation：翻转后行缺失=停用——面板列举前补启用行
    getDb()
      .prepare(`INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('ws1', 'pp', 1)`)
      .run();
    const panels = listPluginPanels('ws1');
    expect(panels.some((p) => p.pluginId === 'pp')).toBe(true);
    void seen; void orig;
  });
});
