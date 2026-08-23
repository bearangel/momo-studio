// electron/tests/workspace/crud.test.ts
//
// 验证 workspace CRUD 的核心行为：
// - createWorkspace 同时落盘到文件系统 + git 仓库 + SQLite
// - v2（Task 10）：createWorkspace 内部创建默认团队会话（sessions 表）并回填
//   workspaces.team_session_id——不再创建 Matrix room
// - list/get/delete 各自能查到 / 找不到 / 删除记录

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from '../../src/main/workspace/crud';
import { listSessionsByWorkspace } from '../../src/main/storage/sessions/repo';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-ws-test-${Date.now()}`);

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

describe('workspace/crud', () => {
  it('createWorkspace 创建目录 + git + SQLite 记录', async () => {
    const wsDir = path.join(tmpRoot, 'my-project');
    const ws = await createWorkspace(
      { name: '测试项目', directoryPath: wsDir },
      '@alice:localhost',
    );
    expect(ws.name).toBe('测试项目');
    expect(ws.directoryPath).toBe(wsDir);
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.git'))).toBe(true);
    expect(ws.gitInitialized).toBe(true);
  });

  it('createWorkspace 自动创建默认团队会话并回填 team_session_id', async () => {
    const ws = await createWorkspace(
      { name: '团队项目', directoryPath: path.join(tmpRoot, 'team-ws') },
      '@alice:localhost',
    );

    // 返回值携带团队会话 ID（非空——由本地 sessions 表生成，非 Matrix room ID）
    expect(ws.teamSessionId).not.toBe('');

    // sessions 表存在该会话行：title='团队会话'、kind='chat'、归属本 workspace
    const sessions = listSessionsByWorkspace(ws.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(ws.teamSessionId);
    expect(sessions[0]!.title).toBe('团队会话');
    expect(sessions[0]!.kind).toBe('chat');

    // DB 行的 team_session_id 与返回值一致（回填 UPDATE 生效）
    const row = getDb()
      .prepare('SELECT team_session_id FROM workspaces WHERE id = ?')
      .get(ws.id) as { team_session_id: string };
    expect(row.team_session_id).toBe(ws.teamSessionId);
  });

  it('listWorkspaces 返回所有 workspace', async () => {
    await createWorkspace({ name: 'A', directoryPath: path.join(tmpRoot, 'a') }, '@alice:localhost');
    await createWorkspace({ name: 'B', directoryPath: path.join(tmpRoot, 'b') }, '@alice:localhost');
    const list = listWorkspaces();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.name)).toContain('A');
    expect(list.map((w) => w.name)).toContain('B');
  });

  it('getWorkspace 按 id 查询', async () => {
    const ws = await createWorkspace({ name: 'X', directoryPath: path.join(tmpRoot, 'x') }, '@alice:localhost');
    const found = getWorkspace(ws.id);
    expect(found?.name).toBe('X');
    expect(getWorkspace('nonexistent')).toBeNull();
  });

  it('deleteWorkspace 删除记录', async () => {
    const ws = await createWorkspace({ name: 'Y', directoryPath: path.join(tmpRoot, 'y') }, '@alice:localhost');
    deleteWorkspace(ws.id);
    expect(getWorkspace(ws.id)).toBeNull();
  });
});
