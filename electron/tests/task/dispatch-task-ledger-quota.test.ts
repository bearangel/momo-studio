// electron/tests/task/dispatch-task-ledger-quota.test.ts
//
// 配额受限自动续跑（2026-11-04 生产事故）：dispatch 账本 settle 面的调度行为。
// 事故链路：子 agent task_reply(failed, 429 配额错误文本) → applyRegistryReply →
// ledgerSettleDispatch。配额失败不落终态 failed——改排 assigned + scheduled_at
// 自动续跑（走既有 executor 放行链），error_message 保留配额错误文案，会话收到
// 恰一条系统通知；连续 3 次后第 4 次回落既有终态 failed（人工介入）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import {
  ledgerInsertDispatch,
  ledgerSettleDispatch,
} from '../../src/main/agent/dispatch-task-ledger';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-quota-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const CHAIN = {
  taskId: 'q-chain-001',
  body: '写 index.html 游戏主页面',
  pmAssignmentId: 'inst-pm',
  subAssignmentId: 'inst-smith',
};

/** insertSession 生成 UUID 作 id——seed 后动态绑定（ledger 投影行落在该会话） */
let sessionId = '';

/** 事故同构 429 配额错误文本（双层结构），重置时间动态生成保证未来窗口 */
function quotaErrorText(resetAt: Date | null): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const resetSentence = resetAt
    ? `已达到 5 小时的使用上限。您的限额将在 ${fmt(resetAt)} 重置。`
    : '已达到 5 小时的使用上限，请稍后使用。';
  return (
    '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
    '\n||details||\n' +
    `HTTP 429 {"error":{"code":"1308","message":"${resetSentence}"}}`
  );
}

/** 瞬时限流 429（无配额措辞）——行为必须不变（终态 failed） */
function transient429Text(): string {
  return (
    '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
    '\n||details||\n' +
    'HTTP 429 {"error":{"message":"Too many requests"}}'
  );
}

function seed(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  for (const inst of ['inst-pm', 'inst-smith']) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, `agent-${inst}`);
  }
  sessionId = insertSession({ workspaceId: 'ws', title: '协作会话', kind: 'chat' }).id;
}

/** 读 routing_json 上的连续配额续跑计数（无标记 = 0） */
function quotaCount(taskId: string): number {
  const row = getDb()
    .prepare('SELECT routing_json FROM tasks WHERE id = ?')
    .get(taskId) as { routing_json: string | null } | undefined;
  if (!row?.routing_json) return 0;
  try {
    const parsed = JSON.parse(row.routing_json) as { quotaRetryCount?: unknown };
    return typeof parsed.quotaRetryCount === 'number' ? parsed.quotaRetryCount : 0;
  } catch {
    return 0;
  }
}

/** 会话里的配额自动续跑系统通知行 */
function quotaNotices(taskId: string): Array<{ body: string }> {
  return getDb()
    .prepare(
      `SELECT body FROM messages WHERE session_id = ? AND task_id = ? AND sender = 'system' AND body LIKE '【配额受限自动续跑】%'`,
    )
    .all(sessionId, taskId) as Array<{ body: string }>;
}

/** HH:mm（通知文案里的续跑时刻） */
function fmtHM(ts: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date(ts);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seed();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('ledgerSettleDispatch 配额自动续跑调度（QUOTA_LIMITED ≠ 终态 failed）', () => {
  it('解析成功：配额失败 → assigned + scheduled_at=重置+30s + 计数 1 + 恰一条通知（文案精确）', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    const reset = new Date(Date.now() + 2 * 3600_000);
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(reset));

    const row = getTask(CHAIN.taskId)!;
    expect(row.status, '等待自动续跑——不得终态 failed').toBe('assigned');
    // 错误体只有秒精度：解析产物对齐到秒（毫秒位归零）再 +30s
    const expectedDue = Math.floor(reset.getTime() / 1000) * 1000 + 30_000;
    expect(row.scheduledAt, '重置时刻 + 30s').toBe(expectedDue);
    expect(row.errorMessage, '等待期 error_message 仍带配额错误文案（UI 显示暂停原因）').toContain('使用上限');
    expect(row.errorMessage).toContain('已自动重试 5 次');
    expect(quotaCount(CHAIN.taskId)).toBe(1);

    const notices = quotaNotices(CHAIN.taskId);
    expect(notices, '每次调度恰一条系统通知').toHaveLength(1);
    expect(notices[0]!.body).toBe(
      `【配额受限自动续跑】任务 #${CHAIN.taskId} · ${CHAIN.body} 因模型配额上限暂停，将于 ${fmtHM(expectedDue)} 自动续跑（第 1/3 次）。`,
    );
  });

  it('解析失败：退避模式第 1 次 → now+5 分钟', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    const before = Date.now();
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    const row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('assigned');
    expect(Math.abs(row.scheduledAt! - (before + 5 * 60_000))).toBeLessThan(15_000);
    expect(quotaCount(CHAIN.taskId)).toBe(1);
    expect(quotaNotices(CHAIN.taskId)).toHaveLength(1);
  });

  it('第 2 次连续配额失败 → 退避 15 分钟（第 2/3 次）；第 3 次 → 30 分钟（第 3/3 次）', () => {
    // 第 1 次：调度（退避 5 分钟）
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    expect(quotaCount(CHAIN.taskId)).toBe(1);

    // followup 链复用复位回 in_progress（计数标记随 routing_json 保留）
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    let row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('in_progress');
    expect(quotaCount(CHAIN.taskId), '复位不清计数（连续性跨轮保持）').toBe(1);

    // 第 2 次：15 分钟
    const before2 = Date.now();
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('assigned');
    expect(Math.abs(row.scheduledAt! - (before2 + 15 * 60_000))).toBeLessThan(15_000);
    expect(quotaCount(CHAIN.taskId)).toBe(2);
    expect(quotaNotices(CHAIN.taskId).at(-1)!.body).toContain('第 2/3 次');

    // 第 3 次：30 分钟
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    const before3 = Date.now();
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('assigned');
    expect(Math.abs(row.scheduledAt! - (before3 + 30 * 60_000))).toBeLessThan(15_000);
    expect(quotaCount(CHAIN.taskId)).toBe(3);
    expect(quotaNotices(CHAIN.taskId).at(-1)!.body).toContain('第 3/3 次');
  });

  it('第 4 次配额失败（预算耗尽）→ 回落终态 failed + 人工介入文案 + 计数清零 + 无新通知', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    for (let i = 0; i < 3; i++) {
      ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
      ledgerInsertDispatch({ ...CHAIN, sessionId }); // 复位
    }
    expect(quotaCount(CHAIN.taskId)).toBe(3);

    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    const row = getTask(CHAIN.taskId)!;
    expect(row.status, '3 次自动续跑用尽——终态 failed（人工介入）').toBe('failed');
    expect(row.errorMessage).toContain('使用上限');
    expect(row.completedAt).not.toBeNull();
    expect(quotaCount(CHAIN.taskId), '终态清计数').toBe(0);
    expect(quotaNotices(CHAIN.taskId)).toHaveLength(3);
  });

  it('瞬时限流 429（无配额措辞）→ 行为不变：终态 failed + 无通知 + 计数清零', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    getDb()
      .prepare(`UPDATE tasks SET routing_json = ? WHERE id = ?`)
      .run(JSON.stringify({ quotaRetryCount: 2 }), CHAIN.taskId);

    ledgerSettleDispatch(CHAIN.taskId, 'failed', transient429Text());

    const row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('服务繁忙');
    expect(quotaNotices(CHAIN.taskId)).toHaveLength(0);
    expect(quotaCount(CHAIN.taskId)).toBe(0);
  });

  it('非 429 失败（连接中断）→ 行为不变：终态 failed + 计数清零', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    getDb()
      .prepare(`UPDATE tasks SET routing_json = ? WHERE id = ?`)
      .run(JSON.stringify({ quotaRetryCount: 1 }), CHAIN.taskId);

    ledgerSettleDispatch(CHAIN.taskId, 'failed', '连接中断：terminated');

    expect(getTask(CHAIN.taskId)!.status).toBe('failed');
    expect(quotaCount(CHAIN.taskId)).toBe(0);
  });

  it('成功（completed）→ 计数清零（连续性断）', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null)); // 计数 1，assigned
    ledgerInsertDispatch({ ...CHAIN, sessionId }); // 复位 in_progress
    transitionTaskStatus(CHAIN.taskId, 'submitted'); // v2：settle completed = 验收已提交交付
    ledgerSettleDispatch(CHAIN.taskId, 'completed');

    expect(getTask(CHAIN.taskId)!.status).toBe('completed');
    expect(quotaCount(CHAIN.taskId)).toBe(0);
  });

  it('needs_input → paused（既有映射）+ 计数清零', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null));
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    ledgerSettleDispatch(CHAIN.taskId, 'needs_input');

    expect(getTask(CHAIN.taskId)!.status).toBe('paused');
    expect(quotaCount(CHAIN.taskId)).toBe(0);
  });

  it('迟到失败钩子（行已排队 assigned）→ 不覆盖排队行、不重复通知', () => {
    ledgerInsertDispatch({ ...CHAIN, sessionId });
    ledgerSettleDispatch(CHAIN.taskId, 'failed', quotaErrorText(null)); // 调度 → assigned
    const scheduled = getTask(CHAIN.taskId)!.scheduledAt;

    // 迟到的第二个失败钩子（含非配额文本）——不得把 assigned 打回 failed
    ledgerSettleDispatch(CHAIN.taskId, 'failed', '连接中断：terminated');

    const row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('assigned');
    expect(row.scheduledAt).toBe(scheduled);
    expect(quotaNotices(CHAIN.taskId)).toHaveLength(1);
  });
});
