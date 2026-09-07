// electron/tests/task/activation-duplicate.test.ts
//
// 回归锁：会话内 #T 激活的双重驱动 bug（2026-09-07 主机报告）。
//
// 症状（主机导出证据）：用户在会话发 `#T-001` 后，同一会话出现两条驱动消息——
// 用户原文 + executor 注入的【任务启动】kickoff——接待 agent 被驱动两轮，
// 两轮各自执行任务并竞速 complete_task（一轮成功、一轮报 completed→completed）。
//
// 正确语义（spec §6 修订）：#T 激活 = 用户消息本身就是启动指令——
//   - 并发有余：activation 就地 startTask（转 in_progress + 锁定执行房间=当前
//     会话），**不注入 kickoff**（用户消息已驱动接待 agent，重发即双驱动）
//   - 并发已满：照旧入队（target_session_id + assigned + notify），executor
//     放行时注入 kickoff（彼时用户消息语境已过，kickoff 是必要驱动）
//
// 本文件锁三点：①即时路径无 kickoff 注入 ②排队路径 kickoff 保留 ③全程无新会话。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { activateMentionedTasks } from '../../src/main/task/activation';
import { taskExecutor } from '../../src/main/task/executor';

const tmpRoot = path.join(os.tmpdir(), `ap-actdup-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 会话内 owner 消息计数（驱动指令条数——用户原文与 kickoff 都以 owner 身份落库） */
function countOwnerMessages(sessionId: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND sender = 'owner'`)
      .get(sessionId) as { n: number }
  ).n;
}

/** sessions 表总行数（防额外会话出现） */
function countSessions(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`).run();
});

afterEach(() => {
  taskExecutor.stop();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('#T 激活双重驱动回归锁', () => {
  it('并发有余：activation 就地 startTask，不注入 kickoff（用户消息是唯一驱动）', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '任务测试', kind: 'chat' });
    insertTask({ workspaceId: 'ws1', title: '任务功能测试', creatorUserId: 'owner', status: 'draft' });
    const sessionsBefore = countSessions();

    const kickoff = vi.fn().mockResolvedValue(undefined);
    taskExecutor.init({ sendKickoff: kickoff, getGlobalMax: () => 3 });

    activateMentionedTasks(sess.id, '#T-001');
    // 等去抖窗口 + 兜底空转（若有 notify 也不该再放行——任务已 in_progress）
    await new Promise((r) => setTimeout(r, 250));

    const t = getTask('T-001')!;
    expect(t.status).toBe('in_progress');
    expect(t.executionSessionId).toBe(sess.id);
    // 核心断言：没有第二条驱动消息（kickoff 不注入；messages 由 sendKickoff 包装
    // 真实 sendUserMessage 时才会 +1，本测试 kickoff 是 fake，故断言调用次数为 0）
    expect(kickoff).not.toHaveBeenCalled();
    // 无新会话（执行房间=当前会话复用）
    expect(countSessions()).toBe(sessionsBefore);
    expect(countOwnerMessages(sess.id)).toBe(0);
  });

  it('并发已满：入队等待，executor 放行时注入 kickoff（必要驱动，非双驱动）', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '任务测试', kind: 'chat' });
    // 真实设置源控制并发上限=1（activation 与 executor 生产中同读 global_settings）
    getDb().prepare(`UPDATE global_settings SET max_concurrent_tasks = 1 WHERE id = 1`).run();
    // 占满 1 个并发槽（占位任务先插入会占 T-001，故目标任务用返回的 id 引用）
    insertTask({ workspaceId: 'ws1', title: '占位', creatorUserId: 'owner', status: 'in_progress', startedAt: Date.now() });
    const target = insertTask({ workspaceId: 'ws1', title: '任务功能测试', creatorUserId: 'owner', status: 'draft' });
    const sessionsBefore = countSessions();

    const kickoff = vi.fn().mockResolvedValue(undefined);
    taskExecutor.init({ sendKickoff: kickoff });
    taskExecutor.start();

    activateMentionedTasks(sess.id, `#${target.id}`);
    expect(getTask(target.id)!.status).toBe('assigned'); // 排队中

    // 释放槽位（占位任务完成）→ notify → 放行 + kickoff
    getDb().prepare(`UPDATE tasks SET status='completed', completed_at=? WHERE title='占位'`).run(Date.now());
    taskExecutor.notify();
    await vi.waitFor(() => expect(getTask(target.id)!.status).toBe('in_progress'));

    expect(getTask(target.id)!.executionSessionId).toBe(sess.id);
    expect(kickoff).toHaveBeenCalledTimes(1); // 排队路径：kickoff 恰好一次
    expect(countSessions()).toBe(sessionsBefore);
  });
});
