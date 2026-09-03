// electron/src/main/settings/crud.ts
//
// 全局/会话级配置的 CRUD + 优先级解析。
// 全局配置存 kv_store（key='global_settings'，value=JSON）；
// 会话级配置存 sessions.settings_json（v23 起取代 v1 的房间级设置表，读写经 sessions repo 转调）。

import { getDb } from '../storage/db';
import { getSessionSettings } from '../storage/sessions/repo';

/** 默认模型引用：指向某供应商模型列表中的一个模型 */
export interface DefaultModelRef {
  providerId: string;
  modelId: string;
}

/** 全局会话配置 */
export interface GlobalSettings {
  /** 工具调用上限默认值。-1=无限, 0=禁用, N=上限 */
  maxToolCalls: number;
  /** 审计日志全局容量上限（MB）；workspace 级可覆盖。默认 100。 */
  auditQuotaMb: number;
  /** 四类默认模型（P2 只存不消费；向量/重排 2.1 知识库启用，会话 fallback P3 接线） */
  defaultChatModel?: DefaultModelRef;
  defaultMultimodalModel?: DefaultModelRef;
  defaultEmbeddingModel?: DefaultModelRef;
  defaultRerankModel?: DefaultModelRef;
  /** 全局并发任务上限（global_settings 表 v21 单行配置，默认 3）。 */
  maxConcurrentTasks?: number;
  /** v2.2：记忆系统总开关（false=停止注入与提取；DB 保留） */
  memoryEnabled?: boolean;
  /** v2.2 P2：自动提取子开关（false=跳过提取管线，注入不受影响）；默认 true */
  memoryExtractionEnabled?: boolean;
}

// 会话级配置（SessionSettings）与 CRUD 直接转调 sessions repo——单一数据源，
// 避免 crud 层重复一份 settings_json 解析逻辑。
export { getSessionSettings, updateSessionSettings } from '../storage/sessions/repo';
export type { SessionSettings } from '../storage/sessions/repo';

const GLOBAL_KEY = 'global_settings';
const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_AUDIT_QUOTA_MB = 100;

/** 读取全局配置；不存在或字段缺失时返回默认值 */
export function getGlobalSettings(): GlobalSettings {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(GLOBAL_KEY) as
    | { value: string }
    | undefined;
  // 并发上限存独立单行表（migration v21，D 子系统设计），与 kv_store JSON 老字段分源
  const concurrencyRow = db
    .prepare('SELECT max_concurrent_tasks FROM global_settings WHERE id = 1')
    .get() as { max_concurrent_tasks: number } | undefined;
  const maxConcurrentTasks = concurrencyRow?.max_concurrent_tasks ?? 3;
  if (!row) {
    return {
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      auditQuotaMb: DEFAULT_AUDIT_QUOTA_MB,
      maxConcurrentTasks,
      memoryEnabled: true,
      memoryExtractionEnabled: true,
    };
  }
  const parsed = JSON.parse(row.value) as Partial<GlobalSettings>;
  return {
    maxToolCalls: parsed.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    auditQuotaMb: parsed.auditQuotaMb ?? DEFAULT_AUDIT_QUOTA_MB,
    defaultChatModel: parsed.defaultChatModel,
    defaultMultimodalModel: parsed.defaultMultimodalModel,
    defaultEmbeddingModel: parsed.defaultEmbeddingModel,
    defaultRerankModel: parsed.defaultRerankModel,
    maxConcurrentTasks,
    memoryEnabled: parsed.memoryEnabled ?? true,
    memoryExtractionEnabled: parsed.memoryExtractionEnabled ?? true,
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
  // 并发上限写独立表（与读侧对称）；仅接受正整数，非法值忽略
  if (typeof patch.maxConcurrentTasks === 'number' && patch.maxConcurrentTasks > 0) {
    db.prepare(
      `UPDATE global_settings SET max_concurrent_tasks = ?, updated_at = datetime('now') WHERE id = 1`,
    ).run(Math.floor(patch.maxConcurrentTasks));
  }
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
