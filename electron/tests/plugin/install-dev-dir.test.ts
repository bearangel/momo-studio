// electron/tests/plugin/install-dev-dir.test.ts
//
// dev 目录注册（spec §7.2）：不拷贝 / 直读源目录 / 校验链与 zip 一致 / 重注册刷新版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import { installPluginDevDir } from '../../src/main/plugin/installer';
import { getPlugin } from '../../src/main/plugin/registry';
import { resolvePluginsDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pdev-'));

function mkDevPlugin(dir: string, id = 'cg'): void {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: 'Codegraph',
      version: '0.1.0',
      description: '图谱',
      components: { tools: './tools' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'tools', 'cg.js'), 'module.exports.createTools = () => ({});');
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

describe('installPluginDevDir', () => {
  it('注册 dev 源：不拷贝、直读源目录、重复注册刷新版本', () => {
    const devDir = path.join(tmpRoot, 'codegraph-plugin');
    mkDevPlugin(devDir);
    const rec = installPluginDevDir(devDir, '2.1.0');
    expect(rec.source).toBe('dev');
    expect(rec.sourcePath).toBe(path.resolve(devDir));
    expect(getPlugin('cg')?.version).toBe('0.1.0');
    expect(fs.existsSync(path.join(resolvePluginsDir(), 'installed', 'cg'))).toBe(false);
    fs.writeFileSync(
      path.join(devDir, 'momo-plugin.json'),
      JSON.stringify({
        id: 'cg',
        name: 'Codegraph',
        version: '0.2.0',
        description: '图谱',
        components: { tools: './tools' },
      }),
    );
    installPluginDevDir(devDir, '2.1.0');
    expect(getPlugin('cg')?.version).toBe('0.2.0');
  });

  it('目录不存在抛中文错', () => {
    expect(() => installPluginDevDir(path.join(tmpRoot, 'nope'), '2.1.0')).toThrow(/不存在/);
  });

  it('目录内缺 manifest 抛中文错', () => {
    const empty = path.join(tmpRoot, 'empty-plugin');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => installPluginDevDir(empty, '2.1.0')).toThrow(/momo-plugin\.json/);
  });

  it('manifest 校验失败抛含字段路径的错误', () => {
    const devDir = path.join(tmpRoot, 'bad-plugin');
    fs.mkdirSync(path.join(devDir, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(devDir, 'momo-plugin.json'),
      JSON.stringify({
        id: 'BAD',
        name: 'x',
        version: '0.1.0',
        description: '',
        components: { tools: './tools' },
      }),
    );
    expect(() => installPluginDevDir(devDir, '2.1.0')).toThrow(/id/);
  });

  it('minAppVersion 高于当前版本拒装', () => {
    const devDir = path.join(tmpRoot, 'newer-plugin');
    mkDevPlugin(devDir, 'newer');
    fs.writeFileSync(
      path.join(devDir, 'momo-plugin.json'),
      JSON.stringify({
        id: 'newer',
        name: 'N',
        version: '0.1.0',
        description: '',
        components: { tools: './tools' },
        minAppVersion: '3.0.0',
      }),
    );
    expect(() => installPluginDevDir(devDir, '2.1.0')).toThrow(/需要应用版本/);
  });
});
