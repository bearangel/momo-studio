// electron/tests/workspace/crud.test.ts
//
// 验证 workspace CRUD 的核心行为：
// - createWorkspace 同时落盘到文件系统 + git 仓库 + SQLite
// - v25（spec §4.4）：创建即建「团队会话」的行为退役——会话只由快速/协作
//   入口创建，createWorkspace 后 sessions 表为空
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

  it('createWorkspace 不自动创建任何会话（v25：团队会话概念退役，回归锁）', async () => {
    const ws = await createWorkspace(
      { name: '团队项目', directoryPath: path.join(tmpRoot, 'team-ws') },
      '@alice:localhost',
    );

    // 会话只能由快速/协作入口创建（spec §4.4）——建 ws 零会话残留
    expect(listSessionsByWorkspace(ws.id)).toHaveLength(0);
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
