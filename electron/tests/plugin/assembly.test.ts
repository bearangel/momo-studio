// electron/tests/plugin/assembly.test.ts
//
// 插件装配计算锁（spec §4.2）：enabled 过滤（workspace 级）/ zip·dev 根解析 /
// missing 跳过 / config.json 读取与坏 JSON 降级 / skills refs / mcp 贡献与过滤。
// 真实 tmpdir 插件树 + 真实 DB（AP_USER_DATA_DIR + runMigrations）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import {
  buildPluginToolRefs,
  buildPluginSkillRefs,
  buildPluginMcpNames,
  filterDisabledPluginMcps,
  resolvePluginRoot,
} from '../../src/main/plugin/assembly';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pasm-'));
const pluginsDir = path.join(tmpRoot, 'plugins');

function mkPluginTree(id: string, over: { manifest?: Record<string, unknown> } = {}): string {
  const root = path.join(pluginsDir, 'installed', id, '0.1.0');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'usage'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'usage', 'SKILL.md'),
    '---\nname: usage\ndescription: 用法\n---\n正文',
  );
  fs.writeFileSync(path.join(root, 'tools', 'main.js'), 'module.exports.createTools = () => ({});');
  fs.writeFileSync(
    path.join(root, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { tools: './tools', skills: './skills', mcp: './mcp.json' },
      ...over.manifest,
    }),
  );
  return root;
}

function mkRec(id: string, root: string, over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id,
    version: '0.1.0',
    manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
    ...over,
  };
}

function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', path.join(tmpRoot, id), '@owner:home');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedWorkspace('ws1');
  seedWorkspace('ws2');
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('resolvePluginRoot', () => {
  it('zip → installed 目录；dev → 存在的 sourcePath；missing → null', () => {
    const root = mkPluginTree('cg');
    const devDir = path.join(tmpRoot, 'dev-cg');
    fs.mkdirSync(devDir, { recursive: true });
    expect(resolvePluginRoot(mkRec('cg', root))).toBe(root);
    expect(resolvePluginRoot(mkRec('cg', root, { source: 'dev', sourcePath: devDir }))).toBe(
      devDir,
    );
    expect(resolvePluginRoot(mkRec('cg', root, { state: 'missing' }))).toBeNull();
  });
});

describe('buildPluginToolRefs', () => {
  it('启用插件 → refs 含 rootDir/modulePaths/dataDir/config', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(mkRec('cg', root));
    const refs = buildPluginToolRefs('ws1');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.pluginId).toBe('cg');
    expect(refs[0]!.rootDir).toBe(root);
    expect(refs[0]!.modulePaths).toEqual([path.join(root, 'tools', 'main.js')]);
    expect(refs[0]!.dataDir).toBe(path.join(pluginsDir, 'data', 'cg'));
    expect(refs[0]!.config).toEqual({});
  });

  it('workspace 级隔离：ws1 禁用 ws2 启用（Review Focus #3）', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(mkRec('cg', root));
    setPluginEnabled('cg', 'ws1', false);
    expect(buildPluginToolRefs('ws1')).toHaveLength(0);
    expect(buildPluginToolRefs('ws2')).toHaveLength(1);
  });

  it('dev 源目录消失 → 跳过不抛', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(
      mkRec('cg', root, { source: 'dev', sourcePath: path.join(tmpRoot, 'gone') }),
    );
    expect(buildPluginToolRefs('ws1')).toHaveLength(0);
  });

  it('config.json 存在 → 读入；坏 JSON → 降级 {}', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(mkRec('cg', root));
    const dataDir = path.join(pluginsDir, 'data', 'cg');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"a":1}');
    expect(buildPluginToolRefs('ws1')[0]!.config).toEqual({ a: 1 });
    fs.writeFileSync(path.join(dataDir, 'config.json'), 'not json');
    expect(buildPluginToolRefs('ws1')[0]!.config).toEqual({});
  });

  it('manifest 声明 tools 但目录无 .js → modulePaths 空（ref 仍产出，子进程零模块）', () => {
    const root = mkPluginTree('cg');
    fs.rmSync(path.join(root, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools'));
    upsertPlugin(mkRec('cg', root));
    const refs = buildPluginToolRefs('ws1');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.modulePaths).toEqual([]);
  });
});

describe('buildPluginSkillRefs', () => {
  it('启用插件的 skills 子目录（含 SKILL.md）产出 slug+cachePath', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(mkRec('cg', root));
    const refs = buildPluginSkillRefs('ws1');
    expect(refs).toEqual([
      { slug: 'usage', cachePath: path.join(root, 'skills', 'usage') },
    ]);
    expect(buildPluginSkillRefs('ws1' === 'ws1' ? 'ws2' : 'ws2')).toHaveLength(1);
  });

  it('禁用 workspace → 空', () => {
    const root = mkPluginTree('cg');
    upsertPlugin(mkRec('cg', root));
    setPluginEnabled('cg', 'ws1', false);
    expect(buildPluginSkillRefs('ws1')).toHaveLength(0);
  });
});

describe('buildPluginMcpNames / filterDisabledPluginMcps', () => {
  it('mcp.json 里的 server 名进入贡献集；禁用插件的贡献被过滤', () => {
    const root = mkPluginTree('cg');
    fs.writeFileSync(
      path.join(root, 'mcp.json'),
      JSON.stringify({ servers: { 'cg-fetch': { command: 'npx', args: ['-y', 'cg-fetch'] } } }),
    );
    upsertPlugin(mkRec('cg', root));
    expect(buildPluginMcpNames('ws1')).toEqual(['cg-fetch']);
    setPluginEnabled('cg', 'ws1', false);
    expect(buildPluginMcpNames('ws1')).toEqual([]);
    const filtered = filterDisabledPluginMcps(['builtin-x', 'cg-fetch'], 'ws1');
    expect(filtered).toEqual(['builtin-x']);
  });
});
