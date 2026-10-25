// hub 查看同意设置 kv 存储（:memory: db + kv_store 最小表结构——delegation-settings 同款纪律）：
// 缺省 true（spec §5.5 默认开）、write 归一、脏 JSON 容错回缺省。
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createHubViewSettingsStore } from '../../src/main/hub/view-settings';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}

describe('hub 查看同意设置存储', () => {
  it('空库 read → 缺省允许（allowGroupView=true）；write false → 回读', () => {
    const db = freshDb();
    const store = createHubViewSettingsStore(db);
    expect(store.read()).toEqual({ allowGroupView: true });
    store.write({ allowGroupView: false });
    expect(store.read()).toEqual({ allowGroupView: false });
    db.close();
  });

  it('write 恒归一 boolean（truthy 值不穿透）', () => {
    const db = freshDb();
    const store = createHubViewSettingsStore(db);
    expect(store.write({ allowGroupView: 'yes' as unknown as boolean })).toEqual({ allowGroupView: false });
    expect(store.write({ allowGroupView: true })).toEqual({ allowGroupView: true });
    db.close();
  });

  it('脏 JSON / 异形值 → 缺省允许（不炸读取方）', () => {
    const db = freshDb();
    const store = createHubViewSettingsStore(db);
    db.prepare("INSERT INTO kv_store (key, value) VALUES ('hub_view_settings', '{bad json')").run();
    expect(store.read()).toEqual({ allowGroupView: true });
    db.prepare("UPDATE kv_store SET value = '{\"allowGroupView\":\"no\"}' WHERE key = 'hub_view_settings'").run();
    expect(store.read()).toEqual({ allowGroupView: true });
    db.close();
  });
});
