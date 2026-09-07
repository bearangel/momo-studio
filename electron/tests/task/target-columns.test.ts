// electron/tests/task/target-columns.test.ts
//
// Migration v29 + tasks repo 三新字段（目标两列 + 循环母任务链）测试。
// 隔离模式与 scheduler.test.ts 相同：tmp 目录 + AP_USER_DATA_DIR + closeDb。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-targets-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('tasks 目标三列 + 循环链（v29）', () => {
  it('insertTask 带 targetTeamId → getTask 往返保真', () => {
    insertTask({
      workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
      targetTeamId: 'team-1', status: 'assigned',
    });
    expect(getTask('T-001')?.targetTeamId).toBe('team-1');
    expect(getTask('T-001')?.targetSessionId).toBeNull();
    expect(getTask('T-001')?.recurrenceParentId).toBeNull();
  });

  it('updateTask 改 targetSessionId / recurrenceParentId → 往返保真', () => {
    insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home' });
    updateTask('T-001', { targetSessionId: 'sess-1', recurrenceParentId: 'T-000' });
    const t = getTask('T-001')!;
    expect(t.targetSessionId).toBe('sess-1');
    expect(t.recurrenceParentId).toBe('T-000');
  });

  it('两个委派目标同设 → trigger 拒绝（insert 与 update 双路径）', () => {
    expect(() =>
      insertTask({
        workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
        assigneeAgentId: 'inst1', targetTeamId: 'team-1',
      }),
    ).toThrow(/最多一个非空/);

    insertTask({ workspaceId: 'ws1', title: 'T2', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    expect(() => updateTask('T-001', { targetSessionId: 'sess-1' })).toThrow(/最多一个非空/);
  });
});
