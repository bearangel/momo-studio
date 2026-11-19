// electron/tests/plugin/assembly-grants.test.ts
//
// 装配授权翻转（spec 2026-10-21 §6）：
//   tool 白名单：授权集（组模式/精确名）− 黑名单（组/精确）过滤 modulePaths；
//   全滤空的 ref 丢弃；toolRefMatches 纯函数四组合。
// skill 门与 spawn 组合由 spawn-helpers 域测试覆盖（buildPluginSkillRefs 原样产出）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { filterPluginToolRefsByGrant, toolRefMatches } from '../../src/main/plugin/assembly';
import type { PluginToolRef } from '../../src/main/agent/runtime-config';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-agrant-'));
const pluginsRoot = path.join(tmpRoot, 'plugins');

function seedPluginWithTools(id: string): string {
  const root = path.join(pluginsRoot, id);
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'a.js'), 'module.exports.createTools = () => ({});');
  fs.writeFileSync(path.join(root, 'tools', 'b.js'), 'module.exports.createTools = () => ({});');
  fs.writeFileSync(
    path.join(root, 'momo-plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', description: '', components: { tools: './tools' } }),
  );
  getDb()
    .prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, '1.0.0', ?, 'active', 'dev', ?, 'x')`,
    )
    .run(id, fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'), root);
  getDb()
    .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp/x', '@o')`)
    .run();
  getDb()
    .prepare(`INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('ws1', ?, 1)`)
    .run(id);
  return root;
}

function refOf(id: string, root: string): PluginToolRef {
  return {
    pluginId: id,
    rootDir: root,
    modulePaths: [path.join(root, 'tools', 'a.js'), path.join(root, 'tools', 'b.js')],
    dataDir: path.join(tmpRoot, 'data', id),
    config: {},
  };
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

describe('toolRefMatches（纯函数：精确名 / 组模式）', () => {
  it('精确相等命中；plugin:<id>/* 组模式命中本插件任意名、不命中他插件', () => {
    expect(toolRefMatches('plugin:p/a', ['plugin:p/a'])).toBe(true);
    expect(toolRefMatches('plugin:p/a', ['plugin:p/*'])).toBe(true);
    expect(toolRefMatches('plugin:p/a', ['plugin:q/*'])).toBe(false);
    expect(toolRefMatches('plugin:p/a', ['plugin:p/b'])).toBe(false);
    expect(toolRefMatches('plugin:p/a', [])).toBe(false);
  });
});

describe('filterPluginToolRefsByGrant（白名单 − 黑名单）', () => {
  it('组授权 → 全装配；叠加精确禁 → 剔除该工具', () => {
    const root = seedPluginWithTools('p1');
    const refs = [refOf('p1', root)];
    const granted = filterPluginToolRefsByGrant(refs, ['plugin:p1/*'], []);
    expect(granted[0]!.modulePaths.map((m) => path.basename(m))).toEqual(['a.js', 'b.js']);
    const denied = filterPluginToolRefsByGrant(refs, ['plugin:p1/*'], ['plugin:p1/a']);
    expect(denied[0]!.modulePaths.map((m) => path.basename(m))).toEqual(['b.js']);
  });

  it('精确授权 → 仅该工具；无授权 → ref 丢弃（全滤空）', () => {
    const root = seedPluginWithTools('p2');
    const refs = [refOf('p2', root)];
    const one = filterPluginToolRefsByGrant(refs, ['plugin:p2/b'], []);
    expect(one[0]!.modulePaths.map((m) => path.basename(m))).toEqual(['b.js']);
    expect(filterPluginToolRefsByGrant(refs, [], [])).toEqual([]);
  });

  it('组授权 × 组禁（黑名单优先的保守语义）', () => {
    const root = seedPluginWithTools('p3');
    const refs = [refOf('p3', root)];
    expect(filterPluginToolRefsByGrant(refs, ['plugin:p3/*'], ['plugin:p3/*'])).toEqual([]);
  });
});

// 2026-11-19 口径分裂修复（用户实证 db-pro 场景）：授权/校验域用 getDefs 工具名
// （plugin:db-pro/query），装配过滤旧实现用模块文件 basename（plugin:db-pro/index）
// ——单文件多工具插件的精确授权永远匹配不上，模块整体被剔除。修复：装配匹配键
// 改为模块的工具名集合（moduleToolNames），文件名仅作坏模块回退。
describe('filterPluginToolRefsByGrant 工具名粒度（2026-11-19 修复）', () => {
  /** 单文件多工具 ref：tools/index.js 声明 query/write 两工具（文件名与工具名无关） */
  function multiToolRef(id: string, root: string): { refs: PluginToolRef[]; indexJs: string } {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    const indexJs = path.join(root, 'tools', 'index.js');
    fs.writeFileSync(indexJs, 'module.exports.createTools = () => ({});');
    return {
      refs: [{
        pluginId: id,
        rootDir: root,
        modulePaths: [indexJs],
        dataDir: path.join(tmpRoot, 'data', id),
        config: {},
      }],
      indexJs,
    };
  }

  it('精确授权按工具名命中模块；文件名不再是匹配键', () => {
    const root = path.join(pluginsRoot, 'multi-1');
    const { refs, indexJs } = multiToolRef('m1', root);
    const map = new Map([[indexJs, { pluginId: 'm1', names: ['query', 'write'] }]]);
    // 旧实现：basename 'index' 拼全名 plugin:m1/index ≠ plugin:m1/query → 模块被剔除（bug 现场）
    const hit = filterPluginToolRefsByGrant(refs, ['plugin:m1/query'], [], map);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.modulePaths).toEqual([indexJs]);
    // 授权集若真用文件名（历史数据），map 在场时不认
    expect(filterPluginToolRefsByGrant(refs, ['plugin:m1/index'], [], map)).toEqual([]);
  });

  it('模块内任一工具过授权即准入（逐工具剔除下沉子进程 grantedPluginTools 过滤）', () => {
    const root = path.join(pluginsRoot, 'multi-2');
    const { refs, indexJs } = multiToolRef('m2', root);
    const map = new Map([[indexJs, { pluginId: 'm2', names: ['query', 'write'] }]]);
    const partial = filterPluginToolRefsByGrant(refs, ['plugin:m2/*'], ['plugin:m2/write'], map);
    expect(partial).toHaveLength(1);
    expect(filterPluginToolRefsByGrant(refs, ['plugin:m2/*'], ['plugin:m2/query', 'plugin:m2/write'], map)).toEqual([]);
  });

  it('moduleToolNames 缺项（坏模块实例化失败）→ 回退 basename 旧语义', () => {
    const root = path.join(pluginsRoot, 'multi-3');
    const { refs } = multiToolRef('m3', root);
    // 不传 map：单文件一工具的既有插件（email 形态）行为不变
    const legacy = filterPluginToolRefsByGrant(refs, ['plugin:m3/index'], []);
    expect(legacy).toHaveLength(1);
  });
});
