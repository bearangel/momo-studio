// hub 配置 kv 存储：读写清三态（:memory: db + kv_store 最小表结构——与主库 schema 对齐）。
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createHubConfigStore } from '../../src/main/hub/config-store';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}

describe('hub config store', () => {
  it('空库 read → null；write → read 回读；clear → null；脏 JSON 容错回 null', () => {
    const db = freshDb();
    const store = createHubConfigStore(db);
    expect(store.read()).toBeNull();
    store.write({ hubUrl: 'https://hub.lan:8787', nodeName: 'mac-main', nodeId: 'n1' });
    expect(store.read()).toEqual({ hubUrl: 'https://hub.lan:8787', nodeName: 'mac-main', nodeId: 'n1' });
    store.clear();
    expect(store.read()).toBeNull();
    db.prepare("INSERT INTO kv_store (key, value) VALUES ('hub_config', '{bad json')").run();
    expect(store.read()).toBeNull();
    db.close();
  });
});
