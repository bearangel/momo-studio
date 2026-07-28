// electron/tests/workspace/crud.test.ts
//
// 验证 workspace CRUD 的核心行为：
// - createWorkspace 同时落盘到文件系统 + git 仓库 + SQLite
// - list/get/delete 各自能查到 / 找不到 / 删除记录

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from '../../src/main/workspace/crud';
import { runMigrations, closeDb } from '../../src/main/storage/db';

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
      '!space:localhost',
      '!team:localhost',
    );
    expect(ws.name).toBe('测试项目');
    expect(ws.directoryPath).toBe(wsDir);
    expect(ws.teamRoomId).toBe('!team:localhost');
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.git'))).toBe(true);
    expect(ws.gitInitialized).toBe(true);
  });

  it('createWorkspace 不传 teamRoomId 时默认空字符串', async () => {
    const ws = await createWorkspace(
      { name: 'X', directoryPath: path.join(tmpRoot, 'no-team') },
      '@alice:localhost',
      '!space:localhost',
    );
    expect(ws.teamRoomId).toBe('');
  });

  it('listWorkspaces 返回所有 workspace', async () => {
    await createWorkspace({ name: 'A', directoryPath: path.join(tmpRoot, 'a') }, '@alice:localhost', '!s1:localhost');
    await createWorkspace({ name: 'B', directoryPath: path.join(tmpRoot, 'b') }, '@alice:localhost', '!s2:localhost');
    const list = listWorkspaces();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.name)).toContain('A');
    expect(list.map((w) => w.name)).toContain('B');
  });

  it('getWorkspace 按 id 查询', async () => {
    const ws = await createWorkspace({ name: 'X', directoryPath: path.join(tmpRoot, 'x') }, '@alice:localhost', '!s:localhost');
    const found = getWorkspace(ws.id);
    expect(found?.name).toBe('X');
    expect(getWorkspace('nonexistent')).toBeNull();
  });

  it('deleteWorkspace 删除记录', async () => {
    const ws = await createWorkspace({ name: 'Y', directoryPath: path.join(tmpRoot, 'y') }, '@alice:localhost', '!s:localhost');
    deleteWorkspace(ws.id);
    expect(getWorkspace(ws.id)).toBeNull();
  });
});
