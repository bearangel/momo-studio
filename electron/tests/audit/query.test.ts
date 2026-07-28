// electron/tests/audit/query.test.ts
//
// 验证审计日志分页查询：
//   - 倒序（最新优先）
//   - limit/offset 分页正确
//   - 按 agent / 工具名筛选
//   - 不同 workspace 隔离
//   - success INTEGER → boolean 转换

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getToolCalls } from '../../src/main/audit/query';

const tmpRoot = path.join(os.tmpdir(), `ap-audit-test-${Date.now()}`);

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

/** 插入一条审计记录，timestamp 用显式值以便断言倒序。 */
function insert(
  id: string,
  workspaceId: string,
  agent: string,
  tool: string,
  success: boolean,
  ts: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO tool_calls
         (id, workspace_id, agent_bot_user_id, task_id, tool_name, input_summary, output_summary, success, duration_ms, timestamp)
       VALUES (?, ?, ?, NULL, ?, '', '', ?, 10, ?)`,
    )
    .run(id, workspaceId, agent, tool, success ? 1 : 0, ts);
}

describe('audit/query', () => {
  it('默认按 timestamp 倒序返回全部', () => {
    insert('1', 'ws-1', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    insert('2', 'ws-1', '@bot:a', 'write_file', true, '2026-01-02 10:00:00');
    const rows = getToolCalls('ws-1');
    expect(rows.map((r) => r.id)).toEqual(['2', '1']);
  });

  it('limit/offset 分页', () => {
    for (let i = 0; i < 5; i++) {
      insert(`r${i}`, 'ws-1', '@bot:a', 't', true, `2026-01-0${i + 1} 10:00:00`);
    }
    const page1 = getToolCalls('ws-1', { limit: 2, offset: 0 });
    const page2 = getToolCalls('ws-1', { limit: 2, offset: 2 });
    expect(page1.map((r) => r.id)).toEqual(['r4', 'r3']);
    expect(page2.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('按 agent 筛选', () => {
    insert('1', 'ws-1', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    insert('2', 'ws-1', '@bot:b', 'read_file', true, '2026-01-02 10:00:00');
    const rows = getToolCalls('ws-1', { agentBotUserId: '@bot:b' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentBotUserId).toBe('@bot:b');
  });

  it('按工具名筛选', () => {
    insert('1', 'ws-1', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    insert('2', 'ws-1', '@bot:a', 'write_file', true, '2026-01-02 10:00:00');
    const rows = getToolCalls('ws-1', { toolName: 'write_file' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toolName).toBe('write_file');
  });

  it('不同 workspace 隔离', () => {
    insert('1', 'ws-1', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    insert('2', 'ws-2', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    expect(getToolCalls('ws-1')).toHaveLength(1);
    expect(getToolCalls('ws-2')).toHaveLength(1);
    expect(getToolCalls('ws-1')[0]!.workspaceId).toBe('ws-1');
  });

  it('success INTEGER → boolean 转换', () => {
    insert('1', 'ws-1', '@bot:a', 'read_file', true, '2026-01-01 10:00:00');
    insert('2', 'ws-1', '@bot:a', 'write_file', false, '2026-01-02 10:00:00');
    const rows = getToolCalls('ws-1');
    expect(rows[1]!.success).toBe(true);
    expect(rows[0]!.success).toBe(false);
  });
});
