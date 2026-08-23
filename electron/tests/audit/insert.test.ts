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
});
