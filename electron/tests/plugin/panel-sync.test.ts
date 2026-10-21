// electron/tests/plugin/panel-sync.test.ts
//
// T2 RED：panel.json 契约（加载/校验/listPanels 启用过滤/panelsChanged 推送）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAndValidatePanels,
  listPluginPanels,
  notifyPanelsChanged,
  PLUGIN_PANEL_CHANGED_CHANNEL,
} from '../../src/main/plugin/panel-sync';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { resolvePluginInstalledDir } from '../../src/main/paths';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ppanel-'));

function mkRecord(id: string, components: Record<string, string>): PluginRecord {
  return {
    id,
    version: '0.4.0',
    manifestJson: JSON.stringify({ id, name: `插件${id}`, version: '0.4.0', description: '', components }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
}

function writePanelJson(id: string, raw: unknown, files: string[] = ['index.html']): void {
  const panelDir = path.join(resolvePluginInstalledDir(id, '0.4.0'), 'panel');
  fs.mkdirSync(panelDir, { recursive: true });
  fs.writeFileSync(path.join(panelDir, 'panel.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
  for (const f of files) fs.writeFileSync(path.join(panelDir, f), '<html></html>');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`)
    .run();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('panel.json 校验（拒绝式）', () => {
  it('无 panel 组件 → 空数组', () => {
    const rec = mkRecord('nopanel', { tools: './tools' });
    expect(loadAndValidatePanels(rec)).toEqual([]);
  });

  it('合法声明 → PanelDecl（icon 缺省 lucide:puzzle）', () => {
    writePanelJson('cg', {
      panels: [{ id: 'graph', title: '代码图谱', location: 'sidebar', entry: './index.html' }],
    });
    const rec = mkRecord('cg', { panel: './panel' });
    upsertPlugin(rec);
    setPluginEnabled('cg', 'ws1', true);
    expect(loadAndValidatePanels(rec)).toEqual([
      { id: 'graph', title: '代码图谱', icon: 'lucide:puzzle', location: 'sidebar', entry: './index.html' },
    ]);
  });

  it.each([
    ['panels 缺失', { foo: 1 }],
    ['panels 空数组', { panels: [] }],
    ['panels 非数组', { panels: 'x' }],
    ['超过 4 项', { panels: [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, title: 't', location: 'sidebar', entry: './index.html' })) }],
    ['id 非 slug', { panels: [{ id: 'BAD ID', title: 't', location: 'sidebar', entry: './index.html' }] }],
    ['title 空', { panels: [{ id: 'graph', title: '', location: 'sidebar', entry: './index.html' }] }],
    ['location 非法值', { panels: [{ id: 'graph', title: 't', location: 'main', entry: './index.html' }] }],
    ['icon 无 lucide 前缀', { panels: [{ id: 'graph', title: 't', icon: 'github', location: 'sidebar', entry: './index.html' }] }],
    ['entry 缺 ./ 前缀', { panels: [{ id: 'graph', title: 't', location: 'sidebar', entry: 'index.html' }] }],
    ['entry 穿越上级', { panels: [{ id: 'graph', title: 't', location: 'sidebar', entry: '../evil.html' }] }],
    ['entry 反斜杠', { panels: [{ id: 'graph', title: 't', location: 'sidebar', entry: '.\\index.html' }] }],
  ])('%s → throw', (_name, raw) => {
    writePanelJson('cg', raw);
    const rec = mkRecord('cg', { panel: './panel' });
    expect(() => loadAndValidatePanels(rec)).toThrow();
  });

  it('entry 文件不存在 → throw', () => {
    writePanelJson('cg', {
      panels: [{ id: 'graph', title: 't', location: 'sidebar', entry: './missing.html' }],
    });
    const rec = mkRecord('cg', { panel: './panel' });
    expect(() => loadAndValidatePanels(rec)).toThrow();
  });

  it('panel.json 损坏 JSON → throw', () => {
    writePanelJson('cg', '{broken');
    const rec = mkRecord('cg', { panel: './panel' });
    expect(() => loadAndValidatePanels(rec)).toThrow();
  });
});

describe('listPluginPanels（启用过滤 + entryUrl）', () => {
  it('已启用插件 → entryUrl 形如 momo-plugin://<id>/panel/<entry>', () => {
    writePanelJson('cg', {
      panels: [{ id: 'graph', title: '代码图谱', icon: 'lucide:git-fork', location: 'sidebar', entry: './index.html' }],
    });
    upsertPlugin(mkRecord('cg', { panel: './panel' }));
    setPluginEnabled('cg', 'ws1', true);
    const panels = listPluginPanels('ws1');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toEqual({
      pluginId: 'cg',
      pluginName: '插件cg',
      panelId: 'graph',
      title: '代码图谱',
      icon: 'lucide:git-fork',
      entryUrl: 'momo-plugin://cg/panel/index.html',
      placement: 'sidebar',
    });
  });

  it('workspace 禁用 → 面板消失（§8.6）', () => {
    writePanelJson('cg', {
      panels: [{ id: 'graph', title: 't', location: 'sidebar', entry: './index.html' }],
    });
    upsertPlugin(mkRecord('cg', { panel: './panel' }));
    setPluginEnabled('cg', 'ws1', true);
    setPluginEnabled('cg', 'ws1', false);
    expect(listPluginPanels('ws1')).toEqual([]);
  });

  it('运行时解析失败 → 跳过该插件不炸列表（install 时已校验，此处容错）', () => {
    writePanelJson('bad', { panels: [] }); // 装后被人改坏
    upsertPlugin(mkRecord('bad', { panel: './panel' }));
    setPluginEnabled('bad', 'ws1', true);
    expect(listPluginPanels('ws1')).toEqual([]);
  });
});

describe('notifyPanelsChanged 推送', () => {
  it('经注入的 broadcast 发 plugin:panelsChanged', () => {
    const bc = vi.fn();
    notifyPanelsChanged(bc);
    expect(bc).toHaveBeenCalledWith(PLUGIN_PANEL_CHANGED_CHANNEL);
  });
});


// ── 工作空间维度 v1.1（spec §6 修订）：location 扩 page —— placement 透传 ──
describe('panel placement（page 主区形态）', () => {
  it('location: page 合法并透传 placement；缺省 location 仍 sidebar', () => {
    writePanelJson('cgpage', {
      panels: [
        { id: 'graph', title: '代码图谱', icon: 'lucide:git-fork', location: 'page', entry: './index.html' },
        { id: 'mini', title: '迷你', entry: './index.html' },
      ],
    });
    const rec = mkRecord('cgpage', { panel: './panel' });
    upsertPlugin(rec);
    setPluginEnabled('cgpage', 'ws1', true);
    const decls = loadAndValidatePanels(rec);
    expect(decls[0]?.location).toBe('page');
    expect(decls[1]?.location).toBe('sidebar');
    const ws = getDb().prepare(
      "INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('wsp', 'p', '/tmp/p', 'u1')",
    );
    ws.run();
    setPluginEnabled('cgpage', 'wsp', true);
    const infos = listPluginPanels('wsp');
    const page = infos.find((i) => i.panelId === 'graph');
    const side = infos.find((i) => i.panelId === 'mini');
    expect(page?.placement).toBe('page');
    expect(side?.placement).toBe('sidebar');
  });
});
