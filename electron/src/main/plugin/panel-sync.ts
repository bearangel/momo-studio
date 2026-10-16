// electron/src/main/plugin/panel-sync.ts
//
// 插件面板契约（P4，spec §6.1）——panel.json 加载/校验/listPanels/变更推送。
//
// 形状（v1 全集，多收拒绝）：
//   { "panels": [ { "id": "graph", "title": "代码图谱", "icon": "lucide:git-fork",
//                   "location": "sidebar", "entry": "./index.html" } ] }
//
// 校验时机语义：
//   - 安装/重载：loadAndValidatePanels throw → 安装拒绝（拒绝式管线）
//   - 运行时列表（listPluginPanels）：单插件解析失败 → 跳过 + warn（不炸整表）
import fs from 'node:fs';
import path from 'node:path';
import { listPlugins, isPluginEnabled } from './registry';
import { resolvePluginRoot } from './assembly';
import { PLUGIN_PANEL_SCHEME } from './protocol';
import { logger } from '../logger';
import type { PluginRecord } from './types';

/** renderer 收到后刷新面板列表的推送通道（preload 显式暴露） */
export const PLUGIN_PANEL_CHANGED_CHANNEL = 'plugin:panelsChanged';

/** 面板声明（panel.json 单项，已归一：icon 带缺省） */
export interface PanelDecl {
  id: string;
  title: string;
  icon: string;
  location: 'sidebar';
  entry: string;
}

/** renderer 消费形状（跨 IPC 纯数据；renderer types.d.ts 同形定义） */
export interface PluginPanelInfo {
  pluginId: string;
  pluginName: string;
  panelId: string;
  title: string;
  icon: string;
  entryUrl: string;
}

/** v1 挂载点唯一值（location 白名单） */
const ALLOWED_LOCATIONS = ['sidebar'] as const;

/** 每插件面板数上限（防 manifest 轰炸活动栏） */
const MAX_PANELS = 4;

function isSlugLike(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s);
}

/** 相对 entry 路径合法：./ 前缀、无 ..、无反斜杠 */
function isSafeEntry(s: string): boolean {
  return s.startsWith('./') && !s.includes('..') && !s.includes('\\');
}

/** 指定根目录校验面板声明（安装/重载管线直接传 staging/root；注册表态经 loadAndValidatePanels） */
export function validatePanelsAtRoot(
  root: string,
  manifest: { components?: { panel?: string } },
  pluginId: string,
): PanelDecl[] {
  const panelRel = manifest.components?.panel;
  if (!panelRel) return [];
  const panelDir = path.resolve(root, panelRel);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(panelDir, 'panel.json'), 'utf-8'));
  } catch {
    throw new Error(`panel.json 缺失或损坏: ${pluginId}`);
  }
  const obj = raw as { panels?: unknown };
  if (typeof raw !== 'object' || raw === null || !Array.isArray(obj.panels) || obj.panels.length === 0) {
    throw new Error(`panel.json 须为非空 panels 数组: ${pluginId}`);
  }
  if (obj.panels.length > MAX_PANELS) {
    throw new Error(`面板数超过上限 ${MAX_PANELS}: ${pluginId}`);
  }
  const out: PanelDecl[] = [];
  for (const item of obj.panels) {
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || !isSlugLike(p.id)) {
      throw new Error(`面板 id 非法（slug 白名单外）: ${pluginId}`);
    }
    if (typeof p.title !== 'string' || p.title.trim().length === 0) {
      throw new Error(`面板 title 不能为空: ${pluginId}/${p.id}`);
    }
    if (p.location !== undefined && !ALLOWED_LOCATIONS.includes(p.location as 'sidebar')) {
      throw new Error(`面板 location v1 仅支持 sidebar: ${pluginId}/${p.id}`);
    }
    if (p.icon !== undefined && (typeof p.icon !== 'string' || !/^lucide:[a-z0-9-]+$/.test(p.icon))) {
      throw new Error(`面板 icon 须为 lucide:<name> 形式: ${pluginId}/${p.id}`);
    }
    if (typeof p.entry !== 'string' || !isSafeEntry(p.entry)) {
      throw new Error(`面板 entry 须为 ./ 相对路径且不含穿越段: ${pluginId}/${p.id}`);
    }
    const entryAbs = path.resolve(panelDir, p.entry);
    if (!entryAbs.startsWith(panelDir + path.sep) || !fs.existsSync(entryAbs)) {
      throw new Error(`面板 entry 文件不存在: ${pluginId}/${p.id}`);
    }
    out.push({
      id: p.id,
      title: p.title,
      icon: typeof p.icon === 'string' ? p.icon : 'lucide:puzzle',
      location: 'sidebar',
      entry: p.entry,
    });
  }
  return out;
}

/** 注册表态入口：解析当前根后委托 validatePanelsAtRoot */
export function loadAndValidatePanels(rec: PluginRecord): PanelDecl[] {
  const root = resolvePluginRoot(rec);
  if (!root) throw new Error(`插件目录不存在: ${rec.id}`);
  return validatePanelsAtRoot(root, JSON.parse(rec.manifestJson), rec.id);
}

/** './panel' + './index.html' → 'panel/index.html'（URL path 段，无前导斜杠） */
function toUrlSegments(panelRel: string, entry: string): string {
  return [panelRel, entry]
    .map((s) => s.replace(/^\.\//, '').replace(/^\/+/, ''))
    .join('/')
    .replace(/\/+/g, '/');
}

/** 面板目录路径段（components.panel 归一） */
function panelRelOf(rec: PluginRecord): string | null {
  const manifest = JSON.parse(rec.manifestJson) as { components?: { panel?: string } };
  return manifest.components?.panel ?? null;
}

/**
 * workspace 视角的可用面板清单（只含已启用插件——§8.6 禁用即消失）。
 * 单插件解析失败跳过 + warn（运行时容错；安装链已保证曾经合法）。
 */
export function listPluginPanels(workspaceId: string): PluginPanelInfo[] {
  const out: PluginPanelInfo[] = [];
  for (const rec of listPlugins()) {
    if (!isPluginEnabled(rec.id, workspaceId)) continue;
    const panelRel = panelRelOf(rec);
    if (!panelRel) continue;
    let decls: PanelDecl[];
    try {
      decls = loadAndValidatePanels(rec);
    } catch (err) {
      logger.warn('插件面板解析失败，已跳过', {
        pluginId: rec.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const d of decls) {
      out.push({
        pluginId: rec.id,
        pluginName: (JSON.parse(rec.manifestJson) as { name?: string }).name ?? rec.id,
        panelId: d.id,
        title: d.title,
        icon: d.icon,
        entryUrl: `${PLUGIN_PANEL_SCHEME}://${rec.id}/${toUrlSegments(panelRel, d.entry)}`,
      });
    }
  }
  return out;
}

/** 面板清单变更推送（安装/卸载/重载/启停后调用）。broadcast 可注入（测试）。 */
export function notifyPanelsChanged(
  broadcast: (channel: string) => void = defaultBroadcast,
): void {
  broadcast(PLUGIN_PANEL_CHANGED_CHANNEL);
}

/** 生产广播：所有窗口 webContents.send。electron 懒加载——非 Electron 运行时
 *  （vitest）require 返回路径字符串，此时无窗口可推，静默跳过（keychain 同款先例） */
function defaultBroadcast(channel: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | string;
  if (typeof electron === 'string') return;
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send(channel);
  }
}
