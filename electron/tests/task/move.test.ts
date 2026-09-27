// electron/tests/task/move.test.ts
//
// 看板重构 Task 5 回归锁:executeMove 语义表逐格断言(spec §3.2/§4)。
// 本文件锁的是「move 选了哪个动作」的映射 + 落点计算 + 换组校验;
// 动作本身的语义(start/resume/cancel 全链)由 Task 4 的 lifecycle.test.ts 锁——
// 两层各司其职(momo-test-rules)。
//
// mock 边界(controller 裁决):只 mock lifecycle 三函数
// (startTaskAndKickoff / resumePausedTask / cancelTask),send-message 不 mock
// (lifecycle 已被整体替换,其内部依赖不会加载);状态机 / repo / starter /
// executor / recurrence 全部真实运行。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/task/lifecycle', () => ({
  startTaskAndKickoff: vi.fn(),
  resumePausedTask: vi.fn(),
  cancelTask: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  getTask,
  updateTask,
  transitionTaskStatus,
  listTasks,
  type TaskRow,
  type TaskStatus,
} from '../../src/main/storage/tasks/repo';
import { createGroup, archiveGroup } from '../../src/main/storage/task-groups/repo';
import { executeMove } from '../../src/main/task/move';
import {
  startTaskAndKickoff,
  resumePausedTask,
  cancelTask,
} from '../../src/main/task/lifecycle';

const startMock = vi.mocked(startTaskAndKickoff);
const resumeMock = vi.mocked(resumePausedTask);
const cancelMock = vi.mocked(cancelTask);

// mock 返回值:move 不读动作返回值(只 await),给最小成功形状即可
startMock.mockResolvedValue({ task: undefined as never, executionSessionId: '', createdNewRoom: false });
resumeMock.mockResolvedValue(undefined as never);
cancelMock.mockResolvedValue(undefined);

const WS = 'wsm';
const tmpRoot = path.join(os.tmpdir(), `ap-move-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 直插任务(初始态 draft/pending/assigned 直接插即生产合法;派生态走 seedViaChain) */
const seed = (status: TaskStatus, extra: Partial<TaskRow> = {}) =>
  insertTask({ workspaceId: WS, title: 't', creatorUserId: 'owner', status, ...extra });

/**
 * 经生产合法链 seed 派生态(momo-test-rules 第 1 条:直插 status 不贴真实运行时)。
 * assigned → in_progress(+会话) → paused / completed / cancelled 按需续走。
 */
function seedViaChain(status: 'in_progress' | 'paused' | 'completed', extra: Partial<TaskRow> = {}): TaskRow {
  const t = seed('assigned', { assigneeAgentId: 'i-1', ...extra });
  transitionTaskStatus(t.id, 'in_progress', { executionSessionId: 'sess-1' });
  if (status === 'paused') transitionTaskStatus(t.id, 'paused');
  if (status === 'completed') transitionTaskStatus(t.id, 'completed', { completedAt: Date.now() });
  return getTask(t.id)!;
}

beforeEach(() => {
  vi.clearAllMocks(); // 清调用记录,保留模块级 mockResolvedValue 基线
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

describe('executeMove 语义表——同列(纯排序/换泳道)', () => {
  it('同列同组 = 纯排序:不动状态,写 board_position', async () => {
    const t = seed('draft');
    await executeMove(t.id, { column: 'backlog', groupId: null });
    expect(getTask(t.id)?.status).toBe('draft');
    expect(getTask(t.id)?.boardPosition).not.toBeNull();
  });

  it('in_progress 留在 active 列 = 纯排序,不触发任何动作(spec §4「仅列内」格)', async () => {
    const t = seedViaChain('in_progress');
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(getTask(t.id)?.status).toBe('in_progress'); // 原样保持
    expect(startMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('paused 同列拖动 = 纯排序(controller 修订:同列一律纯排序含 paused)', async () => {
    // 断点续跑是重副作用,无拖拽入口——只走卡片/抽屉的 task:resume 按钮
    const t = seedViaChain('paused');
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(getTask(t.id)?.status).toBe('paused'); // 原样保持
    expect(getTask(t.id)?.boardPosition).not.toBeNull();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('同列跨泳道 → group_id 更新(状态不动)', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v1' });
    const t = seed('draft');
    await executeMove(t.id, { column: 'backlog', groupId: g.id });
    expect(getTask(t.id)?.groupId).toBe(g.id);
    expect(getTask(t.id)?.status).toBe('draft');
  });
});

describe('executeMove 语义表——跨列动作映射', () => {
  it('draft→assigned 列:有委派目标 → transition assigned;无目标 → 拒且零副作用', async () => {
    const ok = seed('draft', { assigneeAgentId: 'i-1' });
    await executeMove(ok.id, { column: 'assigned', groupId: null });
    expect(getTask(ok.id)?.status).toBe('assigned');
    expect(getTask(ok.id)?.boardPosition).not.toBeNull();

    const bare = seed('draft');
    await expect(executeMove(bare.id, { column: 'assigned', groupId: null })).rejects.toThrow('委派目标');
    expect(getTask(bare.id)?.status).toBe('draft');
    expect(getTask(bare.id)?.boardPosition).toBeNull(); // Review Focus ①:不写半套
    expect(getTask(bare.id)?.groupId).toBeNull(); // 组/落点全部不写
  });

  it('pending→assigned:transition + 手动放行(状态落 assigned)', async () => {
    const t = seed('pending');
    await executeMove(t.id, { column: 'assigned', groupId: null });
    expect(getTask(t.id)?.status).toBe('assigned');
    expect(startMock).not.toHaveBeenCalled(); // 放行不等于启动
  });

  it('assigned→active:走 startTaskAndKickoff(Review Focus ②)', async () => {
    const t = seed('assigned', { assigneeAgentId: 'i-1' });
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(startMock).toHaveBeenCalledWith(t.id);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('session_queued→active:同样走 startTaskAndKickoff', async () => {
    const t = seed('assigned');
    transitionTaskStatus(t.id, 'session_queued');
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(startMock).toHaveBeenCalledWith(t.id);
  });

  it('paused 跨列格不变:→assigned/done 拒;→closed 走 cancelTask', async () => {
    const p1 = seedViaChain('paused');
    await expect(executeMove(p1.id, { column: 'assigned', groupId: null })).rejects.toThrow();
    const p2 = seedViaChain('paused');
    await expect(executeMove(p2.id, { column: 'done', groupId: null })).rejects.toThrow();
    expect(getTask(p2.id)?.status).toBe('paused'); // 拒后原样
    const p3 = seedViaChain('paused');
    await executeMove(p3.id, { column: 'closed', groupId: null });
    expect(cancelMock).toHaveBeenCalledWith(p3.id);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('in_progress→done:transition completed + completedAt', async () => {
    const t = seedViaChain('in_progress');
    await executeMove(t.id, { column: 'done', groupId: null });
    const after = getTask(t.id)!;
    expect(after.status).toBe('completed');
    expect(after.completedAt).not.toBeNull();
  });

  it('in_progress→done 且带循环规则:生成下一实例(与 agent complete_task 同语义)', async () => {
    const t = seedViaChain('in_progress', { recurrenceRule: 'daily@09:00' });
    await executeMove(t.id, { column: 'done', groupId: null });
    const children = listTasks({ workspaceId: WS }).filter((r) => r.recurrenceParentId === t.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe('pending');
  });

  it('in_progress→closed:走 cancelTask(确认框在 renderer,main 不再二次确认)', async () => {
    const t = seedViaChain('in_progress');
    await executeMove(t.id, { column: 'closed', groupId: null });
    expect(cancelMock).toHaveBeenCalledWith(t.id);
  });

  it('任意非终态→closed 一律走 cancelTask(抽验 draft 格)', async () => {
    const t = seed('draft');
    await executeMove(t.id, { column: 'closed', groupId: null });
    expect(cancelMock).toHaveBeenCalledWith(t.id);
  });
});

describe('executeMove 语义表——拒绝格(错误路径)', () => {
  it('任意→backlog 拒(待办只出不进)', async () => {
    const t = seedViaChain('in_progress');
    await expect(executeMove(t.id, { column: 'backlog', groupId: null })).rejects.toThrow('待办');
    expect(getTask(t.id)?.status).toBe('in_progress');
  });

  it('终态跨列一律拒(completed→active / failed→done / completed→closed)', async () => {
    const c = seedViaChain('completed');
    await expect(executeMove(c.id, { column: 'active', groupId: null })).rejects.toThrow();
    const f = seedViaChain('in_progress');
    updateTask(f.id, { status: 'failed', completedAt: Date.now() }); // 终态直写(终态只读,move 只读它)
    await expect(executeMove(f.id, { column: 'done', groupId: null })).rejects.toThrow();
    await expect(executeMove(c.id, { column: 'closed', groupId: null })).rejects.toThrow();
    // 拒绝后终态原样(零副作用)
    expect(getTask(c.id)?.status).toBe('completed');
    expect(getTask(f.id)?.status).toBe('failed');
  });

  it('任务不存在 → 抛错(预检)', async () => {
    await expect(executeMove('T-999', { column: 'backlog', groupId: null })).rejects.toThrow('不存在');
  });

  it('归档任务 → 拒(archivedAt 预检;即使同列纯排序也不放行)', async () => {
    const t = seedViaChain('completed'); // completed 属 done 列,同列 move 本是纯排序
    updateTask(t.id, { archivedAt: Date.now() }); // 归档终态卡
    await expect(executeMove(t.id, { column: 'done', groupId: null })).rejects.toThrow('任务已归档');
    expect(getTask(t.id)?.boardPosition).toBeNull(); // 零副作用:落点不写
  });
});

describe('executeMove 换组校验', () => {
  it('目标组已归档 → 拒(归档)', async () => {
    const t = seed('draft');
    const archived = createGroup({ workspaceId: WS, name: 'old' });
    archiveGroup(archived.id);
    await expect(executeMove(t.id, { column: 'backlog', groupId: archived.id })).rejects.toThrow('归档');
    expect(getTask(t.id)?.groupId).toBeNull(); // 零副作用
  });

  it('目标组不存在 → 拒(不存在)', async () => {
    const t = seed('draft');
    await expect(executeMove(t.id, { column: 'backlog', groupId: 'G-999' })).rejects.toThrow('不存在');
  });

  it('目标组属其他 workspace → 拒(视同不存在)', async () => {
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
      .run('ws-other', 'Other', '/tmp', 'owner');
    const foreign = createGroup({ workspaceId: 'ws-other', name: '外域' });
    const t = seed('draft');
    await expect(executeMove(t.id, { column: 'backlog', groupId: foreign.id })).rejects.toThrow('不存在');
  });

  it('换列 + 非法组同时发生 → 组校验前置,语义动作零副作用', async () => {
    // 回归锁:校验全部先于写动作——不能「先 completed 再发现组不存在」
    const t = seedViaChain('in_progress');
    await expect(executeMove(t.id, { column: 'done', groupId: 'G-999' })).rejects.toThrow('不存在');
    const after = getTask(t.id)!;
    expect(after.status).toBe('in_progress');
    expect(after.completedAt).toBeNull();
    expect(after.boardPosition).toBeNull();
  });
});

describe('executeMove 落点计算', () => {
  it('落点中值:before/after 邻居之间', async () => {
    const a = seed('draft');
    updateTask(a.id, { boardPosition: 1000 });
    const b = seed('draft');
    updateTask(b.id, { boardPosition: 2000 });
    const c = seed('draft');
    await executeMove(c.id, { column: 'backlog', groupId: null, beforeTaskId: b.id, afterTaskId: a.id });
    const pos = getTask(c.id)!.boardPosition!;
    expect(pos).toBeGreaterThan(1000);
    expect(pos).toBeLessThan(2000);
  });

  it('锚点缺失/陈旧 → 优雅兜底(单邻居作 next 取 next-GAP)', async () => {
    const a = seed('draft');
    updateTask(a.id, { boardPosition: 5000 });
    const c = seed('draft');
    // afterTaskId 指向不存在的任务 → 仅按 beforeTaskId 兜底为列首(next-GAP)
    await executeMove(c.id, {
      column: 'backlog',
      groupId: null,
      beforeTaskId: a.id,
      afterTaskId: 'T-999',
    });
    expect(getTask(c.id)!.boardPosition).toBe(5000 - 1024);
  });

  it('空列落点 = 0(placeBetween 双 null)', async () => {
    const t = seed('pending'); // pending 同属 backlog,但先用 draft 占位再移入空组更干净
    const g = createGroup({ workspaceId: WS, name: 'empty' });
    await executeMove(t.id, { column: 'backlog', groupId: g.id });
    expect(getTask(t.id)!.boardPosition).toBe(0);
  });

  it('邻居浮点重合(大数值中值取整撞邻居)→ 整列重整后取新序中值', async () => {
    // ruling(Task 3 review minor):diff≥MIN_SPACING 但 (prev+next)/2 浮点取整后
    // 与邻居相等——2^53 与 2^53+2 的中值取整回 2^53,此时须走整列重整
    const big = 2 ** 53;
    const a = seed('draft');
    updateTask(a.id, { boardPosition: big });
    const b = seed('draft');
    updateTask(b.id, { boardPosition: big + 2 });
    const c = seed('draft');
    await executeMove(c.id, { column: 'backlog', groupId: null, beforeTaskId: b.id, afterTaskId: a.id });
    // 整列重写为 i*GAP(cmpColumn:a 先创建排前),落点取重整后中值
    expect(getTask(a.id)!.boardPosition).toBe(0);
    expect(getTask(b.id)!.boardPosition).toBe(1024);
    expect(getTask(c.id)!.boardPosition).toBe(512);
  });

  it('列内已有挤死对(diff<MIN_SPACING)→ needsRebalance 整列重整', async () => {
    const a = seed('draft');
    updateTask(a.id, { boardPosition: 1000 });
    const b = seed('draft');
    updateTask(b.id, { boardPosition: 1000 }); // 与 a 重合 → 挤死
    const c = seed('draft');
    await executeMove(c.id, { column: 'backlog', groupId: null, beforeTaskId: b.id, afterTaskId: a.id });
    expect(getTask(a.id)!.boardPosition).toBe(0);
    expect(getTask(b.id)!.boardPosition).toBe(1024);
    expect(getTask(c.id)!.boardPosition).toBe(512);
  });
});
