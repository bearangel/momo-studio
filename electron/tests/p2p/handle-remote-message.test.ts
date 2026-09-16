// electron/tests/p2p/handle-remote-message.test.ts
//
// handleRemoteMessage 真 DB 落库契约锁（v2.11 审查 Important 补全）：
//   - 入站 SyncMessage.contextJson: string → messages.context_json 存原串
//   - 入站 SyncMessage.contextJson 缺失（undefined） → messages.context_json 存 null
//                              （向后兼容旧节点载荷）
//
// 隔离策略：
//   - DB：AP_USER_DATA_DIR 临时目录 + runMigrations + closeDb
//   - electron 模块 mock（BrowserWindow.getAllWindows 返回带 webContents.send 的 fake）——
//     仅隔离渲染推送，不影响 insertMessage 真路径
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockWebContentsSend } = vi.hoisted(() => ({
  mockWebContentsSend: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mockWebContentsSend },
      },
    ],
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { handleRemoteMessage } from '../../src/main/p2p/index';
import type { SyncMessage } from '../../src/main/p2p/sync';

const tmpRoot = path.join(os.tmpdir(), `ap-handle-remote-message-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  mockWebContentsSend.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedQuickSession(): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁', null);
  const s = insertSession({ workspaceId: 'ws1', title: '会话', titleAuto: true });
  return s.id;
}

function lastInsertedMessageRow(): { context_json: string | null; sender: string; source: string } | null {
  const row = getDb()
    .prepare('SELECT context_json, sender, source FROM messages ORDER BY created_at DESC LIMIT 1')
    .get() as { context_json: string | null; sender: string; source: string } | undefined;
  return row ?? null;
}

describe('handleRemoteMessage 真 DB 落库（v2.11 上下文透传契约）', () => {
  it('contextJson:string → messages.context_json 落库原串', () => {
    const sessionId = seedQuickSession();
    const ctxJson = '{"skills":[{"slug":"s","name":"n"}],"files":[]}';

    const msg: SyncMessage = {
      roomId: sessionId,
      sender: 'remote:node_p:@p:home',
      body: 'hi',
      eventType: 'm.room.message',
      contextJson: ctxJson,
    };
    handleRemoteMessage(msg);

    const row = lastInsertedMessageRow();
    expect(row).not.toBeNull();
    expect(row!.context_json).toBe(ctxJson);
    expect(row!.source).toBe('lan');
    expect(row!.sender).toBe('remote:node_p:@p:home');
  });

  it('contextJson 缺失（undefined，旧节点载荷） → messages.context_json 落库 null', () => {
    const sessionId = seedQuickSession();

    const msg: SyncMessage = {
      roomId: sessionId,
      sender: 'remote:node_old:@p:home',
      body: 'legacy',
      eventType: 'm.room.message',
      // contextJson 故意不传（mock SyncMessage 可选字段）—— P2 兼容旧节点载荷
    };
    handleRemoteMessage(msg);

    const row = lastInsertedMessageRow();
    expect(row).not.toBeNull();
    expect(row!.context_json).toBeNull();
    expect(row!.source).toBe('lan');
  });

  it('contextJson:null（对端显式 null） → messages.context_json 落库 null', () => {
    const sessionId = seedQuickSession();

    const msg: SyncMessage = {
      roomId: sessionId,
      sender: 'remote:node_p:@p:home',
      body: 'hi',
      eventType: 'm.room.message',
      contextJson: null,
    };
    handleRemoteMessage(msg);

    const row = lastInsertedMessageRow();
    expect(row!.context_json).toBeNull();
  });
});