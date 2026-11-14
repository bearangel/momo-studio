// electron/tests/im/session-delete-guard.test.ts
//
// 生命周期 v2 Task 17（spec 2026-11-13-task-human-loop-lifecycle §5.4）：
//   - SessionSummary 生命周期三字段（delegationRole / readOnly / taskId）：
//     tasks.execution_session_id 反查最新非终态行派生（readOnly = delegationRole==='out'，
//     P1 唯一只读源——委派跟踪会话输入框禁用）
//   - 会话删除守卫 assertSessionDeletable：任务处于 in_progress / waiting_human /
//     submitted 时抛人话错误；终态（completed/failed/cancelled）或无任务关联放行
//
// DB 隔离沿用 session-ops.test.ts 模式：
//   - process.env.AP_USER_DATA_DIR 指向临时目录 + runMigrations() + afterEach closeDb()
//   - 任务种子走生产 repo（insertTask / transitionTaskStatus），不裸拼状态列；
//     created_at 经显式 UPDATE 固定（生产 API 不接受 createdAt——insertTask/updateTask
//     恒写 Date.now()），保证「最新非终态行」判定确定性
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createSession, getSessionsForWorkspace } from '../../src/main/im/session-ops';
import {
  insertTask,
  updateTask,
  transitionTaskStatus,
  assertSessionDeletable,
} from '../../src/main/storage/tasks/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-session-delete-guard-${Date.now()}`);

/** tasks.workspace_id 有 FK → 先落 workspaces 行（最小列，仅本测试用） */
function seedWorkspace(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁');
}

/** 生产路径种任务并固定 created_at（排序判定需确定性时间戳） */
function seedTask(args: {
  workspaceId: string;
  executionSessionId: string;
  status: 'in_progress' | 'waiting_human' | 'submitted';
  delegationRole?: 'in' | 'out' | null;
  createdAt: number;
}): string {
  const row = insertTask({
    workspaceId: args.workspaceId,
    title: '守卫种子任务',
    creatorUserId: '@owner:s',
    executionSessionId: args.executionSessionId,
    status: args.status,
  });
  // insertTask 的 INSERT 列面不含 delegation_role（委派方向属生命周期写路径，
  // 走 updateTask 单点回写——brief「手工 updateTask 种子」）
  if (args.delegationRole !== undefined) {
    updateTask(row.id, { delegationRole: args.delegationRole });
  }
  getDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(args.createdAt, row.id);
  return row.id;
}

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

describe('assertSessionDeletable（spec §5.4 活动任务关联会话禁止删除）', () => {
  it.each(['in_progress', 'waiting_human', 'submitted'] as const)(
    '任务 %s 且 execution_session_id=目标 → 抛人话错误「任务进行中，请先取消或完结」',
    (status) => {
      const db = getDb();
      seedWorkspace(db, 'ws1');
      const sess = createSession({ workspaceId: 'ws1', title: '执行会话' });
      seedTask({ workspaceId: 'ws1', executionSessionId: sess.id, status, createdAt: 1000 });

      expect(() => assertSessionDeletable(sess.id)).toThrow('任务进行中，请先取消或完结');
    },
  );

  it('终态任务放行：in_progress → cancelled 后守卫不再拦截', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const sess = createSession({ workspaceId: 'ws1', title: '执行会话' });
    const tid = seedTask({
      workspaceId: 'ws1',
      executionSessionId: sess.id,
      status: 'in_progress',
      createdAt: 1000,
    });
    transitionTaskStatus(tid, 'cancelled');

    expect(() => assertSessionDeletable(sess.id)).not.toThrow();
  });

  it('无任务关联的会话放行', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const sess = createSession({ workspaceId: 'ws1', title: '普通会话' });

    expect(() => assertSessionDeletable(sess.id)).not.toThrow();
  });
});

describe('SessionSummary 生命周期三字段（spec §5.4）', () => {
  it('delegationRole 从任务行带出：out → readOnly=true（P1 唯一只读源）；in → readOnly=false', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const track = createSession({ workspaceId: 'ws1', title: '委派跟踪' });
    const remote = createSession({ workspaceId: 'ws1', title: '外派执行' });
    seedTask({
      workspaceId: 'ws1',
      executionSessionId: track.id,
      status: 'in_progress',
      delegationRole: 'out',
      createdAt: 1000,
    });
    seedTask({
      workspaceId: 'ws1',
      executionSessionId: remote.id,
      status: 'in_progress',
      delegationRole: 'in',
      createdAt: 1000,
    });

    const summaries = getSessionsForWorkspace('ws1');
    const trackSummary = summaries.find((s) => s.id === track.id)!;
    const remoteSummary = summaries.find((s) => s.id === remote.id)!;
    expect(trackSummary.delegationRole).toBe('out');
    expect(trackSummary.readOnly).toBe(true);
    expect(remoteSummary.delegationRole).toBe('in');
    expect(remoteSummary.readOnly).toBe(false);
  });

  it('无活跃任务关联 → delegationRole=null / readOnly=false / taskId=null', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    createSession({ workspaceId: 'ws1', title: '普通会话' });

    const [summary] = getSessionsForWorkspace('ws1');
    expect(summary!.delegationRole).toBeNull();
    expect(summary!.readOnly).toBe(false);
    expect(summary!.taskId).toBeNull();
  });

  it('taskId 取最新非终态行：多任务同会话取 created_at 最大者；最新转终态后回退次新', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const sess = createSession({ workspaceId: 'ws1', title: '多任务会话' });
    const older = seedTask({
      workspaceId: 'ws1',
      executionSessionId: sess.id,
      status: 'in_progress',
      createdAt: 1000,
    });
    const newer = seedTask({
      workspaceId: 'ws1',
      executionSessionId: sess.id,
      status: 'waiting_human',
      createdAt: 2000,
    });

    const latestOf = (): string | null =>
      getSessionsForWorkspace('ws1').find((s) => s.id === sess.id)!.taskId ?? null;
    expect(latestOf()).toBe(newer);

    // 最新行转终态 → 只剩次新非终态行可选
    transitionTaskStatus(newer, 'cancelled');
    expect(latestOf()).toBe(older);
  });
});
