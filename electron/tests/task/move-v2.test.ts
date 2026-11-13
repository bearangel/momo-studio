// electron/tests/task/move-v2.test.ts
//
// 任务生命周期 v2 Task 8 回归锁：看板七列（等待中/待验收）+ move() 打回/验收路由。
// 本文件锁三件事（brief 裁定范围）：
//   1. 列判定：waiting_human → 'waiting'、submitted → 'review' 等七列归列 + 禁投规则
//      （canDropIntoColumn 语义表关键格——waiting 只出不进 / review 只收提交 / done 收
//      in_progress|submitted / assigned 收 draft|pending|submitted 打回）
//   2. 打回理由校验：submitted → assigned 缺/空白 reason → 主进程先于任何 lifecycle
//      调用抛「打回必须填写理由」（错误消息非 lifecycle-runs 服务错误即校验先行的证明），
//      且拒绝零副作用
//   3. 路由接线（Task 10 转正）：in_progress→review / in_progress→done / submitted→done /
//      submitted→assigned 带理由 四条走 lifecycle-runs 真实两段式链
//
// mock 边界（momo-test-rules，照 move.test.ts 先例）：只 mock lifecycle 三函数；
// lifecycle-runs 不 mock——真实落库（run/acceptance 请求）正是接线断言的对象。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/task/lifecycle', () => ({
  startTaskAndKickoff: vi.fn(),
  resumePausedTask: vi.fn(),
  cancelTask: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  getTask,
  transitionTaskStatus,
  type TaskRow,
} from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun, listRuns } from '../../src/main/storage/tasks/runs-repo';
import { listByTask } from '../../src/main/storage/tasks/human-requests-repo';
import { executeMove } from '../../src/main/task/move';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import { columnOf, canDropIntoColumn } from '../../src/main/task/board-columns';
import { cancelTask } from '../../src/main/task/lifecycle';

const cancelMock = vi.mocked(cancelTask);
cancelMock.mockResolvedValue(undefined);

const WS = 'wsm2';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-move-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 执行会话（human_requests.session_id FK → sessions；验收请求挂它） */
let execSessionId = '';

/** 直插任务（draft/pending/assigned 直插即生产合法；派生态走 seedViaChain） */
const seed = (status: 'draft' | 'pending' | 'assigned', extra: Partial<TaskRow> = {}) =>
  insertTask({ workspaceId: WS, title: 't', creatorUserId: 'owner', status, ...extra });

/**
 * 经生产合法链 seed 派生态（momo-test-rules：不直插 status）。
 * v2 状态机：assigned → in_progress(+会话) → submitted / completed 按需续走
 * （in_progress → completed 直达边已删，completed 必经 submitted 验收）。
 */
function seedViaChain(
  status: 'in_progress' | 'submitted' | 'completed',
  extra: Partial<TaskRow> = {},
): TaskRow {
  const t = seed('assigned', { assigneeAgentId: 'i-1', ...extra });
  transitionTaskStatus(t.id, 'in_progress', { executionSessionId: execSessionId });
  if (status === 'submitted') {
    transitionTaskStatus(t.id, 'submitted', { submittedAt: Date.now() });
  }
  if (status === 'completed') {
    transitionTaskStatus(t.id, 'submitted', { submittedAt: Date.now() });
    transitionTaskStatus(t.id, 'completed', { completedAt: Date.now() });
  }
  return getTask(t.id)!;
}

/**
 * 接线组专用：生产链 seed（assigned → startRun → in_progress + run#1 running）。
 * move 路由的动作（submitRun 等）要求活动 run 存在——纯 transition 链无 run。
 */
function seedRunningTask(extra: Partial<TaskRow> = {}): TaskRow {
  const t = seed('assigned', { assigneeAgentId: 'i-1', executionSessionId: execSessionId, ...extra });
  startRun(t.id, { trigger: 'initial', executionSessionId: execSessionId });
  return getTask(t.id)!;
}

/** 任务下 acceptance 请求（唯一） */
function acceptanceOf(taskId: string) {
  return listByTask(taskId).find((r) => r.kind === 'acceptance');
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelMock.mockResolvedValue(undefined); // clearAllMocks 清掉模块级基线，重置
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(WS, 'Test', '/tmp', 'owner');
  execSessionId = insertSession({ workspaceId: WS, title: '执行', kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('七列列判定（v2 新增 waiting/review）', () => {
  it('columnOf：waiting_human → waiting、submitted → review；十一状态全量归列', () => {
    expect(columnOf('waiting_human')).toBe('waiting');
    expect(columnOf('submitted')).toBe('review');
    // 既有归列不变（回归锁）
    expect(columnOf('draft')).toBe('backlog');
    expect(columnOf('pending')).toBe('backlog');
    expect(columnOf('assigned')).toBe('assigned');
    expect(columnOf('session_queued')).toBe('assigned');
    expect(columnOf('in_progress')).toBe('active');
    expect(columnOf('paused')).toBe('active');
    expect(columnOf('completed')).toBe('done');
    expect(columnOf('failed')).toBe('closed');
    expect(columnOf('cancelled')).toBe('closed');
  });

  it('禁投规则：waiting 只出不进（人不可拖入，系统驱动）', () => {
    expect(canDropIntoColumn('in_progress', 'waiting')).toBe(false);
    expect(canDropIntoColumn('submitted', 'waiting')).toBe(false);
    expect(canDropIntoColumn('assigned', 'waiting')).toBe(false);
    // 同列（waiting_human 留在 waiting）恒可——排序/换泳道语义
    expect(canDropIntoColumn('waiting_human', 'waiting')).toBe(true);
  });

  it('禁投规则：review 只收 in_progress（=提交）', () => {
    expect(canDropIntoColumn('in_progress', 'review')).toBe(true);
    expect(canDropIntoColumn('draft', 'review')).toBe(false);
    expect(canDropIntoColumn('assigned', 'review')).toBe(false);
    expect(canDropIntoColumn('waiting_human', 'review')).toBe(false);
  });

  it('禁投规则：done 收 in_progress|submitted（一步提交+验收 / 验收通过）', () => {
    expect(canDropIntoColumn('in_progress', 'done')).toBe(true);
    expect(canDropIntoColumn('submitted', 'done')).toBe(true);
    expect(canDropIntoColumn('paused', 'done')).toBe(false); // v2：暂停不可拖完成
    expect(canDropIntoColumn('waiting_human', 'done')).toBe(false);
    expect(canDropIntoColumn('completed', 'done')).toBe(true); // 同列恒可
  });

  it('禁投规则：assigned 收 draft|pending|submitted（submitted=打回）', () => {
    expect(canDropIntoColumn('draft', 'assigned')).toBe(true);
    expect(canDropIntoColumn('pending', 'assigned')).toBe(true);
    expect(canDropIntoColumn('submitted', 'assigned')).toBe(true); // 打回通道
    expect(canDropIntoColumn('in_progress', 'assigned')).toBe(false);
    expect(canDropIntoColumn('waiting_human', 'assigned')).toBe(false);
    expect(canDropIntoColumn('completed', 'assigned')).toBe(false);
  });

  it('waiting 列拖入被 move 主进程拒绝（预检②权威裁决，零副作用）', async () => {
    const t = seedViaChain('in_progress');
    await expect(executeMove(t.id, { column: 'waiting', groupId: null })).rejects.toThrow(
      '等待中',
    );
    const after = getTask(t.id)!;
    expect(after.status).toBe('in_progress'); // 拒绝零副作用
    expect(after.groupId).toBeNull();
  });
});

describe('打回理由校验（submitted → assigned）', () => {
  it('缺 reason → 抛「打回必须填写理由」，且先于任何 lifecycle 调用（零副作用）', async () => {
    const t = seedViaChain('submitted');
    await expect(executeMove(t.id, { column: 'assigned', groupId: null })).rejects.toThrow(
      '打回必须填写理由',
    );
    // 错误消息不是 lifecycle-runs 占位的「未接线」= 理由校验先于 rejectTask 调用的证明
    const after = getTask(t.id)!;
    expect(after.status).toBe('submitted'); // 拒绝零副作用：状态不动
    expect(after.groupId).toBeNull(); // 组不写
  });

  it('空白 reason（纯空格）→ 同样拒绝（trim 后判空）', async () => {
    const t = seedViaChain('submitted');
    await expect(
      executeMove(t.id, { column: 'assigned', groupId: null }, { reason: '   ' }),
    ).rejects.toThrow('打回必须填写理由');
    expect(getTask(t.id)!.status).toBe('submitted');
  });

  it('submitted → closed 走既有 cancelTask（验收期取消，不依赖 lifecycle-runs）', async () => {
    const t = seedViaChain('submitted');
    await executeMove(t.id, { column: 'closed', groupId: null });
    expect(cancelMock).toHaveBeenCalledWith(t.id);
  });
});

describe('lifecycle-runs 路由接线（Task 10 已接线：两段式完成语义）', () => {
  it('in_progress → review 路由 submitRun：任务 submitted + submitted_at + 验收请求 pending', async () => {
    const t = seedRunningTask();

    await executeMove(t.id, { column: 'review', groupId: null });

    const after = getTask(t.id)!;
    expect(after.status).toBe('submitted');
    expect(after.submittedAt).not.toBeNull();
    expect(getActiveRun(t.id)!.status).toBe('submitted');
    const req = acceptanceOf(t.id)!;
    expect(req.status).toBe('pending');
    expect(req.kind).toBe('acceptance');
  });

  it('in_progress → done 路由 submitRun 后 acceptTask（一步提交+验收）', async () => {
    const t = seedRunningTask();

    await executeMove(t.id, { column: 'done', groupId: null });

    const after = getTask(t.id)!;
    expect(after.status).toBe('completed');
    expect(after.acceptedAt).not.toBeNull();
    expect(after.completedAt).not.toBeNull();
    expect(getActiveRun(t.id)).toBeNull();
    expect(listRuns(t.id)[0]!.status).toBe('accepted');
    expect(acceptanceOf(t.id)!.status).toBe('answered');
  });

  it('submitted → done 路由 acceptTask(id)（验收通过）', async () => {
    const t = seedRunningTask();
    await submitRun(t.id, { summary: '' }); // 先到待验收列（生产链：review 落点）

    await executeMove(t.id, { column: 'done', groupId: null });

    const after = getTask(t.id)!;
    expect(after.status).toBe('completed');
    expect(after.acceptedAt).not.toBeNull();
    expect(listRuns(t.id)[0]!.status).toBe('accepted');
    expect(acceptanceOf(t.id)!.status).toBe('answered');
  });

  it('submitted → assigned 带理由路由 rejectTask(id, reason)（打回）', async () => {
    const t = seedRunningTask();
    await submitRun(t.id, { summary: '' });

    await executeMove(t.id, { column: 'assigned', groupId: null }, { reason: '需要返工' });

    const after = getTask(t.id)!;
    expect(after.status).toBe('assigned');
    expect(getActiveRun(t.id)).toBeNull();
    const run = listRuns(t.id)[0]!;
    expect(run.status).toBe('rejected');
    expect(run.rejectReason).toBe('需要返工');
    const req = acceptanceOf(t.id)!;
    expect(req.status).toBe('answered');
    expect(JSON.parse(req.answerJson!)).toEqual({ decision: 'reject', reason: '需要返工' });
  });
});
