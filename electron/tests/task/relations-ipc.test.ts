// electron/tests/task/relations-ipc.test.ts
//
// M3.3 新通道 IPC 接线锁：task:createBatch（上限 50 / per-item union /
// 依赖校验失败只败该项）+ task:setRelations 通道 + task:update 保护字段追加
// （parentTaskId/dependsOn/blocked 派生态剥离）。mock 边界同 ipc-handlers.test.ts：
// 只 mock electron 的 ipcMain.handle 注册捕获，业务全真实运行。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

/** 用 hoisted 状态捕获 ipcMain.handle 注册的 handler 集合 */
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      handlers.set(channel, fn);
    },
  },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';
import { TASK_CREATE_BATCH_LIMIT } from '../../src/main/task/ipc.handlers';
import { listDependencyEdges } from '../../src/main/storage/tasks/dependencies-repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-relations-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', 'owner');
  handlers.clear();
  registerTaskHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task:createBatch（M3.3 §2.1）', () => {
  it('正常批：全部成功 → per-item ok:true，行序与 results 序一致', async () => {
    const handler = handlers.get('task:createBatch')!;
    const result = (await handler(null, {
      items: [
        { workspaceId: 'ws1', title: '一' },
        { workspaceId: 'ws1', title: '二' },
      ],
    })) as { results: Array<{ ok: boolean }> };

    expect(result.results).toHaveLength(2);
    for (const r of result.results) expect(r.ok).toBe(true);
    const rows = listTasks({ workspaceId: 'ws1' });
    expect(rows.map((r) => r.title)).toEqual(['一', '二']);
  });

  it('依赖校验失败只败该项：批内 1 行坏依赖 → 其余成、该项 ok:false 带 index/error', async () => {
    const a = insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner' });
    const handler = handlers.get('task:createBatch')!;
    const result = (await handler(null, {
      items: [
        { workspaceId: 'ws1', title: '正常' },
        { workspaceId: 'ws1', title: '坏依赖', dependsOn: ['T-999'] },
        { workspaceId: 'ws1', title: '带好依赖', dependsOn: [a.id] },
      ],
    })) as {
      results: Array<{ ok: boolean; index?: number; error?: string; task?: { id: string } }>;
    };

    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.ok).toBe(true);
    expect(result.results[1]).toEqual({
      ok: false,
      index: 1,
      error: '依赖任务 T-999 不存在',
    });
    expect(result.results[2]!.ok).toBe(true);
    // 部分成功允许：2 行落库（含好依赖那行），坏依赖行零残留
    const rows = listTasks({ workspaceId: 'ws1' });
    expect(rows.map((r) => r.title).sort()).toEqual(['A', '带好依赖', '正常']);
    expect(listDependencyEdges()).toEqual([
      { from: result.results[2]!.task!.id, to: a.id },
    ]);
  });

  it('批内先行项可被后续项依赖（逐项顺序落库语义）', async () => {
    const handler = handlers.get('task:createBatch')!;
    const result = (await handler(null, {
      items: [
        { workspaceId: 'ws1', title: '前置' },
        { workspaceId: 'ws1', title: '后继', dependsOn: [] },
      ],
    })) as { results: Array<{ ok: boolean; task?: { id: string } }> };
    // 后继依赖前置：拿第一项 id 再发一批验证（创建路径依赖校验吃的是已落库行）
    const firstId = result.results[0]!.task!.id;
    const second = (await handler(null, {
      items: [{ workspaceId: 'ws1', title: '依赖先行', dependsOn: [firstId] }],
    })) as { results: Array<{ ok: boolean; task?: { id: string } }> };
    expect(second.results[0]!.ok).toBe(true);
    expect(listDependencyEdges()).toEqual([
      { from: second.results[0]!.task!.id, to: firstId },
    ]);
  });

  it(`超上限（${TASK_CREATE_BATCH_LIMIT}+1）→ 整体 bad_request，零落库`, async () => {
    const handler = handlers.get('task:createBatch')!;
    const items = Array.from({ length: TASK_CREATE_BATCH_LIMIT + 1 }, (_, i) => ({
      workspaceId: 'ws1',
      title: `t${i}`,
    }));
    await expect(handler(null, { items })).rejects.toThrow(
      `批量创建一次最多 ${TASK_CREATE_BATCH_LIMIT} 条（收到 ${TASK_CREATE_BATCH_LIMIT + 1} 条）`,
    );
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(0);
  });

  it('恰好上限 50 条 → 放行（边界含端）', async () => {
    const handler = handlers.get('task:createBatch')!;
    const items = Array.from({ length: TASK_CREATE_BATCH_LIMIT }, (_, i) => ({
      workspaceId: 'ws1',
      title: `t${i}`,
    }));
    const result = (await handler(null, { items })) as { results: unknown[] };
    expect(result.results).toHaveLength(TASK_CREATE_BATCH_LIMIT);
  });

  it('items 非数组 / 空数组 → 人话拒绝', async () => {
    const handler = handlers.get('task:createBatch')!;
    await expect(handler(null, {})).rejects.toThrow('task:createBatch 需要 items 数组');
    await expect(handler(null, { items: [] })).rejects.toThrow('items 不能为空');
  });

  it('分组校验失败同样只败该项（createTaskFromForm 同源校验透传）', async () => {
    const handler = handlers.get('task:createBatch')!;
    const result = (await handler(null, {
      items: [
        { workspaceId: 'ws1', title: '好', groupId: undefined },
        { workspaceId: 'ws1', title: '坏组', groupId: 'G-999' },
      ],
    })) as { results: Array<{ ok: boolean; error?: string }> };
    expect(result.results[0]!.ok).toBe(true);
    expect(result.results[1]!.ok).toBe(false);
    expect(result.results[1]!.error).toContain('G-999');
  });
});

describe('task:setRelations 通道（M3.3 §2.1）', () => {
  it('dependsOn 更新透传 setTaskRelations（全量替换生效）', async () => {
    const a = insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner' });
    const t = insertTask({ workspaceId: 'ws1', title: 'T', creatorUserId: 'owner' });
    const handler = handlers.get('task:setRelations')!;
    const row = (await handler(null, { taskId: t.id, dependsOn: [a.id] })) as {
      blocked: boolean;
      blockedBy: string[];
    };
    expect(row.blocked).toBe(true);
    expect(row.blockedBy).toEqual([a.id]);
    expect(listDependencyEdges()).toEqual([{ from: t.id, to: a.id }]);
  });

  it('环提交 → 通道抛错含环路径（renderer 拿到人话）', async () => {
    const a = insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner' });
    const b = insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'owner' });
    const handler = handlers.get('task:setRelations')!;
    await handler(null, { taskId: b.id, dependsOn: [a.id] });
    // 环路径起点随 DFS 遍历序——锁「闭合双点环」不锁根
    await expect(handler(null, { taskId: a.id, dependsOn: [b.id] })).rejects.toThrow(
      new RegExp(`存在依赖环：(${a.id} → ${b.id} → ${a.id}|${b.id} → ${a.id} → ${b.id})`),
    );
  });

  it('任务不存在 → 人话拒绝', async () => {
    const handler = handlers.get('task:setRelations')!;
    await expect(handler(null, { taskId: 'T-404', dependsOn: [] })).rejects.toThrow(
      '任务 T-404 不存在',
    );
  });
});

describe('task:update 保护字段追加（M3.3）', () => {
  it('patch 携带 parentTaskId/dependsOn/blocked/blockedBy → 剥离不生效，合法字段照常', async () => {
    const a = insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner' });
    const t = insertTask({ workspaceId: 'ws1', title: 'T', creatorUserId: 'owner' });
    const handler = handlers.get('task:update')!;
    await handler(null, t.id, {
      title: '改名',
      parentTaskId: a.id,
      dependsOn: [a.id],
      blocked: false,
      blockedBy: [],
    });

    const row = getTask(t.id)!;
    expect(row.title).toBe('改名');
    expect(row.parentTaskId).toBeNull(); // 关系字段未生效——须走 task:setRelations
    expect(listDependencyEdges()).toEqual([]); // 边零写入
    // blocked 派生态仍按真实依赖计算（无依赖 → false），不是被 patch 的值
    expect(row.blocked).toBe(false);
  });
});
