// electron/tests/workspace/allocation.test.ts
//
// 验证 workspace 级能力分配 CRUD：
//   - getAllocation 空态返回空数组
//   - addAllocation 落库 + 按类型分桶
//   - addAllocation 重复添加幂等（INSERT OR IGNORE）
//   - removeAllocation 移除单条
//   - 不同 workspace 隔离
//
// workspace_allocations.workspace_id 外键引用 workspaces(id)，故测试前先插入一条
// workspace 记录满足约束。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getAllocation,
  addAllocation,
  removeAllocation,
} from '../../src/main/workspace/allocation';

const tmpRoot = path.join(os.tmpdir(), `ap-alloc-test-${Date.now()}`);

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

function seedWorkspace(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, '测试', '/tmp/test', '!space:localhost', '@alice:localhost');
}

describe('workspace/allocation', () => {
  it('getAllocation 空态返回空数组', () => {
    seedWorkspace('ws-1');
    const alloc = getAllocation('ws-1');
    expect(alloc).toEqual({ workspaceId: 'ws-1', tools: [], mcps: [], skills: [] });
  });

  it('addAllocation 按 type 分桶', () => {
    seedWorkspace('ws-1');
    addAllocation('ws-1', 'tool', 'read_file');
    addAllocation('ws-1', 'mcp', 'filesystem');
    addAllocation('ws-1', 'skill', 'code-review');
    const alloc = getAllocation('ws-1');
    expect(alloc.tools).toEqual(['read_file']);
    expect(alloc.mcps).toEqual(['filesystem']);
    expect(alloc.skills).toEqual(['code-review']);
  });

  it('addAllocation 重复添加幂等', () => {
    seedWorkspace('ws-1');
    addAllocation('ws-1', 'tool', 'read_file');
    addAllocation('ws-1', 'tool', 'read_file');
    const alloc = getAllocation('ws-1');
    expect(alloc.tools).toEqual(['read_file']);
  });

  it('removeAllocation 移除单条且不影响其他', () => {
    seedWorkspace('ws-1');
    addAllocation('ws-1', 'tool', 'read_file');
    addAllocation('ws-1', 'tool', 'write_file');
    removeAllocation('ws-1', 'tool', 'read_file');
    const alloc = getAllocation('ws-1');
    expect(alloc.tools).toEqual(['write_file']);
  });

  it('不同 workspace 隔离', () => {
    seedWorkspace('ws-1');
    seedWorkspace('ws-2');
    addAllocation('ws-1', 'mcp', 'github');
    addAllocation('ws-2', 'mcp', 'postgres');
    expect(getAllocation('ws-1').mcps).toEqual(['github']);
    expect(getAllocation('ws-2').mcps).toEqual(['postgres']);
  });
});
