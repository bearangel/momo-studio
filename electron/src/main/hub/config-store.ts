// hub 非密配置（hubUrl/nodeName/nodeId）——kv_store key 'hub_config'（密钥永远不进这里）。
import type { Database } from 'better-sqlite3';

export interface HubConfigRow { hubUrl: string; nodeName: string; nodeId: string | null }

const KEY = 'hub_config';

export interface HubConfigStore { read(): HubConfigRow | null; write(row: HubConfigRow): void; clear(): void }

export function createHubConfigStore(db: Database): HubConfigStore {
  const read = (): HubConfigRow | null => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as Partial<HubConfigRow>;
      if (typeof parsed.hubUrl !== 'string' || typeof parsed.nodeName !== 'string') return null;
      return { hubUrl: parsed.hubUrl, nodeName: parsed.nodeName, nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : null };
    } catch {
      return null; // 脏数据容错（browser settings-store 同款读侧纪律）
    }
  };
  return {
    read,
    write(row) {
      db.prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(KEY, JSON.stringify(row));
    },
    clear() {
      db.prepare('DELETE FROM kv_store WHERE key = ?').run(KEY);
    },
  };
}
