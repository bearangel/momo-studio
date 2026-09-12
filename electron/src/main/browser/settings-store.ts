// electron/src/main/browser/settings-store.ts
//
// workspace 级浏览器设置读写（v2.7 McpBrowser Task 6，spec 2026-09-11 §6.2/§9）。
// 持久化形态：workspace_settings 表六列（migration v034）——信任三值枚举 /
// evaluate 开关 / 黑白名单 JSON 数组 / 侧栏折叠与宽度。
//
// db 经 createBrowserSettingsStore(db) 注入（journal store 同款）——测试与生产
// 共用 getDb()。读侧对脏数据全容错（坏 JSON → 空数组 + warn；非法 trust → ask
// + warn），绝不 throw——read 是 BrowserPolicy 信任门的热路径依赖（每次工具
// 调用都过 readSettings），设置层故障不能拖垮工具链。
//
// 写侧域名条目归一化（T1 review 裁定，binding）：policy.domainMatches 只匹配
// 纯 hostname，写入侧必须保证落库条目即该形态——trim / 去 scheme / 去端口 /
// 小写 / 丢空。归一化只发生在 write，read 原样回显（库内即已归一）。

import type { Database as DB } from 'better-sqlite3';
import { logger } from '../logger';
import type { WorkspaceBrowserSettings } from './types';

/** 完整浏览器设置：策略四列（T1 契约）+ 侧栏 UI 两列 */
export type BrowserSettings = WorkspaceBrowserSettings & {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
};

/** write 的 patch 形态：任意字段子集，未给字段保持既有值 */
export type BrowserSettingsPatch = Partial<BrowserSettings>;

/** 默认值（spec §9 六列 DEFAULT 的 TS 镜像；缺失行 / 脏数据回退到此） */
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  trust: 'ask',
  evaluateEnabled: false,
  blacklist: [],
  whitelist: [],
  sidebarCollapsed: false,
  sidebarWidth: 380,
};

export interface BrowserSettingsStore {
  read(wsId: string): BrowserSettings;
  write(wsId: string, patch: BrowserSettingsPatch): void;
}

const TRUST_VALUES: readonly WorkspaceBrowserSettings['trust'][] = ['ask', 'always', 'deny'];

/** 域名条目归一化：trim → 小写 → 去 scheme（含协议相对 //）→ 去端口；产物为空则丢弃 */
export function normalizeDomainEntry(entry: string): string {
  let v = entry.trim().toLowerCase();
  // scheme：'https://evil.com' → 'evil.com'（replace 不命中即原样，无索引访问）
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // 协议相对前缀：'//evil.com' → 'evil.com'
  if (v.startsWith('//')) v = v.slice(2);
  // 端口：仅末尾 `:数字` 形态（'evil.com:8080' → 'evil.com'）
  v = v.replace(/:\d+$/, '');
  return v;
}

/** 整表归一化：逐条归一后丢空（空串 / 纯空白 / 归一化后为空） */
export function normalizeDomainList(entries: readonly string[]): string[] {
  return entries.map(normalizeDomainEntry).filter((e) => e.length > 0);
}

/** JSON 数组列容错解析：坏 JSON / 非数组 / 非字符串元素 → 回退（warn 仅记解析层） */
function parseListColumn(raw: unknown, wsId: string, column: string): string[] {
  if (typeof raw !== 'string') {
    logger.warn('workspace_settings 域名列非文本，回退空数组', { wsId, column });
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('非数组');
    }
    return parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    logger.warn('workspace_settings 域名列 JSON 解析失败，回退空数组', { wsId, column });
    return [];
  }
}

/** trust 列容错解析：非法枚举值 → ask + warn（列无 CHECK，TS 侧是唯一防线） */
function parseTrust(raw: unknown, wsId: string): WorkspaceBrowserSettings['trust'] {
  if (raw === 'ask' || raw === 'always' || raw === 'deny') return raw;
  logger.warn('workspace_settings.trust_browser 脏值，回退 ask', { wsId, value: String(raw) });
  return 'ask';
}

interface SettingsRow {
  trust_browser: unknown;
  browser_evaluate_enabled: unknown;
  browser_domain_blacklist: unknown;
  browser_domain_whitelist: unknown;
  browser_sidebar_collapsed: unknown;
  browser_sidebar_width: unknown;
}

function rowToSettings(row: SettingsRow | undefined, wsId: string): BrowserSettings {
  if (!row) return { ...DEFAULT_BROWSER_SETTINGS };
  return {
    trust: parseTrust(row.trust_browser, wsId),
    evaluateEnabled: !!row.browser_evaluate_enabled,
    blacklist: parseListColumn(row.browser_domain_blacklist, wsId, 'browser_domain_blacklist'),
    whitelist: parseListColumn(row.browser_domain_whitelist, wsId, 'browser_domain_whitelist'),
    sidebarCollapsed: !!row.browser_sidebar_collapsed,
    sidebarWidth:
      typeof row.browser_sidebar_width === 'number'
        ? row.browser_sidebar_width
        : DEFAULT_BROWSER_SETTINGS.sidebarWidth,
  };
}

export function createBrowserSettingsStore(db: DB): BrowserSettingsStore {
  const stmtRead = db.prepare(`
    SELECT trust_browser, browser_evaluate_enabled, browser_domain_blacklist,
           browser_domain_whitelist, browser_sidebar_collapsed, browser_sidebar_width
    FROM workspace_settings WHERE workspace_id = ?
  `);
  const stmtUpsert = db.prepare(`
    INSERT INTO workspace_settings (
      workspace_id, trust_browser, browser_evaluate_enabled,
      browser_domain_blacklist, browser_domain_whitelist,
      browser_sidebar_collapsed, browser_sidebar_width
    ) VALUES (
      @workspaceId, @trustBrowser, @browserEvaluateEnabled,
      @browserDomainBlacklist, @browserDomainWhitelist,
      @browserSidebarCollapsed, @browserSidebarWidth
    )
    ON CONFLICT(workspace_id) DO UPDATE SET
      trust_browser = excluded.trust_browser,
      browser_evaluate_enabled = excluded.browser_evaluate_enabled,
      browser_domain_blacklist = excluded.browser_domain_blacklist,
      browser_domain_whitelist = excluded.browser_domain_whitelist,
      browser_sidebar_collapsed = excluded.browser_sidebar_collapsed,
      browser_sidebar_width = excluded.browser_sidebar_width
  `);

  const read = (wsId: string): BrowserSettings =>
    rowToSettings(stmtRead.get(wsId) as SettingsRow | undefined, wsId);

  const write = (wsId: string, patch: BrowserSettingsPatch): void => {
    // IPC 无类型边界：非法枚举 fail-fast，不落库（列无 CHECK，这里是唯一写侧防线）
    if (patch.trust !== undefined && !TRUST_VALUES.includes(patch.trust)) {
      throw new Error(`非法信任级别: ${String(patch.trust)}（合法值 ask/always/deny）`);
    }
    // 读改写合并（主进程单连接同步执行，无并发窗口）；坏 JSON 列在此顺带自愈
    const merged: BrowserSettings = { ...read(wsId), ...patch };
    merged.blacklist = normalizeDomainList(merged.blacklist);
    merged.whitelist = normalizeDomainList(merged.whitelist);
    stmtUpsert.run({
      workspaceId: wsId,
      trustBrowser: merged.trust,
      browserEvaluateEnabled: merged.evaluateEnabled ? 1 : 0,
      browserDomainBlacklist: JSON.stringify(merged.blacklist),
      browserDomainWhitelist: JSON.stringify(merged.whitelist),
      browserSidebarCollapsed: merged.sidebarCollapsed ? 1 : 0,
      browserSidebarWidth: merged.sidebarWidth,
    });
  };

  return { read, write };
}
