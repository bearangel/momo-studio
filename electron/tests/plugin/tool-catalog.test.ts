// electron/tests/plugin/tool-catalog.test.ts
//
// 工作空间维度 v1.1（spec §7.3）：插件工具目录（agent 配置 UI 数据源）。
// 主进程实例化启用插件的工具模块取静态 name/description——装了即信模型下
// 与 service 同权限级；禁用插件不列出；坏模块跳过不拖垮（P1 resources 同款降级）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { listAssembledToolDefs } from '../../src/main/plugin/tool-catalog';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ptc-'));

function mkPlugin(id: string, toolsSrc: Record<string, string>): void {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  for (const [name, src] of Object.entries(toolsSrc)) {
    fs.writeFileSync(path.join(root, 'tools', name), src);
  }
  upsertPlugin({
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({
      id, name: `插件${id}`, version: '0.1.0', description: '', components: { tools: './tools' },
    }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  });
}

const GOOD_TOOLS = `
module.exports.createTools = function () {
  return {
    getDefs() {
      return [
        { name: 'explore', description: '查询图谱', inputSchema: { type: 'object' } },
        { name: 'status', description: '索引状态', inputSchema: { type: 'object' } },
      ];
    },
    getCatalog() { return []; },
    handles() { return true; },
    async execute() { return ''; },
  };
};
`;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    "INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'W', '/tmp/w1', 'u1')",
  ).run();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('listAssembledToolDefs（插件工具目录）', () => {
  it('列出启用插件的工具（fullName=plugin:<id>/<短名>，含插件显示名与描述）', () => {
    mkPlugin('cg', { 'explore.js': GOOD_TOOLS });
    const defs = listAssembledToolDefs('ws1');
    const explore = defs.find((d) => d.toolName === 'explore');
    expect(explore).toMatchObject({
      pluginId: 'cg',
      pluginName: '插件cg',
      toolName: 'explore',
      fullName: 'plugin:cg/explore',
      description: '查询图谱',
    });
    expect(defs.find((d) => d.toolName === 'status')).toBeDefined();
  });

  it('禁用插件不列出（§8.6 装配面过滤）', () => {
    mkPlugin('cg2', { 'explore.js': GOOD_TOOLS });
    setPluginEnabled('cg2', 'ws1', false);
    expect(listAssembledToolDefs('ws1')).toHaveLength(0);
  });

  it('坏模块（无 createTools / 抛错）进跳过不拖垮整批', () => {
    mkPlugin('bad', {
      'a.js': 'module.exports = {};',
      'b.js': 'throw new Error("bad module");',
    });
    expect(listAssembledToolDefs('ws1')).toHaveLength(0);
  });
});
