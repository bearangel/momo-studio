// electron/tests/storage/migration-056-system-sender.test.ts
//
// migration 056 契约（spec 2026-10-13 §5.7，dispatch 回执 P0-A）：
//   1. 存量 dispatch 回执行（owner + task_id + 「【dispatch 回执自动送达】」前缀）→ sender='system'
//   2. 存量 followup 追问行（owner + task_id + parent_stream_session_id）→ sender='system'
//   3. 真实用户行零误伤：无 task_id 的 owner 行、带 task_id 但无回执特征（无前缀且无 parent）的 owner 行均不动
//   4. 幂等：已翻 system 的行重放无变化（sender='owner' 条件不再命中）
//   5. 注册锁：schema_migrations 含 version 56（MIGRATIONS 数组已登记）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { migration056 } from '../../src/main/storage/migrations/056_system_sender_flip';

const tmpRoot = path.join(os.tmpdir(), `ap-mig056-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种子四类存量行（模拟 056 之前的库状态）后手动重放 056 SQL——同 052/054 惯例：
 * runMigrations 先于插行（库已迁到最新），migration 时点语义靠 exec(up) 重放锁定。 */
function seedLegacyRowsAndReplay(): void {
  insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
    body: '【dispatch 回执自动送达】任务链 t-1（第 1 轮）已完成（工具调用 3 次）。', taskId: 't-1' });
  insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
    body: '请继续调研 X', taskId: 't-2', parentStreamSessionId: 's-pm-1' });
  insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
    body: '帮我看下这个任务 #T-task-9', taskId: null });
  insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
    body: '普通用户消息', taskId: 't-3' });
  getDb().exec(migration056.up);
}

function senderOf(body: string): string | undefined {
  const row = getDb()
    .prepare('SELECT sender FROM messages WHERE body = ?')
    .get(body) as { sender: string } | undefined;
  return row?.sender;
}

describe('migration 056：存量 system 行翻新', () => {
  it('回执行翻 sender=system', () => {
    seedLegacyRowsAndReplay();
    expect(
      senderOf('【dispatch 回执自动送达】任务链 t-1（第 1 轮）已完成（工具调用 3 次）。'),
    ).toBe('system');
  });

  it('followup 追问行翻 sender=system', () => {
    seedLegacyRowsAndReplay();
    expect(senderOf('请继续调研 X')).toBe('system');
  });

  it('真实用户行零误伤（无 task_id / 带 task_id 但无回执特征均不动）', () => {
    seedLegacyRowsAndReplay();
    expect(senderOf('帮我看下这个任务 #T-task-9')).toBe('owner');
    expect(senderOf('普通用户消息')).toBe('owner');
  });

  it('幂等：已翻 system 的行重放无变化', () => {
    seedLegacyRowsAndReplay();
    getDb().exec(migration056.up);
    expect(senderOf('请继续调研 X')).toBe('system');
    expect(senderOf('帮我看下这个任务 #T-task-9')).toBe('owner');
  });

  it('注册锁：schema_migrations 含 version 56', () => {
    const versions = getDb()
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toContain(56);
  });
});
