// electron/tests/plugin/publish-pack.test.ts
//
// 插件发布打包（momo-hub M1 spec §6.4 / Task 11）：目录 → tar.gz。
// 矩阵：正常打包清单断言 / dataDir 与 node_modules 排除 / symlink 混入拒绝 /
// FIFO（非常规文件）拒绝 / `..` 与绝对路径成员守卫 / manifest 非法与 id 漂移拒绝 /
// 超限拒绝（注入小上限）/ checksum 与 node:crypto 手算对照 / 错误路径三态
// （插件不存在 / 根目录缺失 / 缺 manifest 文件）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import { upsertPlugin } from '../../src/main/plugin/registry';
import { resolveTmpDir, resolvePluginInstalledDir, resolvePluginDataDir } from '../../src/main/paths';
import { assertSafeTarMembers } from '../../src/main/plugin/installer';
import { packPluginForPublish } from '../../src/main/plugin/publish-pack';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ppack-'));

/** 建一个最小合法 dev 插件目录（manifest + tools 模块）；extra 允许注入额外条目 */
function mkPlugin(dir: string, id: string, extra?: (dir: string) => void): void {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: 'P',
      version: '0.1.0',
      description: '打包测试插件',
      components: { tools: './tools' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'tools', 'main.js'), 'module.exports.createTools = () => ({});');
  extra?.(dir);
}

/** 注册 dev 源插件行（pack 读磁盘 manifest 为准，行内 manifestJson 仅占位） */
function registerDev(dir: string, id: string): void {
  upsertPlugin({
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({ id, version: '0.1.0' }),
    state: 'active',
    source: 'dev',
    sourcePath: path.resolve(dir),
    installedAt: new Date().toISOString(),
  });
}

/** tar -tzf 成员清单（剥目录尾条目，只留文件成员） */
function tarList(archivePath: string): string[] {
  return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
}

/** tmp 目录里是否残留 publish-* 半成品 */
function publishArtifacts(): string[] {
  const tmp = path.join(tmpRoot, 'tmp');
  if (!fs.existsSync(tmp)) return [];
  return fs.readdirSync(tmp).filter((f) => f.startsWith('publish-'));
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

describe('packPluginForPublish', () => {
  it('正常打包：含 manifest 与工具模块，排除 node_modules，返回 checksum/size/manifest', async () => {
    const dir = path.join(tmpRoot, 'normal-plugin');
    mkPlugin(dir, 'pp-normal', (d) => {
      fs.mkdirSync(path.join(d, 'skills', 'sa'), { recursive: true });
      fs.writeFileSync(path.join(d, 'skills', 'sa', 'SKILL.md'), '# sa\n');
      fs.mkdirSync(path.join(d, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(d, 'node_modules', 'dep', 'index.js'), 'junk');
      fs.writeFileSync(path.join(d, 'mcp.json'), '{"servers":{}}');
    });
    registerDev(dir, 'pp-normal');

    const res = await packPluginForPublish('pp-normal');

    // 归档落在临时目录且真实存在
    expect(res.archivePath.startsWith(resolveTmpDir())).toBe(true);
    expect(fs.statSync(res.archivePath).isFile()).toBe(true);

    const list = tarList(res.archivePath);
    expect(list).toContain('momo-plugin.json');
    expect(list).toContain('tools/main.js');
    expect(list).toContain('skills/sa/SKILL.md');
    expect(list).toContain('mcp.json');
    expect(list.some((m) => m.split('/').includes('node_modules'))).toBe(false);

    // checksum 是 64 位 hex 且与 node:crypto 手算对照一致
    expect(res.checksum).toMatch(/^[0-9a-f]{64}$/);
    const manual = crypto.createHash('sha256').update(fs.readFileSync(res.archivePath)).digest('hex');
    expect(res.checksum).toBe(manual);

    // sizeBytes 锚定归档真实尺寸
    expect(res.sizeBytes).toBe(fs.statSync(res.archivePath).size);
    expect(res.sizeBytes).toBeGreaterThan(0);

    // manifest 为磁盘内容解析结果（发布侧消费 id/version）
    expect(res.manifest.id).toBe('pp-normal');
    expect(res.manifest.version).toBe('0.1.0');
  });

  it('排除插件 dataDir：根目录覆盖 data 布局时 data/<id>/ 不入包，其他 data 子目录保留', async () => {
    // dev 源根目录 = <userData>/plugins（dataDir = plugins/data/pp-data 落在根内）
    const root = path.join(tmpRoot, 'plugins');
    mkPlugin(root, 'pp-data', (d) => {
      fs.mkdirSync(path.join(d, 'data', 'pp-data'), { recursive: true });
      fs.writeFileSync(path.join(d, 'data', 'pp-data', 'runtime.json'), '{"k":1}');
      fs.mkdirSync(path.join(d, 'data', 'other'), { recursive: true });
      fs.writeFileSync(path.join(d, 'data', 'other', 'keep.txt'), 'keep');
    });
    registerDev(root, 'pp-data');
    expect(resolvePluginDataDir('pp-data')).toBe(path.join(root, 'data', 'pp-data'));

    const res = await packPluginForPublish('pp-data');
    const list = tarList(res.archivePath);

    expect(list).toContain('momo-plugin.json');
    expect(list).toContain('tools/main.js');
    // 本插件 dataDir 整体排除
    expect(list.some((m) => m === 'data/pp-data/runtime.json' || m.startsWith('data/pp-data/'))).toBe(false);
    // 非本插件 dataDir 的 data 子目录不受牵连（排除语义按路径锚定，非按目录名）
    expect(list).toContain('data/other/keep.txt');
  });

  it('zip 源插件：resolvePluginRoot installed 副本同样可打包', async () => {
    const id = 'pp-zip';
    const root = resolvePluginInstalledDir(id, '0.1.0');
    mkPlugin(root, id);
    upsertPlugin({
      id,
      version: '0.1.0',
      manifestJson: JSON.stringify({ id, version: '0.1.0' }),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: new Date().toISOString(),
    });

    const res = await packPluginForPublish(id);
    const list = tarList(res.archivePath);
    expect(list).toContain('momo-plugin.json');
    expect(list).toContain('tools/main.js');
    expect(res.manifest.id).toBe(id);
  });

  it('symlink 混入 → 整包拒绝且无归档残留', async () => {
    const dir = path.join(tmpRoot, 'symlink-plugin');
    mkPlugin(dir, 'pp-link', (d) => {
      fs.symlinkSync('/etc/hosts', path.join(d, 'leak.txt'));
    });
    registerDev(dir, 'pp-link');

    await expect(packPluginForPublish('pp-link')).rejects.toThrow(/符号链接/);
    expect(publishArtifacts()).toEqual([]);
  });

  it('symlink 目录同样拒绝（不跟随不遍历）', async () => {
    const dir = path.join(tmpRoot, 'symlinkdir-plugin');
    mkPlugin(dir, 'pp-linkdir', (d) => {
      fs.symlinkSync(path.join(d, 'tools'), path.join(d, 'tools-alias'));
    });
    registerDev(dir, 'pp-linkdir');

    await expect(packPluginForPublish('pp-linkdir')).rejects.toThrow(/符号链接/);
    expect(publishArtifacts()).toEqual([]);
  });

  it('FIFO（非常规文件）混入 → 整包拒绝', async () => {
    const dir = path.join(tmpRoot, 'fifo-plugin');
    mkPlugin(dir, 'pp-fifo', (d) => {
      execFileSync('mkfifo', [path.join(d, 'pipe.fifo')]);
    });
    registerDev(dir, 'pp-fifo');

    await expect(packPluginForPublish('pp-fifo')).rejects.toThrow(/非常规/);
    expect(publishArtifacts()).toEqual([]);
  });

  it('`..` 越界与绝对路径成员守卫：tar 前对收集清单终审（与安装侧同款）', () => {
    // walk 产物（readdir 相对名）正常不会产生 .. / 绝对路径——守卫是对
    // 传入 tar 参数清单的纵深防线，与 plugin/installer assertSafeTarMembers 同源复用
    expect(() => assertSafeTarMembers(['ok.txt', '../evil.txt'])).toThrow(/不安全成员/);
    expect(() => assertSafeTarMembers(['/abs/evil.txt'])).toThrow(/不安全成员/);
    expect(() => assertSafeTarMembers(['a/b.txt', 'momo-plugin.json'])).not.toThrow();
  });

  it('manifest 非法（id 白名单外）→ 拒绝打包且无归档残留', async () => {
    const dir = path.join(tmpRoot, 'bad-plugin');
    mkPlugin(dir, 'BAD');
    registerDev(dir, 'BAD');

    await expect(packPluginForPublish('BAD')).rejects.toThrow(/id/);
    expect(publishArtifacts()).toEqual([]);
  });

  it('磁盘 manifest id 与注册 id 漂移 → 拒绝（防 A 根目录打包出 B 身份、dataDir 排除错位）', async () => {
    const dir = path.join(tmpRoot, 'drift-plugin');
    mkPlugin(dir, 'other-guy');
    registerDev(dir, 'pp-drift');

    await expect(packPluginForPublish('pp-drift')).rejects.toThrow(/不一致/);
    expect(publishArtifacts()).toEqual([]);
  });

  it('超限拒绝：注入小上限，同插件同路径抛错', async () => {
    const dir = path.join(tmpRoot, 'big-plugin');
    mkPlugin(dir, 'pp-big', (d) => {
      fs.writeFileSync(path.join(d, 'tools', 'main.js'), 'x'.repeat(4096));
    });
    registerDev(dir, 'pp-big');

    // 默认上限（200MB）下正常打包成功——同一插件同一调用路径
    const ok = await packPluginForPublish('pp-big');
    expect(fs.statSync(ok.archivePath).isFile()).toBe(true);

    // 注入 64 字节上限 → 同路径超限抛错
    await expect(packPluginForPublish('pp-big', 64)).rejects.toThrow(/超限/);
  });

  it('插件不存在 → 中文错误', async () => {
    await expect(packPluginForPublish('no-such-plugin')).rejects.toThrow(/不存在/);
  });

  it('根目录缺失（dev 目录消失）→ 拒绝', async () => {
    const dir = path.join(tmpRoot, 'gone-plugin');
    mkPlugin(dir, 'pp-gone');
    registerDev(dir, 'pp-gone');
    fs.rmSync(dir, { recursive: true, force: true });

    await expect(packPluginForPublish('pp-gone')).rejects.toThrow(/目录不可用/);
  });

  it('根目录缺 momo-plugin.json → 拒绝', async () => {
    const dir = path.join(tmpRoot, 'no-manifest-plugin');
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    registerDev(dir, 'pp-nomanifest');

    await expect(packPluginForPublish('pp-nomanifest')).rejects.toThrow(/momo-plugin\.json/);
  });
});
