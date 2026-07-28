// electron/src/main/storage/db.ts
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import { resolveDbPath } from '../paths';
import { logger } from '../logger';
import { loadMigrations, readMigrationSql } from './migrations';

let dbInstance: DBType | null = null;

export function getDb(): DBType {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    logger.info('SQLite opened', { path: dbPath });
  }
  return dbInstance;
}

export function runMigrations(): void {
  const db = getDb();
  // schema_migrations may not exist yet on a fresh DB; treat as empty.
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get() as { name: string } | undefined;
  const applied = new Set<number>(
    existing
      ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
          (r) => r.version
        )
      : []
  );

  const migrations = loadMigrations();
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    logger.info('Applying migration', { version: m.version, file: m.filename });
    const sql = readMigrationSql(m);
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}