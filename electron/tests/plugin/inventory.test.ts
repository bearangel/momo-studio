// electron/tests/plugin/inventory.test.ts
//
// plugin:getDetail 组件清单（spec 2026-10-21 §9②）：MCP/工具/skill/agent/面板/
// service/config 七面；missing 态容错（各数组空 + service/config false，不 throw）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getPluginDetail } from '../../src/main/plugin/inventory';
import { installPluginDevDir } from '../../src/main/plugin/installer';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-inv-'));

function mkFullPlugin(): string {
  const dir = path.join(tmpRoot, 'plug-inv');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tools', 'nav.js'),
    "module.exports.createTools = () => ({ getDefs: () => [{ name: 'nav', description: '导航' }], handles: () => false, execute: async () => '' });",
  );
  fs.mkdirSync(path.join(dir, 'skills', 'inv-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'inv-skill', 'SKILL.md'), '# inv-skill\n');
  fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mcp', 'mcp.json'),
    JSON.stringify({ servers: { 'inv-server': { command: 'npx', args: ['-y', 'x'] } } }),
  );
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id: 'inv', name: 'INV', version: '1.0.0', description: '',
      components: { tools: './tools', skills: './skills', mcp: './mcp/mcp.json' },
      config: { type: 'object', properties: { k: { type: 'string' } } },
    }),
  );
  return dir;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('w1', 'W', '/tmp/x', '@o')`)
    .run();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('getPluginDetail（组件清单）', () => {
  it('全组件插件 → 七面齐（mcp/工具/skill 来自装配面；agents 来自定义行）', () => {
    installPluginDevDir(mkFullPlugin(), '2.1.0', 'w1');
    const d = getPluginDetail('inv', 'w1');
    expect(d.pluginId).toBe('inv');
    expect(d.mcps.map((m) => m.name)).toEqual(['inv-server']);
    expect(d.tools.map((t) => t.fullName)).toEqual(['plugin:inv/nav']);
    expect(d.skills.map((s) => s.slug)).toEqual(['inv-skill']);
    expect(d.config).toBe(true);
    expect(Array.isArray(d.agents)).toBe(true);
    expect(Array.isArray(d.panels)).toBe(true);
  });

  it('missing 态（目录消失）→ 容错空清单不 throw', () => {
    installPluginDevDir(mkFullPlugin(), '2.1.0', 'w1');
    // dev 源目录改名 → missing
    fs.renameSync(path.join(tmpRoot, 'plug-inv'), path.join(tmpRoot, 'plug-inv-gone'));
    const d = getPluginDetail('inv', 'w1');
    expect(d.tools).toEqual([]); // 装配面按目录扫描——目录没了即空
    expect(d.skills).toEqual([]);
    // mcps 按 mcp_definitions 定义行列（目录消失不删定义，重载可恢复）——保留展示
    expect(d.mcps).toEqual([{ name: 'inv-server' }]);
    expect(d.service).toBe(false);
    expect(d.config).toBe(true); // config 为 manifest 声明性字段（DB 行仍在）——与运行可用性无关
  });

  it('不存在插件 → throw 中文', () => {
    expect(() => getPluginDetail('nope', 'w1')).toThrow('插件不存在');
  });
});
