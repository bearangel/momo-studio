// electron/src/main/settings/crud.ts
//
// 全局/房间级会话配置的 CRUD + 优先级解析。
// 全局配置存 kv_store（key='global_settings'，value=JSON），房间配置存 room_settings 表。

import { getDb } from '../storage/db';

/** 全局会话配置 */
export interface GlobalSettings {
  /** 工具调用上限默认值。-1=无限, 0=禁用, N=上限 */
  maxToolCalls: number;
}

/** 房间级会话配置 */
export interface RoomSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
}

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

/** 读取房间配置；不存在返回 null 字段 */
export function getRoomSettings(roomId: string): RoomSettings {
  const db = getDb();
  const row = db
    .prepare('SELECT max_tool_calls FROM room_settings WHERE room_id = ?')
    .get(roomId) as { max_tool_calls: number | null } | undefined;
  if (!row) return { maxToolCalls: null };
  return { maxToolCalls: row.max_tool_calls };
}

/** 部分更新房间配置 */
export function updateRoomSettings(roomId: string, patch: Partial<RoomSettings>): void {
  const current = getRoomSettings(roomId);
  const merged = { ...current, ...patch };
  const db = getDb();
  db.prepare(
    `INSERT INTO room_settings (room_id, max_tool_calls) VALUES (?, ?)
     ON CONFLICT(room_id) DO UPDATE SET max_tool_calls = excluded.max_tool_calls`,
  ).run(roomId, merged.maxToolCalls);
}

/**
 * 解析某房间的有效工具调用上限。
 * 优先级：room_settings.max_tool_calls → global_settings.maxToolCalls → 硬编码 10
 */
export function resolveMaxToolCalls(roomId: string): number {
  const room = getRoomSettings(roomId);
  if (room.maxToolCalls !== null) return room.maxToolCalls;
  return getGlobalSettings().maxToolCalls;
}
