// electron/src/main/storage/migrations/index.ts
import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  filename: string;
}

export function loadMigrations(): Migration[] {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => ({
    version: parseInt(f.slice(0, 3), 10),
    filename: f,
  }));
}

export function readMigrationSql(migration: Migration): string {
  return fs.readFileSync(path.join(__dirname, migration.filename), 'utf-8');
}