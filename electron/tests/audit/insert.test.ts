// electron/tests/audit/insert.test.ts
//
// 验证 insertToolCall 落库行形状：
//   - 列值往返（workspace/agent/tool/summary/success/duration/taskId）
//   - timestamp 由 SQLite datetime('now') 生成（UTC 'YYYY-MM-DD HH:MM:SS' 格式且贴近当前时间）
//   - 不同 workspace 互不影响

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertToolCall } from '../../src/main/audit/insert';
import { getToolCalls } from '../../src/main/audit/query';
import { insertTask } from '../../src/main/storage/tasks/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-audit-insert-test-${Date.now()}`);

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

describe('audit/insertToolCall', () => {
  it('落库一行，列值经 getToolCalls 往返一致', () => {
    insertToolCall({
      workspaceId: 'ws-1',
      agentBotUserId: '@bot:a',
      toolName: 'read_file',
      inputSummary: '读取 README',
      outputSummary: '内容…',
      success: true,
      durationMs: 123,
    });
    insertToolCall({
      workspaceId: 'ws-1',
      agentBotUserId: '@bot:a',
      toolName: 'bash',
      inputSummary: 'rm -rf /tmp/x',
      outputSummary: '失败',
      success: false,
      durationMs: 45,
      taskId: 'task-9',
    });

    const rows = getToolCalls('ws-1');
    expect(rows).toHaveLength(2);

    const ok = rows.find((r) => r.toolName === 'read_file')!;
    expect(ok.id).toBeTruthy();
    expect(ok.workspaceId).toBe('ws-1');
    expect(ok.agentBotUserId).toBe('@bot:a');
    expect(ok.inputSummary).toBe('读取 README');
    expect(ok.outputSummary).toBe('内容…');
    expect(ok.success).toBe(true);
    expect(ok.durationMs).toBe(123);
    expect(ok.taskId).toBeNull();

    const fail = rows.find((r) => r.toolName === 'bash')!;
    expect(fail.success).toBe(false);
    expect(fail.durationMs).toBe(45);
    expect(fail.taskId).toBe('task-9');
  });

  it('timestamp 由 datetime(\'now\') 生成——UTC 秒级格式且贴近当前时间', () => {
    insertToolCall({
      workspaceId: 'ws-1',
      agentBotUserId: '@bot:a',
      toolName: 'glob',
      inputSummary: '',
      outputSummary: '',
      success: true,
      durationMs: 0,
    });
    const row = getToolCalls('ws-1')[0]!;
    // datetime('now') 产出 'YYYY-MM-DD HH:MM:SS'（UTC）
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const ts = new Date(row.timestamp.replace(' ', 'T') + 'Z').getTime();
    const drift = Math.abs(Date.now() - ts);
    expect(drift).toBeLessThan(60_000);
  });

  it('主键随机生成——两次插入不冲突，且不残留同 id 行', () => {
    for (let i = 0; i < 5; i++) {
      insertToolCall({
        workspaceId: 'ws-1',
        agentBotUserId: '@bot:a',
        toolName: 'grep',
        inputSummary: 'i',
        outputSummary: String(i),
        success: true,
        durationMs: i,
      });
    }
    expect(getToolCalls('ws-1')).toHaveLength(5);
  });

  it('不同 workspace 隔离', () => {
    insertToolCall({
      workspaceId: 'ws-1', agentBotUserId: '@bot:a', toolName: 't',
      inputSummary: '', outputSummary: '', success: true, durationMs: 1,
    });
    insertToolCall({
      workspaceId: 'ws-2', agentBotUserId: '@bot:a', toolName: 't',
      inputSummary: '', outputSummary: '', success: true, durationMs: 1,
    });
    expect(getToolCalls('ws-1')).toHaveLength(1);
    expect(getToolCalls('ws-2')).toHaveLength(1);
    // DB 中无游离行（总数恰为 2）
    const total = getDb().prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number };
    expect(total.n).toBe(2);
  });

  // ── 任务遥测（2026-11-04 接线）：携带 taskId 的审计同步递增 tasks.tool_calls_used ──

  it('携带 taskId → tool_calls_used 按次递增（单条 UPDATE 语义，多行累计）', () => {
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-t', 'T', '/tmp', '@o')`)
      .run();
    insertTask({ id: 'T-8001', workspaceId: 'ws-t', title: '遥测递增', creatorUserId: '@o' });
    const before = (getDb().prepare('SELECT updated_at FROM tasks WHERE id = ?').get('T-8001') as { updated_at: number }).updated_at;

    for (let i = 0; i < 3; i++) {
      insertToolCall({
        workspaceId: 'ws-t', agentBotUserId: '@bot:a', toolName: 'write_file',
        inputSummary: '', outputSummary: '', success: true, durationMs: 1,
        taskId: 'T-8001',
      });
    }

    const row = getDb().prepare('SELECT tool_calls_used, updated_at FROM tasks WHERE id = ?').get('T-8001') as {
      tool_calls_used: number;
      updated_at: number;
    };
    expect(row.tool_calls_used).toBe(3);
    // 计数递增是行修改——updated_at 随之 bump（与 updateTask 语义一致）
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('taskId 为 null / 未知任务 id → 落库照常，不递增不抛错', () => {
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-t2', 'T', '/tmp', '@o')`)
      .run();

    // null：快速会话形态
    insertToolCall({
      workspaceId: 'ws-t2', agentBotUserId: '@bot:a', toolName: 'read_file',
      inputSummary: '', outputSummary: '', success: true, durationMs: 1,
    });
    // 未知任务 id：任务行不存在 → UPDATE 0 行 no-op（tool_calls.task_id 无外键约束）
    expect(() =>
      insertToolCall({
        workspaceId: 'ws-t2', agentBotUserId: '@bot:a', toolName: 'bash',
        inputSummary: '', outputSummary: '', success: true, durationMs: 1,
        taskId: 'T-不存在的任务',
      }),
    ).not.toThrow();

    expect(getToolCalls('ws-t2')).toHaveLength(2);
    const task = getDb().prepare('SELECT tool_calls_used FROM tasks WHERE id = ?').get('T-不存在的任务') as
      | { tool_calls_used: number }
      | undefined;
    expect(task).toBeUndefined();
  });
});
