// electron/tests/storage/tasks-repo-board.test.ts
//
// tasks repo 看板三新列（group_id / board_position / archived_at）映射 + listTasks
// archived 三态 / groupId 过滤测试（看板重构 Task 2）。
// 测试覆盖（brief Step 1 用例原样）：
//   - insert 默认三新列为 NULL；显式传入 groupId / boardPosition 可落值
//   - updateTask 可 patch archivedAt / boardPosition（group_id 同列清单机械覆盖）
//   - listTasks archived 三态（exclude 默认 / only / all）+ groupId 精确过滤
//
// 测试隔离：对齐 tasks-repo.test.ts 既有 fixture——每个 case 独立 tmp 目录 +
// closeDb + AP_USER_DATA_DIR 重置，真实 SQLite 文件库 + 全量 migrations，禁 mock。
// tasks 表有 FK 到 workspaces(id)，故每个 case seed ws / wsf 工作空间。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, listTasks, updateTask, getTask } from '../../src/main/storage/tasks/repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-repo-board-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed 工作空间（tasks 表有 FK 到 workspaces；brief 用例用 ws / wsf 两个 id）
  const seed = getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  );
  for (const ws of ['ws', 'wsf']) {
    seed.run(ws, `WS-${ws}`, '/tmp', '@owner:home');
  }
  // seed 分组：迁移 047 对 tasks.group_id 建了 FK → task_groups(id)，brief 用例的
  // G-001 / G-009 需先存在才能插入；task_groups 自身无 FK，直插即可
  const now = Date.now();
  const seedGroup = getDb().prepare(
    `INSERT INTO task_groups (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  seedGroup.run('G-001', 'ws', 'seed-ws', 1024, now, now);
  seedGroup.run('G-009', 'wsf', 'seed-wsf', 1024, now, now);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** created_at 为毫秒时间戳，同毫秒插入的 ORDER BY created_at ASC 顺序不稳定——错开 2ms 保证确定性 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2));
}

describe('tasks 看板字段', () => {
  it('insert 默认三新列为 NULL;显式传入可落值', () => {
    const t = insertTask({ workspaceId: 'ws', title: 'a', creatorUserId: 'owner' });
    expect(t.groupId).toBeNull();
    expect(t.boardPosition).toBeNull();
    expect(t.archivedAt).toBeNull();
    const g = insertTask({ workspaceId: 'ws', title: 'b', creatorUserId: 'owner', groupId: 'G-001', boardPosition: 2048 });
    expect(g.groupId).toBe('G-001');
    expect(g.boardPosition).toBe(2048);
  });

  it('updateTask 可 patch 三新列', () => {
    const t = insertTask({ workspaceId: 'ws', title: 'c', creatorUserId: 'owner' });
    updateTask(t.id, { archivedAt: 123, boardPosition: 100 });
    expect(getTask(t.id)?.archivedAt).toBe(123);
    expect(getTask(t.id)?.boardPosition).toBe(100);
  });

  it('listTasks archived 三态 + groupId 过滤', async () => {
    const a = insertTask({ workspaceId: 'wsf', title: '活跃', creatorUserId: 'owner' });
    await tick();
    const b = insertTask({ workspaceId: 'wsf', title: '归档', creatorUserId: 'owner' });
    await tick();
    updateTask(b.id, { archivedAt: 999 });
    const c = insertTask({ workspaceId: 'wsf', title: '组内', creatorUserId: 'owner', groupId: 'G-009' });
    expect(listTasks({ workspaceId: 'wsf' }).map((x) => x.id)).toEqual([a.id, c.id]); // 默认 exclude
    expect(listTasks({ workspaceId: 'wsf', archived: 'only' }).map((x) => x.id)).toEqual([b.id]);
    expect(listTasks({ workspaceId: 'wsf', archived: 'all' })).toHaveLength(3);
    expect(listTasks({ workspaceId: 'wsf', groupId: 'G-009' }).map((x) => x.id)).toEqual([c.id]);
  });
});
