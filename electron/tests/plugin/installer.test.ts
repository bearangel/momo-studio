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
