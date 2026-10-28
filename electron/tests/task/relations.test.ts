// electron/tests/task/relations.test.ts
//
// M3.3 关系写路径矩阵（spec §2.1/§2.3）：insertTaskWithRelations（创建路径）
// 与 setTaskRelations（task:setRelations 单点）+ blocked 派生读链。
// 直接测 task/relations.ts（不 mock electron——本文件不触 IPC 层；
// 通道接线在 relations-ipc.test.ts）。
//
// 锁什么：
//   - 创建：parentTaskId/dependsOn 存在性人话拒、同事务原子（坏依赖零残留）、
//     正常链落行落边、无关系路径行为等价
//   - setRelations：全量替换 / 环拒绝（含环路径）/ parent 存在性 + 自身 / null 清除 /
//     字段可选各自更新 / 幂等空更新
//   - 派生：getTask/listTasks blocked+blockedBy；依赖 completed 后消失（解锁）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  getTask,
  transitionTaskStatus,
  listTasks,
} from '../../src/main/storage/tasks/repo';
import {
  insertTaskWithRelations,
  setTaskRelations,
} from '../../src/main/task/relations';
import { listDependencyEdges } from '../../src/main/storage/tasks/dependencies-repo';

const WS = 'wsr';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-relations-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const mk = (title: string) => insertTask({ workspaceId: WS, title, creatorUserId: 'owner' });

/** assigned → in_progress → completed 生产合法链（momo-test-rules 第 1 条） */
function complete(id: string): void {
  transitionTaskStatus(id, 'assigned');
  transitionTaskStatus(id, 'in_progress', { executionSessionId: 's-1' });
  transitionTaskStatus(id, 'completed', { completedAt: Date.now() });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(WS, 'Test', '/tmp', 'owner');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('insertTaskWithRelations —— 创建路径', () => {
  it('无关系：行为等价原 insertTask（draft 落库、无边、parentTaskId NULL）', () => {
    const row = insertTaskWithRelations(
      { workspaceId: WS, title: '普通', creatorUserId: 'owner' },
      {},
    );
    expect(row.status).toBe('draft');
    expect(row.parentTaskId).toBeNull();
    expect(listDependencyEdges()).toEqual([]);
  });

  it('正常链：parentTaskId + dependsOn 同事务落行落边', () => {
    const a = mk('A');
    const b = mk('B');
    const row = insertTaskWithRelations(
      { workspaceId: WS, title: 'C', creatorUserId: 'owner' },
      { parentTaskId: a.id, dependsOn: [a.id, b.id] },
    );
    expect(row.parentTaskId).toBe(a.id);
    expect(listDependencyEdges()).toEqual(
      expect.arrayContaining([
        { from: row.id, to: a.id },
        { from: row.id, to: b.id },
      ]),
    );
    expect(listDependencyEdges()).toHaveLength(2);
  });

  it('依赖不存在 → 人话拒绝，任务行零残留（同事务原子）', () => {
    const a = mk('A');
    expect(() =>
      insertTaskWithRelations(
        { workspaceId: WS, title: '坏', creatorUserId: 'owner' },
        { dependsOn: [a.id, 'T-999'] },
      ),
    ).toThrow('依赖任务 T-999 不存在');
    // 原子性：事务回滚后无半套写（任务行不落、已验过的边不插）
    const rows = listTasks({ workspaceId: WS });
    expect(rows.map((r) => r.title)).toEqual(['A']);
    expect(listDependencyEdges()).toEqual([]);
  });

  it('父任务不存在 → 人话拒绝，零残留', () => {
    expect(() =>
      insertTaskWithRelations(
        { workspaceId: WS, title: '坏', creatorUserId: 'owner' },
        { parentTaskId: 'T-999' },
      ),
    ).toThrow('父任务 T-999 不存在');
    expect(listTasks({ workspaceId: WS })).toHaveLength(0);
  });

  it('dependsOn 重复项去重（幂等边集）', () => {
    const a = mk('A');
    const row = insertTaskWithRelations(
      { workspaceId: WS, title: 'D', creatorUserId: 'owner' },
      { dependsOn: [a.id, a.id] },
    );
    expect(listDependencyEdges()).toEqual([{ from: row.id, to: a.id }]);
  });

  it('创建即带依赖 → 行内 blocked 派生立即生效（getTask 读链）', () => {
    const a = mk('A');
    const row = insertTaskWithRelations(
      { workspaceId: WS, title: 'B', creatorUserId: 'owner' },
      { dependsOn: [a.id] },
    );
    const got = getTask(row.id)!;
    expect(got.blocked).toBe(true);
    expect(got.blockedBy).toEqual([a.id]);
  });
});

describe('setTaskRelations —— task:setRelations 单点', () => {
  it('dependsOn 全量替换：旧边清空，新边即最终态', () => {
    const a = mk('A');
    const b = mk('B');
    const c = mk('C');
    const t = insertTaskWithRelations(
      { workspaceId: WS, title: 'T', creatorUserId: 'owner' },
      { dependsOn: [a.id] },
    );
    const row = setTaskRelations({ taskId: t.id, dependsOn: [b.id, c.id] });
    expect(listDependencyEdges()).toEqual([
      { from: t.id, to: b.id },
      { from: t.id, to: c.id },
    ]);
    expect(row.blocked).toBe(true);
    expect(row.blockedBy).toEqual([b.id, c.id]);
  });

  it('dependsOn 替换为空数组 = 清空全部依赖（解锁）', () => {
    const a = mk('A');
    const t = insertTaskWithRelations(
      { workspaceId: WS, title: 'T', creatorUserId: 'owner' },
      { dependsOn: [a.id] },
    );
    const row = setTaskRelations({ taskId: t.id, dependsOn: [] });
    expect(listDependencyEdges()).toEqual([]);
    expect(row.blocked).toBe(false);
    expect(row.blockedBy).toEqual([]);
  });

  it('两点环拒绝：A 依赖 B 后 B 依赖 A → 报错含环路径，边零写入', () => {
    const a = mk('A');
    const b = mk('B');
    setTaskRelations({ taskId: b.id, dependsOn: [a.id] });
    // 环路径起点随 DFS 遍历序（A 起或 B 起皆合法成环）——锁「闭合双点环」不锁根
    expect(() => setTaskRelations({ taskId: a.id, dependsOn: [b.id] })).toThrow(
      new RegExp(`存在依赖环：(${a.id} → ${b.id} → ${a.id}|${b.id} → ${a.id} → ${b.id})`),
    );
    // 拒绝时零副作用：A 的依赖边未写入
    expect(listDependencyEdges()).toEqual([{ from: b.id, to: a.id }]);
  });

  it('三点环拒绝：A→B→C 链上补 C→A', () => {
    const a = mk('A');
    const b = mk('B');
    const c = mk('C');
    setTaskRelations({ taskId: b.id, dependsOn: [a.id] });
    setTaskRelations({ taskId: c.id, dependsOn: [b.id] });
    expect(() => setTaskRelations({ taskId: a.id, dependsOn: [c.id] })).toThrow('存在依赖环');
  });

  it('跨 parent 链环拒绝：A 依赖 B + B.parent=A → C 依赖链回环场景（矩阵第 4 项）', () => {
    const a = mk('A');
    const b = mk('B');
    // A 依赖 B；再把 A 挂为 B 的父任务 → 合并图 A→B(dep) + B→A(parent) = 两点交叉环
    setTaskRelations({ taskId: a.id, dependsOn: [b.id] });
    expect(() => setTaskRelations({ taskId: b.id, parentTaskId: a.id })).toThrow('存在依赖环');
    expect(getTask(b.id)!.parentTaskId).toBeNull(); // 拒绝零写入
  });

  it('parent 存在性 / 自身 / null 清除 / 链上挂孙合法', () => {
    const a = mk('A');
    const b = mk('B');
    const c = mk('C');
    expect(() => setTaskRelations({ taskId: a.id, parentTaskId: 'T-999' })).toThrow(
      '父任务 T-999 不存在',
    );
    expect(() => setTaskRelations({ taskId: a.id, parentTaskId: a.id })).toThrow(
      '父任务不能是任务自身',
    );
    // 合法链：B 挂 A 下、C 挂 B 下（层级链无环放行）
    expect(setTaskRelations({ taskId: b.id, parentTaskId: a.id }).parentTaskId).toBe(a.id);
    expect(setTaskRelations({ taskId: c.id, parentTaskId: b.id }).parentTaskId).toBe(b.id);
    // 纯父链环拒绝：A 再挂 C 下 → A→C→B→A
    expect(() => setTaskRelations({ taskId: a.id, parentTaskId: c.id })).toThrow('存在依赖环');
    // null 清除父任务
    expect(setTaskRelations({ taskId: b.id, parentTaskId: null }).parentTaskId).toBeNull();
  });

  it('parent 与 dependsOn 同时更新（字段可选各自生效）；同事务原子', () => {
    const a = mk('A');
    const b = mk('B');
    const t = mk('T');
    const row = setTaskRelations({ taskId: t.id, parentTaskId: a.id, dependsOn: [b.id] });
    expect(row.parentTaskId).toBe(a.id);
    expect(listDependencyEdges()).toEqual([{ from: t.id, to: b.id }]);
    // 只动 parent 不动 deps：依赖边保持
    setTaskRelations({ taskId: t.id, parentTaskId: b.id });
    expect(getTask(t.id)!.parentTaskId).toBe(b.id);
    expect(listDependencyEdges()).toEqual([{ from: t.id, to: b.id }]);
  });

  it('依赖自身 → 人话拒绝（不落库不靠 SQL CHECK 兜底）', () => {
    const a = mk('A');
    expect(() => setTaskRelations({ taskId: a.id, dependsOn: [a.id] })).toThrow(
      '任务不能依赖自身',
    );
    expect(listDependencyEdges()).toEqual([]);
  });

  it('两字段都未携带 → 幂等返回当前行，零写入（updated_at 不动）', async () => {
    const a = mk('A');
    const before = getTask(a.id)!;
    await new Promise((r) => setTimeout(r, 2)); // 隔开时间戳粒度
    const row = setTaskRelations({ taskId: a.id });
    expect(row.updatedAt).toBe(before.updatedAt);
  });

  it('任务不存在 → 人话拒绝', () => {
    expect(() => setTaskRelations({ taskId: 'T-404', dependsOn: [] })).toThrow(
      '任务 T-404 不存在',
    );
  });
});

describe('blocked 派生读链（getTask / listTasks）', () => {
  it('listTasks 聚合输出 blocked/blockedBy；依赖 completed 后消失', () => {
    const a = mk('A');
    const b = insertTaskWithRelations(
      { workspaceId: WS, title: 'B', creatorUserId: 'owner' },
      { dependsOn: [a.id] },
    );
    const c = mk('C');
    let rows = listTasks({ workspaceId: WS });
    const bRow = rows.find((r) => r.id === b.id)!;
    expect(bRow.blocked).toBe(true);
    expect(bRow.blockedBy).toEqual([a.id]);
    expect(rows.find((r) => r.id === a.id)!.blocked).toBe(false);
    expect(rows.find((r) => r.id === c.id)!.blocked).toBe(false);

    // A 完成 → B 解锁（依赖完成联动：badge 消失，拉取式不自动启动）
    complete(a.id);
    rows = listTasks({ workspaceId: WS });
    expect(rows.find((r) => r.id === b.id)!.blocked).toBe(false);
    expect(rows.find((r) => r.id === b.id)!.blockedBy).toEqual([]);
  });

  it('混合依赖：一完成一未完成 → 仍 blocked，blockedBy 只列未完成项', () => {
    const a = mk('A');
    const b = mk('B');
    const t = insertTaskWithRelations(
      { workspaceId: WS, title: 'T', creatorUserId: 'owner' },
      { dependsOn: [a.id, b.id] },
    );
    complete(a.id);
    const row = getTask(t.id)!;
    expect(row.blocked).toBe(true);
    expect(row.blockedBy).toEqual([b.id]);
  });

  it('父任务不参与 blocked 派生（层级是组织关系非闸门）', () => {
    const a = mk('A');
    const b = insertTaskWithRelations(
      { workspaceId: WS, title: 'B', creatorUserId: 'owner' },
      { parentTaskId: a.id },
    );
    const row = getTask(b.id)!;
    expect(row.blocked).toBe(false);
    expect(row.blockedBy).toEqual([]);
  });
});
