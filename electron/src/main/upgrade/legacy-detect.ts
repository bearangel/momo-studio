// electron/src/main/upgrade/legacy-detect.ts
//
// v1.x 旧库检测（P5 Task 1）。
// v23 是 2.0 会话内核的分界线（messages.room_id→session_id 等列重命名），
// appliedMax ∈ [1, 22] 即旧库；≥ 23 或无法判定均为非旧库，交由正常启动链处理。
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import { logger } from '../logger';

/** v2 schema 分界：首个 2.0 migration 版本号 */
export const V2_CUTOFF_VERSION = 23;

export interface LegacyDbStatus {
  legacy: boolean;
  appliedMax: number;
}

/**
 * 只读探测 state.db 是否为 v1.x 旧库。
 * - 文件不存在 → { legacy: false, appliedMax: 0 }
 * - 无 schema_migrations 表（全新空文件）→ { legacy: false, appliedMax: 0 }
 * - MAX(version) ≥ 23 → 非旧库（2.0 已应用，含中断续跑场景）
 * - 1 ≤ MAX(version) ≤ 22 → 旧库
 * - 打开/查询失败（文件损坏）→ 按非旧库返回，不抛出
 */
export function detectLegacyDb(dbPath: string): LegacyDbStatus {
  if (!fs.existsSync(dbPath)) {
    return { legacy: false, appliedMax: 0 };
  }

  let db: DBType | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as { name: string } | undefined;
    if (!table) {
      return { legacy: false, appliedMax: 0 };
    }
    const row = db.prepare('SELECT MAX(version) AS max FROM schema_migrations').get() as {
      max: number | null;
    };
    const appliedMax = row.max ?? 0;
    const legacy = appliedMax >= 1 && appliedMax < V2_CUTOFF_VERSION;
    return { legacy, appliedMax };
  } catch (err) {
    logger.warn('旧库检测失败（文件不可读或损坏），按非旧库处理', {
      dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { legacy: false, appliedMax: 0 };
  } finally {
    db?.close();
  }
}
