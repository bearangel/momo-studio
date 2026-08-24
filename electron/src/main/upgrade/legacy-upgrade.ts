// electron/src/main/upgrade/legacy-upgrade.ts
//
// v1.x 旧库升级编排（P5 Task 1）：detect → export → backup → 标记。
// 主进程 boot 链在 runMigrations 之前调用 runLegacyUpgradeIfNeeded()；
// kv 标记必须延迟到 runMigrations 之后（kv_store 表在新库上才存在），
// 由 index.ts 顺序执行：先 runLegacyUpgradeIfNeeded() → runMigrations() → writeLegacyUpgradeNotice()。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath, resolveUserDataDir } from '../paths';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { detectLegacyDb } from './legacy-detect';
import { exportLegacyData } from './legacy-export';

export const LEGACY_UPGRADE_NOTICE_KEY = 'legacy_upgrade_notice';

const BACKUP_SUFFIX = '.legacy-v1.bak';

function formatTimestamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 旧库升级编排：
 *   1. detectLegacyDb 判定；非旧库直接返回 null（零副作用）
 *   2. 旧库 → userData 下建 upgrade-export-<YYYYMMDD-HHmmss>/ 并导出
 *      （导出异常只 warn 不阻塞——旧数据随后整体进备份，不会丢）
 *   3. state.db（含 -wal/-shm 若存在）改名加 .legacy-v1.bak 后缀，下次
 *      runMigrations 在原路径重新初始化全新 2.0 库
 * 返回导出目录绝对路径；非旧库返回 null。
 */
export async function runLegacyUpgradeIfNeeded(): Promise<string | null> {
  const dbPath = resolveDbPath();
  const status = detectLegacyDb(dbPath);
  if (!status.legacy) {
    return null;
  }
  logger.info('检测到 v1.x 旧库，执行导出与备份重置', { dbPath, appliedMax: status.appliedMax });

  const exportDir = path.join(resolveUserDataDir(), `upgrade-export-${formatTimestamp(new Date())}`);
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    const result = exportLegacyData(dbPath, exportDir);
    logger.info('旧库数据已导出', {
      exportDir,
      sessionCount: result.sessionCount,
      agentDefCount: result.agentDefCount,
    });
  } catch (err) {
    logger.warn('旧库导出失败（不阻塞升级，旧数据保留在备份文件中）', {
      exportDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 导出连接已在 exportLegacyData 内关闭；此处改名三件套（wal/shm 为崩溃残留时才存在）
  const backups: string[] = [];
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(p)) {
      fs.renameSync(p, `${p}${BACKUP_SUFFIX}`);
      backups.push(`${path.basename(p)}${BACKUP_SUFFIX}`);
    }
  }
  logger.info('旧库已备份重置', { dbPath, backups });

  return exportDir;
}

/**
 * 写入 kv 升级标记（须在 runMigrations 之后调用——kv_store 表那时才存在）。
 * 值为 { exportDir }，P5 后续任务的 UI 通知从这里取导出目录。
 */
export function writeLegacyUpgradeNotice(exportDir: string): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(LEGACY_UPGRADE_NOTICE_KEY, JSON.stringify({ exportDir }));
}
