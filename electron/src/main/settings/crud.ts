// electron/src/main/settings/crud.ts
//
// 全局/会话级配置的 CRUD + 优先级解析。
// 全局配置存 kv_store（key='global_settings'，value=JSON）；
// 会话级配置存 sessions.settings_json（v23 取代 room_settings 表，读写经 sessions repo 转调）。

import { getDb } from '../storage/db';
import { getSessionSettings } from '../storage/sessions/repo';

/** 全局会话配置 */
export interface GlobalSettings {
  /** 工具调用上限默认值。-1=无限, 0=禁用, N=上限 */
  maxToolCalls: number;
}

// 会话级配置（SessionSettings）与 CRUD 直接转调 sessions repo——单一数据源，
// 避免 crud 层重复一份 settings_json 解析逻辑。
export { getSessionSettings, updateSessionSettings } from '../storage/sessions/repo';
export type { SessionSettings } from '../storage/sessions/repo';

const GLOBAL_KEY = 'global_settings';
const DEFAULT_MAX_TOOL_CALLS = 10;

/** 读取全局配置；不存在时返回默认值 */
export function getGlobalSettings(): GlobalSettings {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(GLOBAL_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { maxToolCalls: DEFAULT_MAX_TOOL_CALLS };
  const parsed = JSON.parse(row.value) as Partial<GlobalSettings>;
  return {
    maxToolCalls: parsed.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
  };
}

/** 部分更新全局配置 */
export function updateGlobalSettings(patch: Partial<GlobalSettings>): void {
  const current = getGlobalSettings();
  const merged = { ...current, ...patch };
  const db = getDb();
  db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(GLOBAL_KEY, JSON.stringify(merged));
}

/**
 * 解析某会话的有效工具调用上限。
 * 优先级：sessions.settings_json 的 maxToolCalls → global_settings.maxToolCalls → 硬编码 10
 */
export function resolveMaxToolCalls(sessionId: string): number {
  const session = getSessionSettings(sessionId);
  if (session.maxToolCalls !== null) return session.maxToolCalls;
  return getGlobalSettings().maxToolCalls;
}
