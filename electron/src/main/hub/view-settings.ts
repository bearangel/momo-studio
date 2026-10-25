// hub 远程查看同意设置（「允许本组查看」开关，spec M2 §5.5 双层同意的节点层）——
// kv_store key 'hub_view_settings'。delegation-settings 同款读写纪律：
// 脏 JSON 容错回缺省；默认 true（§5.5 默认开）。
import type { Database } from 'better-sqlite3';

export interface HubViewSettings {
  /** 允许同组组长查看本机工作空间（关闭 = hub 对 view.* 返 forbidden） */
  allowGroupView: boolean;
}

const KEY = 'hub_view_settings';
const DEFAULTS: HubViewSettings = { allowGroupView: true };

export interface HubViewSettingsStore {
  read(): HubViewSettings;
  write(input: HubViewSettings): HubViewSettings;
}

export function createHubViewSettingsStore(db: Database): HubViewSettingsStore {
  const read = (): HubViewSettings => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(row.value) as Partial<HubViewSettings>;
      return { allowGroupView: typeof parsed.allowGroupView === 'boolean' ? parsed.allowGroupView : DEFAULTS.allowGroupView };
    } catch {
      return { ...DEFAULTS }; // 脏数据容错（config-store 同款读侧纪律）
    }
  };
  return {
    read,
    write(input) {
      const normalized: HubViewSettings = { allowGroupView: input.allowGroupView === true };
      db.prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(KEY, JSON.stringify(normalized));
      return normalized;
    },
  };
}
