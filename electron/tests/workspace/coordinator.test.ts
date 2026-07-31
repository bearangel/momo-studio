// workspace 协调 agent 设置单测
//
// 注意：brief 原始测试缺 directoryPath（CreateWorkspaceInput 必填字段）且未 await
// createWorkspace（该函数返回 Promise<Workspace>）。本文件按实际签名调整：
// 补 directoryPath（指向 tmp 子目录）+ async/await，与 crud.test.ts 模式对齐。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { createWorkspace, getWorkspace, setWorkspaceCoordinator } from '../../src/main/workspace/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-coord-test-${Date.now()}`);

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

describe('workspace coordinator', () => {
  it('getWorkspace 返回 coordinatorInstanceId（初始 null）', async () => {
    const ws = await createWorkspace(
      { name: 'w', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'w1') },
      '@owner:localhost',
      '!space:localhost',
      '!team:localhost',
    );
    expect(getWorkspace(ws.id)?.coordinatorInstanceId).toBeNull();
  });

  it('setWorkspaceCoordinator 写入并持久化', async () => {
    const ws = await createWorkspace(
      { name: 'w', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'w2') },
      '@owner:localhost',
      '!space:localhost',
      '!team:localhost',
    );
    setWorkspaceCoordinator(ws.id, 'inst-123');
    expect(getWorkspace(ws.id)?.coordinatorInstanceId).toBe('inst-123');
  });

  it('setWorkspaceCoordinator 传 null 清空', async () => {
    const ws = await createWorkspace(
      { name: 'w', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'w3') },
      '@owner:localhost',
      '!space:localhost',
      '!team:localhost',
    );
    setWorkspaceCoordinator(ws.id, 'inst-123');
    setWorkspaceCoordinator(ws.id, null);
    expect(getWorkspace(ws.id)?.coordinatorInstanceId).toBeNull();
  });
});
