// electron/tests/storage/task-groups-repo.test.ts
//
// task_groups repo CRUD + 三态过滤 + 归档级联事务测试（看板重构 Task 1）。
// 测试覆盖：
//   - createGroup（默认活跃 / position 按 workspace 自增 / 语义色可选）
//   - listGroups（exclude / only / all 三态归档过滤）
//   - archiveGroup（非终态任务级联 cancel + 全组 archived + 组置归档，单事务）
//   - unarchiveGroup（只复活组，任务保持归档）
//   - reorderGroups（按入参顺序重写 position）
//   - updateGroup（改名 / 换色 + bump updated_at）
//
// 测试隔离：对齐 tasks-repo.test.ts 既有 fixture——每个 case 独立 tmp 目录 +
// closeDb + AP_USER_DATA_DIR 重置，真实 SQLite 文件库 + 全量 migrations，禁 mock。
// tasks 表有 FK 到 workspaces(id)，故每个 case seed ws1–ws5 工作空间。
//
// Task 2 过渡说明（任务裁决）：级联/归档两用例依赖 Task 2 的 tasks repo 字段映射
// （insertTask.groupId / listTasks.archived / TaskRow.archivedAt）。本文件以「直查
// SQL」薄封装透传（语义与 Task 2 完成后一致），类型零违例；Task 2 收尾后删除
// 「Task 2 过渡 shim」区块并恢复对真实签名的直连断言。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  createGroup,
  listGroups,
  archiveGroup,
  unarchiveGroup,
  reorderGroups,
  updateGroup,
} from '../../src/main/storage/task-groups/repo';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';

// ─── Task 2 过渡 shim（见文件头说明）────────────────────────────────────────

/** Task 2 将把 groupId 纳入 insertTask 映射；此前经直查 UPDATE 落 group_id。 */
function insertTaskInGroup(
  input: Parameters<typeof insertTask>[0] & { groupId?: string },
) {
  const { groupId, ...rest } = input;
  const row = insertTask(rest);
  if (groupId != null) {
    getDb().prepare('UPDATE tasks SET group_id = ? WHERE id = ?').run(groupId, row.id);
  }
  return row;
}

/** Task 2 将把 archivedAt 纳入 TaskRow；此前经直查询列。 */
function getTaskArchivedAt(id: string): number | null {
  const row = getDb().prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as {
    archived_at: number | null;
  };
  return row.archived_at;
}

/** Task 2 将由 listTasks({ archived: 'only' }) 承担；此前直查计数。 */
function countArchivedTasks(workspaceId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND archived_at IS NOT NULL')
    .get(workspaceId) as { c: number };
  return row.c;
}

// ─── fixture（对齐 tasks-repo.test.ts 顶部）─────────────────────────────────

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-group-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed 工作空间（tasks 表有 FK 到 workspaces；task_groups 本身无 FK，统一 seed 便于对齐）
  const seed = getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  );
  for (const ws of ['ws1', 'ws2', 'ws3', 'ws4', 'ws5']) {
    seed.run(ws, `WS-${ws}`, '/tmp', '@owner:home');
  }
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task_groups repo', () => {
  it('创建组默认活跃，position 自增', () => {
    const g1 = createGroup({ workspaceId: 'ws1', name: 'v2.1.0' });
    const g2 = createGroup({ workspaceId: 'ws1', name: 'LSP', color: 'violet' });
    expect(g1.archivedAt).toBeNull();
    expect(g2.color).toBe('violet');
    expect(g2.position).toBeGreaterThan(g1.position);
  });

  it('listGroups 三态过滤：exclude/only/all', () => {
    // 未归档组留下（brief 断言 all=2 需要一活一归两组）
    const keep = createGroup({ workspaceId: 'ws2', name: 'keep' });
    const g = createGroup({ workspaceId: 'ws2', name: 'tmp' });
    archiveGroup(g.id);
    expect(listGroups('ws2').map((x) => x.id)).toEqual([keep.id]);
    expect(listGroups('ws2').map((x) => x.id)).not.toContain(g.id);
    expect(listGroups('ws2', { archived: 'only' }).map((x) => x.id)).toEqual([g.id]);
    expect(listGroups('ws2', { archived: 'all' })).toHaveLength(2);
  });

  it('归档组：非终态任务级联 cancel + 全组 archived，事务原子', () => {
    const g = createGroup({ workspaceId: 'ws3', name: 'ver' });
    const running = insertTaskInGroup({
      workspaceId: 'ws3', title: '跑着', creatorUserId: 'owner', status: 'in_progress', groupId: g.id,
    });
    const done = insertTaskInGroup({
      workspaceId: 'ws3', title: '完了', creatorUserId: 'owner', status: 'completed', groupId: g.id,
    });
    const res = archiveGroup(g.id);
    expect(res.cancelledIds).toEqual([running.id]);
    expect(res.archivedCount).toBe(2);
    expect(getTask(running.id)?.status).toBe('cancelled');
    expect(getTaskArchivedAt(running.id)).not.toBeNull();
    expect(getTaskArchivedAt(done.id)).not.toBeNull();
    // 默认 listTasks 不见归档——Task 2 的 archived 默认 exclude 过滤收口（当前红）
    expect(listTasks({ workspaceId: 'ws3' })).toHaveLength(0);
  });

  it('unarchive 组只复活组，任务保持归档', () => {
    // 自含前置（per-case 隔离 fixture 下不依赖其他用例的 ws3 状态）
    const g = createGroup({ workspaceId: 'ws3', name: 'ver' });
    insertTaskInGroup({
      workspaceId: 'ws3', title: '跑着', creatorUserId: 'owner', status: 'in_progress', groupId: g.id,
    });
    insertTaskInGroup({
      workspaceId: 'ws3', title: '完了', creatorUserId: 'owner', status: 'completed', groupId: g.id,
    });
    archiveGroup(g.id);
    const [archived] = listGroups('ws3', { archived: 'only' });
    if (!archived) throw new Error('归档组未找到——only 过滤失效');
    unarchiveGroup(archived.id);
    expect(listGroups('ws3').map((x) => x.id)).toContain(archived.id);
    // 任务保持归档——Task 2 后换 listTasks({ workspaceId: 'ws3', archived: 'only' })
    expect(countArchivedTasks('ws3')).toBe(2);
  });

  it('reorder 按入参顺序重写 position', () => {
    const a = createGroup({ workspaceId: 'ws4', name: 'a' });
    const b = createGroup({ workspaceId: 'ws4', name: 'b' });
    reorderGroups([b.id, a.id]);
    const list = listGroups('ws4');
    if (!list[0] || !list[1]) throw new Error('ws4 组数量不足两条——listGroups 丢行');
    expect(list[0].id).toBe(b.id);
    expect(list[0].position).toBeLessThan(list[1].position);
  });

  it('updateGroup 改名/换色并 bump updated_at', () => {
    const g = createGroup({ workspaceId: 'ws5', name: 'x' });
    const before = g.updatedAt;
    const next = updateGroup(g.id, { name: 'y', color: 'accent' });
    expect(next.name).toBe('y');
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
  });
});
