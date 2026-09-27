// electron/tests/storage/task-groups-repo.test.ts
//
// task_groups repo CRUD + 三态过滤 + 归档级联事务测试（看板重构 Task 1）。
// 测试覆盖：
//   - createGroup（默认活跃 / position 按 workspace 自增 / 语义色可选）
//   - listGroups（exclude / only / all 三态归档过滤）
//   - archiveGroup（非终态任务级联 cancel + 全组 archived + 组置归档，单事务）
//   - unarchiveGroup（组与组内全部归档任务一并恢复；他组/未分组不受影响）
//   - reorderGroups（按入参顺序重写 position）
//   - updateGroup（改名 / 换色 + bump updated_at）
//
// 测试隔离：对齐 tasks-repo.test.ts 既有 fixture——每个 case 独立 tmp 目录 +
// closeDb + AP_USER_DATA_DIR 重置，真实 SQLite 文件库 + 全量 migrations，禁 mock。
// tasks 表有 FK 到 workspaces(id)，故每个 case seed ws1–ws5 工作空间。
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
import { insertTask, getTask, listTasks, updateTask } from '../../src/main/storage/tasks/repo';

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
    // G-<seq> 零填充 ≥3 位——#G mention 解析与下游任务的 id 契约（先例：tasks-repo.test.ts 的 T-\d{3,}）
    expect(g1.id).toMatch(/^G-\d{3,}$/);
    expect(g1.id).not.toBe(g2.id);
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
    const running = insertTask({
      workspaceId: 'ws3', title: '跑着', creatorUserId: 'owner', status: 'in_progress', groupId: g.id,
    });
    const done = insertTask({
      workspaceId: 'ws3', title: '完了', creatorUserId: 'owner', status: 'completed', groupId: g.id,
    });
    const res = archiveGroup(g.id);
    expect(res.cancelledIds).toEqual([running.id]);
    expect(res.archivedCount).toBe(2);
    expect(getTask(running.id)?.status).toBe('cancelled');
    expect(getTask(running.id)?.archivedAt).not.toBeNull();
    expect(getTask(done.id)?.archivedAt).not.toBeNull();
    // 默认 listTasks 不见归档——archived 默认 exclude 过滤
    expect(listTasks({ workspaceId: 'ws3' })).toHaveLength(0);
  });

  it('unarchive 组后组内归档任务一并恢复（archived_at 清空）', () => {
    // 自含前置（per-case 隔离 fixture 下不依赖其他用例的 ws3 状态）
    const g = createGroup({ workspaceId: 'ws3', name: 'ver' });
    const running = insertTask({
      workspaceId: 'ws3', title: '跑着', creatorUserId: 'owner', status: 'in_progress', groupId: g.id,
    });
    const done = insertTask({
      workspaceId: 'ws3', title: '完了', creatorUserId: 'owner', status: 'completed', groupId: g.id,
    });
    archiveGroup(g.id);
    const [archived] = listGroups('ws3', { archived: 'only' });
    if (!archived) throw new Error('归档组未找到——only 过滤失效');
    unarchiveGroup(archived.id);
    expect(listGroups('ws3').map((x) => x.id)).toContain(archived.id);
    // 组与任务同进退：默认 listTasks（exclude）重新可见，archived_at 已清空
    expect(listTasks({ workspaceId: 'ws3' }).map((t) => t.id).sort()).toEqual(
      [running.id, done.id].sort(),
    );
    expect(getTask(running.id)?.archivedAt).toBeNull();
    expect(getTask(done.id)?.archivedAt).toBeNull();
    expect(listTasks({ workspaceId: 'ws3', archived: 'only' })).toHaveLength(0);
  });

  it('unarchive 组不影响他组与未分组的归档任务', () => {
    const mine = createGroup({ workspaceId: 'ws3', name: 'mine' });
    const other = createGroup({ workspaceId: 'ws3', name: 'other' });
    const tMine = insertTask({
      workspaceId: 'ws3', title: '本组', creatorUserId: 'owner', status: 'completed', groupId: mine.id,
    });
    const tOther = insertTask({
      workspaceId: 'ws3', title: '他组', creatorUserId: 'owner', status: 'completed', groupId: other.id,
    });
    const tFloating = insertTask({
      workspaceId: 'ws3', title: '未分组', creatorUserId: 'owner', status: 'completed',
    });
    archiveGroup(mine.id);
    archiveGroup(other.id);
    updateTask(tFloating.id, { archivedAt: Date.now() }); // 未分组归档行（task.archive 同款落点）
    unarchiveGroup(mine.id);
    // 本组任务回归；他组/未分组保持归档
    expect(getTask(tMine.id)?.archivedAt).toBeNull();
    expect(getTask(tOther.id)?.archivedAt).not.toBeNull();
    expect(getTask(tFloating.id)?.archivedAt).not.toBeNull();
    expect(listTasks({ workspaceId: 'ws3' }).map((t) => t.id)).toEqual([tMine.id]);
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

  it('错误路径：操作不存在的组抛错；空 reorder 是 no-op', () => {
    expect(() => updateGroup('G-999', { name: 'z' })).toThrow(/G-999 不存在/);
    expect(() => archiveGroup('G-999')).toThrow(/G-999 不存在/);
    expect(() => unarchiveGroup('G-999')).toThrow(/G-999 不存在/);
    expect(() => reorderGroups([])).not.toThrow();
  });
});
