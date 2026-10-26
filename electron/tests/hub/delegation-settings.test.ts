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
  it('空库 read → 缺省（接受开 / 并发 2 / 超时 15 分钟）；write → 回读', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    expect(store.read()).toEqual({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    store.write({ acceptTasks: false, maxConcurrent: 4, hitlTimeoutMinutes: 30 });
    expect(store.read()).toEqual({ acceptTasks: false, maxConcurrent: 4, hitlTimeoutMinutes: 30 });
    db.close();
  });

  it('maxConcurrent 夹取到 [1,8]；acceptTasks 恒归一 boolean', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    expect(store.write({ acceptTasks: true, maxConcurrent: 0, hitlTimeoutMinutes: 15 }).maxConcurrent).toBe(1);
    expect(store.write({ acceptTasks: true, maxConcurrent: 99, hitlTimeoutMinutes: 15 }).maxConcurrent).toBe(8);
    expect(store.write({ acceptTasks: true, maxConcurrent: 3, hitlTimeoutMinutes: 15 }).maxConcurrent).toBe(3);
    db.close();
  });

  it('hitlTimeoutMinutes 夹取到 [1,120]、四舍五入、非有限数回缺省 15（T11/RM-M21-4）', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    expect(store.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 0 }).hitlTimeoutMinutes).toBe(1);
    expect(store.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 999 }).hitlTimeoutMinutes).toBe(120);
    expect(store.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 20.4 }).hitlTimeoutMinutes).toBe(20);
    expect(store.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: Number.NaN }).hitlTimeoutMinutes).toBe(15);
    expect(store.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: Number.POSITIVE_INFINITY }).hitlTimeoutMinutes).toBe(15);
    db.close();
  });

  it('脏 JSON / 异形值 → 缺省（不炸读取方）；旧两字段 JSON（历史库）→ 超时补缺省 15', () => {
    const db = freshDb();
    const store = createHubDelegationSettingsStore(db);
    db.prepare("INSERT INTO kv_store (key, value) VALUES ('hub_delegation_settings', '{bad json')").run();
    expect(store.read()).toEqual({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    // T10 时期落库的两字段形状（hitlTimeoutMinutes 引入前）——读侧补缺省不丢老值
    db.prepare("UPDATE kv_store SET value = ? WHERE key = 'hub_delegation_settings'")
      .run(JSON.stringify({ acceptTasks: false, maxConcurrent: 3 }));
    expect(store.read()).toEqual({ acceptTasks: false, maxConcurrent: 3, hitlTimeoutMinutes: 15 });
    // 异形超时值（字符串/负数）→ 夹取或缺省，不炸
    db.prepare("UPDATE kv_store SET value = ? WHERE key = 'hub_delegation_settings'")
      .run(JSON.stringify({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: '30' }));
    expect(store.read().hitlTimeoutMinutes).toBe(15);
    db.prepare("UPDATE kv_store SET value = ? WHERE key = 'hub_delegation_settings'")
      .run(JSON.stringify({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: -5 }));
    expect(store.read().hitlTimeoutMinutes).toBe(1);
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
