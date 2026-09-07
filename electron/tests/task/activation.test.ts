// electron/tests/task/activation.test.ts
//
// #T 激活语义（spec §6 + 双驱动修复）：draft/pending/assigned → 激活到当前会话，
// 并发有余时就地 startTask（in_progress + 执行房间=当前会话，不注入 kickoff——
// 用户消息已是驱动指令）；in_progress/终态 → 仅引用不动。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { activateMentionedTasks } from '../../src/main/task/activation';

const tmpRoot = path.join(os.tmpdir(), `ap-act-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('activateMentionedTasks', () => {
  it('draft 任务 → 目标覆盖为当前会话（清空 agent 目标）+ 就地 in_progress', () => {
    insertTask({ workspaceId: 'ws1', title: '草稿', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'draft' });
    activateMentionedTasks('sess-9', '请处理 #T-001 谢谢');
    const t = getTask('T-001')!;
    expect(t.status).toBe('in_progress');
    expect(t.targetSessionId).toBe('sess-9');
    expect(t.assigneeAgentId).toBeNull(); // 用户显式意图覆盖原目标（spec §6）
    expect(t.executionSessionId).toBe('sess-9'); // 即时路径锁定执行房间=当前会话
  });

  it('pending / assigned → 同样就地 in_progress + 目标覆盖', () => {
    insertTask({ workspaceId: 'ws1', title: '定时', creatorUserId: 'o', status: 'pending', scheduledAt: Date.now() + 999_999 });
    insertTask({ workspaceId: 'ws1', title: '排队', creatorUserId: 'o', targetTeamId: 'team1', status: 'assigned' });
    activateMentionedTasks('sess-9', '#T-001 和 #T-002');
    const t1 = getTask('T-001')!;
    expect(t1.status).toBe('in_progress');
    expect(t1.executionSessionId).toBe('sess-9');
    const t2 = getTask('T-002')!;
    expect(t2.status).toBe('in_progress');
    expect(t2.targetSessionId).toBe('sess-9');
    expect(t2.targetTeamId).toBeNull();
  });

  it('in_progress / 终态任务与不存在的 id → 不动作', () => {
    insertTask({ workspaceId: 'ws1', title: '跑着', creatorUserId: 'o', status: 'in_progress' });
    insertTask({ workspaceId: 'ws1', title: '完了', creatorUserId: 'o', status: 'completed' });
    activateMentionedTasks('sess-9', '#T-001 #T-002 #T-999');
    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(getTask('T-002')!.status).toBe('completed');
    expect(getTask('T-001')!.targetSessionId).toBeNull();
  });

  it('无 mention 正文 → no-op 不抛错', () => {
    expect(() => activateMentionedTasks('sess-9', '普通消息 #hashtag')).not.toThrow();
  });
});
