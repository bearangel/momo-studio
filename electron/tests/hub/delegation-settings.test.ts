// 委派设置与本地账本 kv 存储（:memory: db + kv_store 最小表结构——config-store 同款纪律）：
// 设置缺省值（接受开/并发 2）与夹取边界、脏 JSON 容错回缺省；账本 upsert/更新态/读取。
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}

describe('hub 委派设置存储', () => {
  it('空库 read → 缺省（接受开 / 并发 2）；write → 回读', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    expect(store.read()).toEqual({ acceptTasks: true, maxConcurrent: 2 });
    store.write({ acceptTasks: false, maxConcurrent: 4 });
    expect(store.read()).toEqual({ acceptTasks: false, maxConcurrent: 4 });
    db.close();
  });

  it('maxConcurrent 夹取到 [1,8]；acceptTasks 恒归一 boolean', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    expect(store.write({ acceptTasks: true, maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(store.write({ acceptTasks: true, maxConcurrent: 99 }).maxConcurrent).toBe(8);
    expect(store.write({ acceptTasks: true, maxConcurrent: 3 }).maxConcurrent).toBe(3);
    db.close();
  });

  it('脏 JSON / 异形值 → 缺省（不炸读取方）', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    db.prepare("INSERT INTO kv_store (key, value) VALUES ('hub_delegation_settings', '{bad json')").run();
    expect(store.read()).toEqual({ acceptTasks: true, maxConcurrent: 2 });
    db.close();
  });
});

describe('hub 委派本地账本存储', () => {
  it('upsert → get 全字段；updateState 迁移；list 列全量', () => {
    const db = freshDb();
    const store = createHubDelegationStore(db);
    expect(store.get('t1')).toBeNull();
    store.upsert({
      taskId: 't1', sessionId: 's1', workspaceId: 'w1', workspaceName: 'ws-a',
      title: '修 bug', byNode: 'node-1', state: 'running', createdAt: 1, updatedAt: 1,
    });
    expect(store.get('t1')).toMatchObject({ taskId: 't1', sessionId: 's1', state: 'running' });
    store.updateState('t1', 'done');
    expect(store.get('t1')?.state).toBe('done');
    expect(store.get('t1')?.updatedAt).toBeGreaterThanOrEqual(1);
    expect(store.list()).toHaveLength(1);
    store.upsert({
      taskId: 't2', sessionId: 's2', workspaceId: 'w1', workspaceName: 'ws-a',
      title: 'x', byNode: 'node-1', state: 'running', createdAt: 2, updatedAt: 2,
    });
    expect(store.list().map((r) => r.taskId).sort()).toEqual(['t1', 't2']);
    db.close();
  });

  it('脏 JSON / 异形行 → 容错跳过（get null、list 不含）', () => {
    const db = freshDb();
    const store = createHubDelegationStore(db);
    db.prepare("INSERT INTO kv_store (key, value) VALUES ('hub_delegations', '{bad json')").run();
    expect(store.get('t1')).toBeNull();
    expect(store.list()).toEqual([]);
    db.close();
  });
});
