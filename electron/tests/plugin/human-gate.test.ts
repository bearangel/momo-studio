// humanGate 注入体契约锁（spec 2026-11-17 §7-1）：
//   1) create：落 kind=tool_gate 行（sessionId/taskId/payload 透传、keep_waiting）
//   2) status：投影字段（含 payloadJson）| 未知 id → null
//   3) create 缺 sessionId → 拒（Review Focus #4 守卫）
// DB 初始化沿 tests/task/tool-gate-persistence.test.ts 形态（真库）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import { buildPluginHumanGateApi } from '../../src/main/plugin/human-gate';
import { listPendingBySession } from '../../src/main/storage/tasks/human-requests-repo';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const mockSend = vi.fn();

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
    ipcMain: { handle: vi.fn() },
  });
});
afterAll(() => {
  __setElectronApisForTest(null);
});

const tmpRoot = path.join(os.tmpdir(), `human-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

/** 种工作空间 + 会话行（human_requests.session_id 外键前提——沿 tool-gate-persistence 形态） */
function seedSession(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  ).run(sessionId, sessionId, `/ws/${sessionId}`, 'u-test');
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES (?, ?, 'human-gate 测试会话', 0, 'chat', 1, 1)`,
  ).run(sessionId, sessionId);
}

describe('buildPluginHumanGateApi', () => {
  it('create 落 kind=tool_gate 行 + payload 透传 + keep_waiting', async () => {
    seedSession('sess-1');
    const gate = buildPluginHumanGateApi();
    const payloadJson = JSON.stringify({ db: { connection: 'conn1', sql: 'UPDATE t SET a=1', opClass: 'DML' } });
    const id = await gate.create({ sessionId: 'sess-1', title: '数据库写请求（DML）', payloadJson });
    const rows = listPendingBySession('sess-1');
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('tool_gate');
    expect(row?.status).toBe('pending');
    expect(row?.taskId).toBeNull();
    expect(row?.timeoutPolicy).toBe('keep_waiting');
    expect(row?.payloadJson).toBe(payloadJson);
  });

  it('status 返回投影（含 payloadJson）；未知 id → null', async () => {
    seedSession('sess-2');
    const gate = buildPluginHumanGateApi();
    const payloadJson = '{"db":{"connection":"c","sql":"s","opClass":"DDL"}}';
    const id = await gate.create({ sessionId: 'sess-2', title: 't', payloadJson });
    const s = await gate.status(id);
    expect(s).toMatchObject({ id, status: 'pending', answerJson: null, payloadJson });
    expect(await gate.status('nonexistent')).toBeNull();
  });

  it('create 缺 sessionId 拒绝（防 NOT NULL 崩 + 面板断链）', async () => {
    const gate = buildPluginHumanGateApi();
    await expect(gate.create({ sessionId: '', title: 't' })).rejects.toThrow(/sessionId/);
  });
});
