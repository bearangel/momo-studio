// db 形态 tool_gate 答复旁路（spec 2026-11-17 §7-3）：
//   1) db payload + approve → 不产生任何会话写授权、不抛错、不打「畸形」warn（db 是已知形态）
//   2) 对照组：沙箱形态 payload + approve → 照旧授予（既有行为不受影响）
// harness 沿 tests/task/tool-gate-persistence.test.ts 形态（真库 + electron 假件）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import { handleToolGateAnswer } from '../../src/main/sandbox/write-blocked-emit';
import { insertHumanRequest } from '../../src/main/storage/tasks/human-requests-repo';
import { getGrantedDirs, __clearWriteGrantsForTest } from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { logger } from '../../src/main/logger';

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

const tmpRoot = path.join(os.tmpdir(), `dbgate-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

/** 种工作空间 + 会话行（human_requests.session_id 外键前提） */
function seedSession(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  ).run(sessionId, sessionId, `/ws/${sessionId}`, 'u-test');
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES (?, ?, 'db 旁路测试会话', 0, 'chat', 1, 1)`,
  ).run(sessionId, sessionId);
}

describe('handleToolGateAnswer db 载荷旁路', () => {
  it('db payload + approve：不产生写授权、不抛错、不打畸形 warn', () => {
    seedSession('sess-db');
    __clearWriteGrantsForTest();
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const row = insertHumanRequest({
      sessionId: 'sess-db',
      kind: 'tool_gate',
      title: '数据库写请求（DML）',
      payloadJson: JSON.stringify({ db: { connection: 'conn1', sql: 'UPDATE t SET a=1', opClass: 'DML' } }),
    });
    try {
      expect(() => handleToolGateAnswer(row.id, { decision: 'approve' })).not.toThrow();
      expect(getGrantedDirs('sess-db', null)).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('对照组：沙箱形态 payload + approve → 照旧授予', () => {
    seedSession('sess-fs');
    __clearWriteGrantsForTest();
    const row = insertHumanRequest({
      sessionId: 'sess-fs',
      kind: 'tool_gate',
      title: '写入请求',
      payloadJson: JSON.stringify({ toolGate: { command: 'echo hi', dirs: ['/tmp/x'] } }),
    });
    handleToolGateAnswer(row.id, { decision: 'approve' });
    expect(getGrantedDirs('sess-fs', null)).toContain('/tmp/x');
  });
});
