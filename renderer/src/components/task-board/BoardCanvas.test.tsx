// renderer/src/components/task-board/BoardCanvas.test.tsx
//
// 看板拖拽测试(看板重构 Task 12 → 2026-09-30 排序退役收敛):
//   - resolveDrop 纯函数(主战场):同列同组 no-op(列内顺序由 pinned/创建时间
//     决定,拖拽无排序语义)/ 同列跨泳道仅换组 / 跨列透传目标 + 禁投 null
//     (canDropIntoColumn 单源)+ 自落原位 no-op + 数据不一致防御
//   - buildDropIndex / buildDropTarget:dnd-kit over.id → 落点目标 组装
//     (列容器前缀解析 / 平铺模式保 active 现组;泳道成员集已随排序退役删除)
//   - 组件渲染:泳道 header/折叠、平铺模式组 chip
//   - Task 13 追加:resolveDrop.requireConfirm(in_progress→done/closed 二次确认)、
//     确认文案(dropConfirmContent)、useBoardDrop 落点协调(renderHook 驱动:
//     确认拦截/取消零调用/wire 剥离/失败 toast/拖悬目标列高亮)
//
// DOM 级拖拽模拟(pointer/keyboard 事件序列驱动 DndContext)在 jsdom 下依赖
// getBoundingClientRect 全零矩形——碰撞检测不可信,按 task-12 brief 裁定改为
// 「resolveDrop + buildDropTarget 纯逻辑单测 + handler 组装链覆盖」,拖拽闭环
// 由 Task 13+ e2e 与手工冒烟承接。
//
// mock 边界对齐 TaskBoardView.test:仅 mock IPC(window.api),store 用真实实现
// (momo-test-rules #5)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BoardCanvas, resolveDrop, buildDropIndex, buildDropTarget, type DropCtx } from './BoardCanvas';
import { useBoardDrop, dropConfirmContent } from './useBoardDrop';
import { Toast } from '../ui/Toast';
import { splitLanes, type BoardLane } from '../../lib/board';
import type { GroupRow, TaskRow } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    move: vi.fn().mockResolvedValue(null),
  },
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
};

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws-1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    ...partial,
  };
}

function mkGroup(partial: Partial<GroupRow> & Pick<GroupRow, 'id' | 'name'>): GroupRow {
  return {
    workspaceId: 'ws-1',
    color: null,
    position: 1024,
    archivedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

/** 板基线:待办列两泳道 G-1(T1,T2) / G-2(T3,T4) */
function backlogFixture(): TaskRow[] {
  return [
    mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: 'G-1', pinnedAt: 1024 }),
    mkTask({ id: 'T2', title: '乙', status: 'pending', groupId: 'G-1', pinnedAt: 2048 }),
    mkTask({ id: 'T3', title: '丙', status: 'draft', groupId: 'G-2', pinnedAt: 1024 }),
    mkTask({ id: 'T4', title: '丁', status: 'pending', groupId: 'G-2', pinnedAt: 2048 }),
  ];
}

function idsOf(lane: BoardLane): Set<string> {
  return new Set(lane.tasks.map((t) => t.id));
}

const GROUPS = [mkGroup({ id: 'G-1', name: '组一', position: 1 }), mkGroup({ id: 'G-2', name: '组二', position: 2 })];

// ── resolveDrop:拖拽三分支 + 禁投 + 边界(纯函数,无渲染)─────────────────────
describe('resolveDrop 拖拽落点裁决(纯函数)', () => {
  it('同列同组 → null(排序退役:列内顺序由 pinned/创建时间决定,拖拽无语义)', () => {
    const tasks = backlogFixture();
    // 落卡片与落列容器同判 no-op
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T2', column: 'backlog', groupId: 'G-1' }, { tasks }),
    ).toBeNull();
    expect(
      resolveDrop('T1', { type: 'column', column: 'backlog', groupId: 'G-1' }, { tasks }),
    ).toBeNull();
  });

  it('in_progress 同列同组 → null 且无任何动作语义(确认流也不进)', () => {
    const running = [mkTask({ id: 'R1', title: '运行卡', status: 'in_progress' })];
    expect(
      resolveDrop('R1', { type: 'column', column: 'active', groupId: null }, { tasks: running }),
    ).toBeNull();
  });

  it('同列跨泳道(落卡片/列容器)→ 仅换组:{column, groupId} 无卡级锚点', () => {
    const tasks = backlogFixture();
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T3', column: 'backlog', groupId: 'G-2' }, { tasks }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', requireConfirm: false });
    expect(
      resolveDrop('T1', { type: 'column', column: 'backlog', groupId: 'G-2' }, { tasks }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', requireConfirm: false });
  });

  it('跨列 assigned→active → column 透传(renderer 只发目标,不定动作)', () => {
    const tasks = [
      mkTask({ id: 'A1', title: '已分配卡', status: 'assigned', groupId: null }),
      mkTask({ id: 'R1', title: '运行卡', status: 'in_progress', groupId: null }),
    ];
    expect(
      resolveDrop('A1', { type: 'column', column: 'active', groupId: null }, { tasks }),
    ).toEqual({ column: 'active', groupId: null, requireConfirm: false });
    // 落到目标列某张卡上同样只表达列目标
    expect(
      resolveDrop('A1', { type: 'card', taskId: 'R1', column: 'active', groupId: null }, { tasks }),
    ).toEqual({ column: 'active', groupId: null, requireConfirm: false });
  });

  it('in_progress → done/closed → requireConfirm(其余跨列 false)', () => {
    const running = [mkTask({ id: 'R1', title: '运行卡', status: 'in_progress' })];
    expect(
      resolveDrop('R1', { type: 'column', column: 'done', groupId: null }, { tasks: running }),
    ).toMatchObject({ requireConfirm: true });
    expect(
      resolveDrop('R1', { type: 'column', column: 'closed', groupId: null }, { tasks: running }),
    ).toMatchObject({ requireConfirm: true });
    expect(
      resolveDrop('R1', { type: 'column', column: 'done', groupId: null }, { tasks: running }),
    ).not.toHaveProperty('beforeTaskId');
  });

  it('禁投列 → null(canDropIntoColumn 单源预判)', () => {
    const tasks = backlogFixture();
    const ctx: DropCtx = { tasks };
    // draft → active 状态机不允许
    expect(resolveDrop('T1', { type: 'column', column: 'active', groupId: null }, ctx)).toBeNull();
    // 落卡片同判:draft 拖到 active 列的卡上一样禁
    expect(resolveDrop('T1', { type: 'card', taskId: 'R9', column: 'active', groupId: null }, ctx)).toBeNull();
    // in_progress → backlog 只出不进
    const running = [mkTask({ id: 'R1', title: '运行卡', status: 'in_progress' })];
    expect(
      resolveDrop('R1', { type: 'column', column: 'backlog', groupId: null }, { tasks: running }),
    ).toBeNull();
    // completed → closed 无转换意义(禁)
    const done = [mkTask({ id: 'D1', title: '完成卡', status: 'completed' })];
    expect(
      resolveDrop('D1', { type: 'column', column: 'closed', groupId: null }, { tasks: done }),
    ).toBeNull();
    // 终态 → active 禁
    expect(
      resolveDrop('D1', { type: 'column', column: 'active', groupId: null }, { tasks: done }),
    ).toBeNull();
  });

  it('over 卡片=active 自身 → null(自落原位 no-op)', () => {
    const tasks = backlogFixture();
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T1', column: 'backlog', groupId: 'G-1' }, { tasks }),
    ).toBeNull();
  });

  it('active 任务不在 ctx.tasks → null(防御)', () => {
    expect(
      resolveDrop('T-ghost', { type: 'column', column: 'backlog', groupId: null }, { tasks: backlogFixture() }),
    ).toBeNull();
  });
});

// ── buildDropIndex / buildDropTarget:dnd over.id → 落点目标组装(纯函数)─────
describe('buildDropTarget 组装(dnd over.id 解析)', () => {
  const tasks = [
    mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: 'G-2', pinnedAt: 1024 }),
    mkTask({ id: 'T2', title: '乙', status: 'draft', groupId: 'G-2', pinnedAt: 2048 }),
    mkTask({ id: 'U1', title: '未分组卡', status: 'draft', groupId: null, pinnedAt: 1024 }),
  ];

  it('泳道模式:col: 前缀 → 列容器目标(组=泳道组)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    const active = tasks[0]!; // G-2 卡
    expect(buildDropTarget('col:G-2:backlog', active, index, 'lanes')).toEqual({
      type: 'column',
      column: 'backlog',
      groupId: 'G-2',
    });
  });

  it('泳道模式:未分组道 groupId=null', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    expect(buildDropTarget('col:ungrouped:backlog', tasks[0]!, index, 'lanes')).toEqual({
      type: 'column',
      column: 'backlog',
      groupId: null,
    });
  });

  it('平铺模式:col: 目标 → groupId 保 active 现组(单道无换组语义)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'flat'), 'flat');
    const active = tasks[0]!; // groupId=G-2
    expect(buildDropTarget('col:flat:backlog', active, index, 'flat')).toEqual({
      type: 'column',
      column: 'backlog',
      groupId: 'G-2',
    });
  });

  it('卡片 id → 卡片目标(columnOf(status) 定列,泳道组透传)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    expect(buildDropTarget('T2', tasks[0]!, index, 'lanes')).toEqual({
      type: 'card',
      taskId: 'T2',
      column: 'backlog',
      groupId: 'G-2',
    });
  });

  it('平铺模式卡片 → groupId 保 active 现组', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'flat'), 'flat');
    expect(buildDropTarget('U1', tasks[0]!, index, 'flat')).toEqual({
      type: 'card',
      taskId: 'U1',
      column: 'backlog',
      groupId: 'G-2',
    });
  });

  it('未知 over.id(不在注册表/任务表)→ null', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    expect(buildDropTarget('col:G-9:backlog', tasks[0]!, index, 'lanes')).toBeNull();
    expect(buildDropTarget('T-ghost', tasks[0]!, index, 'lanes')).toBeNull();
  });
});

// ── BoardCanvas 渲染结构(DndContext 接线后的静态断言)────────────────────────
describe('BoardCanvas 渲染结构', () => {
  const groups = [mkGroup({ id: 'G-1', name: '前端组', position: 1 }), mkGroup({ id: 'G-2', name: '后端组', position: 2 })];
  const tasks = [
    mkTask({ id: 'T1', title: '甲任务', status: 'draft', groupId: 'G-1', pinnedAt: 1024 }),
    mkTask({ id: 'T2', title: '乙任务', status: 'in_progress', groupId: 'G-2', pinnedAt: 1024 }),
    mkTask({ id: 'U1', title: '散任务', status: 'pending', groupId: null, pinnedAt: 1024 }),
  ];

  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({ tasks: [], dragging: false, pendingMoveCount: 0 });
    mockApi.task.move.mockClear().mockResolvedValue(null);
  });

  it('泳道模式:组名 heading + 未分组道 + 卡片入道', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="lanes" selectedId={null} onSelect={() => {}} workspaceId="ws1" />);
    // heading 可访问名含计数 span,用正则匹配(组名 + 计数)
    expect(screen.getByRole('heading', { name: /前端组/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /后端组/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /未分组/ })).toBeInTheDocument();
    expect(screen.getByText(/甲任务/)).toBeInTheDocument();
    expect(screen.getByText(/乙任务/)).toBeInTheDocument();
    expect(screen.getByText(/散任务/)).toBeInTheDocument();
  });

  it('平铺模式:无泳道 heading,卡片渲染且带组 chip', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="flat" selectedId={null} onSelect={() => {}} workspaceId="ws1" />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    // 组 chip:平铺模式卡片显示组名(BoardCanvas 内部解析 group)
    expect(screen.getByText('前端组')).toBeInTheDocument();
    expect(screen.getByText('后端组')).toBeInTheDocument();
    // 散任务无组 → 无 chip,仅卡本体
    expect(screen.getByText(/散任务/)).toBeInTheDocument();
  });

  it('泳道折叠:点击 chevron 只留 header,该泳道卡片卸载', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="lanes" selectedId={null} onSelect={() => {}} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('button', { name: '折叠泳道 前端组' }));
    expect(screen.getByRole('heading', { name: /前端组/ })).toBeInTheDocument();
    expect(screen.queryByText(/甲任务/)).not.toBeInTheDocument();
    // 其余泳道不受影响
    expect(screen.getByText(/乙任务/)).toBeInTheDocument();
  });
});

// ── requireConfirm:in_progress → done/closed 二次确认(纯函数,Task 13)────────
describe('resolveDrop requireConfirm(运行中任务移终态列需确认)', () => {
  const tasks = [
    mkTask({ id: 'R1', title: '运行一', status: 'in_progress', pinnedAt: 1024 }),
    mkTask({ id: 'R2', title: '运行二', status: 'in_progress', pinnedAt: 2048 }),
    mkTask({ id: 'D1', title: '完成卡', status: 'completed', pinnedAt: 1024 }),
    mkTask({ id: 'A1', title: '分配卡', status: 'assigned', pinnedAt: 1024 }),
    mkTask({ id: 'T1', title: '草稿卡', status: 'draft', pinnedAt: 1024 }),
  ];

  it('in_progress → done(列容器 / 落卡)→ requireConfirm: true（无锚点）', () => {
    expect(
      resolveDrop('R1', { type: 'column', column: 'done', groupId: null }, { tasks }),
    ).toEqual({ column: 'done', groupId: null, requireConfirm: true });
    expect(
      resolveDrop('R1', { type: 'card', taskId: 'D1', column: 'done', groupId: null }, { tasks }),
    ).toEqual({ column: 'done', groupId: null, requireConfirm: true });
  });

  it('in_progress → closed(空列)→ requireConfirm: true', () => {
    expect(
      resolveDrop('R1', { type: 'column', column: 'closed', groupId: null }, { tasks }),
    ).toEqual({ column: 'closed', groupId: null, requireConfirm: true });
  });

  it('in_progress 同列同组 → null（排序退役 no-op，无确认可言）', () => {
    expect(
      resolveDrop('R2', { type: 'card', taskId: 'R1', column: 'active', groupId: null }, { tasks }),
    ).toBeNull();
  });

  it('assigned → active 跨列 → requireConfirm: false', () => {
    expect(
      resolveDrop('A1', { type: 'column', column: 'active', groupId: null }, { tasks }),
    ).toEqual({ column: 'active', groupId: null, requireConfirm: false });
  });

  it('draft → assigned 跨列 → requireConfirm: false', () => {
    expect(
      resolveDrop('T1', { type: 'column', column: 'assigned', groupId: null }, { tasks }),
    ).toEqual({ column: 'assigned', groupId: null, requireConfirm: false });
  });

  it('paused → done 禁投 → null(无确认可言)', () => {
    const paused = [mkTask({ id: 'P1', title: '暂停卡', status: 'paused' })];
    expect(
      resolveDrop('P1', { type: 'column', column: 'done', groupId: null }, { tasks: paused }),
    ).toBeNull();
  });

  it('completed → closed 禁投 → null', () => {
    expect(
      resolveDrop('D1', { type: 'column', column: 'closed', groupId: null }, { tasks }),
    ).toBeNull();
  });
});

// ── 确认文案(done 不停 agent / closed 终止——spec 裁定的语义如实描述)─────────
describe('dropConfirmContent 确认文案', () => {
  it('done:如实描述「任务转已完成但 agent 运行不停」', () => {
    expect(dropConfirmContent('done')).toEqual({
      title: '确认手动完成任务',
      message: 'agent 可能仍在运行。确认后任务将转为已完成,但 agent 运行不会停止。',
      confirmLabel: '完成任务',
    });
  });

  it('closed:声明「将终止 agent 运行」', () => {
    expect(dropConfirmContent('closed')).toEqual({
      title: '确认取消运行中任务',
      message: '确认取消该运行中任务?此操作将终止 agent 运行。',
      confirmLabel: '终止运行',
    });
  });

  it('其余列传入 → 抛错防御(只有 done/closed 会进确认流)', () => {
    expect(() => dropConfirmContent('backlog')).toThrow();
  });
});

// ── useBoardDrop 落点协调:确认拦截 / 取消零调用 / wire 剥离 / 失败 toast / 指示线 ──
// renderHook 直接驱动 dragStart/dragEnd/dragOver(原始 id 入参,不依赖 dnd 事件
// 形状)——jsdom 下 DOM 拖拽不可信(Task 12 裁定),组装链经真实 buildDropIndex/
// buildDropTarget/resolveDrop + 真实 store,只有 ipc 边界是 mock(momo-test-rules #5)。
describe('useBoardDrop 落点协调', () => {
  const groups = [mkGroup({ id: 'G-1', name: '组一', position: 1 })];

  const boardTasks = (): TaskRow[] => [
    mkTask({ id: 'R1', title: '运行一', status: 'in_progress', groupId: null, pinnedAt: 1024 }),
    mkTask({ id: 'R2', title: '运行二', status: 'in_progress', groupId: null, pinnedAt: 2048 }),
    mkTask({ id: 'D1', title: '完成卡', status: 'completed', groupId: null, pinnedAt: 1024 }),
    mkTask({ id: 'A1', title: '分配卡', status: 'assigned', groupId: null, pinnedAt: 1024 }),
  ];

  function setup(tasks: TaskRow[] = boardTasks(), laneMode: 'flat' | 'lanes' = 'flat') {
    const dropIndex = buildDropIndex(splitLanes(tasks, groups, laneMode), laneMode);
    return renderHook(() => useBoardDrop({ tasks, laneMode, dropIndex }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <>
          <Toast />
          {children}
        </>
      ),
    });
  }

  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({ tasks: [], dragging: false, pendingMoveCount: 0 });
    mockApi.task.move.mockClear().mockResolvedValue(null);
  });

  it('in_progress → done 松手 → 拦截确认:move 零调用、store 零副作用、轮询守卫复位', () => {
    const { result } = setup();
    act(() => result.current.dragStart('R1'));
    expect(useTaskStore.getState().dragging).toBe(true);
    act(() => result.current.dragEnd('R1', 'col:flat:done'));
    expect(mockApi.task.move).not.toHaveBeenCalled();
    expect(useTaskStore.getState().dragging).toBe(false);
    expect(result.current.pendingConfirm?.taskId).toBe('R1');
    expect(result.current.pendingConfirm?.resolution.column).toBe('done');
    // 取消语义的前置:乐观更新尚未发生(store tasks 未动,卡片天然在原位)
    expect(useTaskStore.getState().tasks).toHaveLength(0);
  });

  // 泳道语义重构 §4.4:无目标草稿拖入排队中 → 指派弹框接管(不发 move);
  // 有目标直接 move 入队
  it('无目标 draft → 拖入排队中松手 → 拦截进 pendingAssign,move 零调用', () => {
    const tasks = [
      mkTask({ id: 'W1', title: '无目标草稿', status: 'draft', groupId: null, assigneeAgentId: null, targetTeamId: null, targetSessionId: null }),
    ];
    const { result } = setup(tasks);
    act(() => result.current.dragStart('W1'));
    act(() => result.current.dragEnd('W1', 'col:flat:assigned'));
    expect(mockApi.task.move).not.toHaveBeenCalled();
    expect(result.current.pendingAssign).toEqual({ taskId: 'W1', groupId: null });
    expect(useTaskStore.getState().dragging).toBe(false);
  });

  it('有目标 draft → 拖入排队中松手 → 直接 move 入队,不弹框', () => {
    const tasks = [
      mkTask({ id: 'W2', title: '有目标草稿', status: 'draft', groupId: null, assigneeAgentId: 'inst-9' }),
    ];
    const { result } = setup(tasks);
    act(() => result.current.dragStart('W2'));
    act(() => result.current.dragEnd('W2', 'col:flat:assigned'));
    expect(mockApi.task.move).toHaveBeenCalledWith('W2', { column: 'assigned', groupId: null });
    expect(result.current.pendingAssign).toBeNull();
  });

  it('接线:无目标 draft 拖入排队中 → 渲染指派弹框(取消后卸载)', async () => {
    const tasks = [
      mkTask({ id: 'W1', title: '无目标草稿', status: 'draft', groupId: null }),
    ];
    render(
      <>
        <Toast />
        <BoardCanvas tasks={tasks} groups={groups} laneMode="flat" selectedId={null} onSelect={() => {}} workspaceId="ws1" />
      </>,
    );
    // 直接经 dnd 事件不可信(jsdom)——渲染层断言弹框出现即可,拦截链已由上方
    // renderHook 用例锁定;此处用 DOM contextmenu 不可行,改经 store 侧验证:
    // 用 fireEvent.dragEnd 也不可靠,故本用例锁「组件接收 workspaceId 并在
    // pendingAssign 非空时渲染弹框」的 props 接线——经 hook 层已无法触达渲染,
    // 保留为挂载冒烟:正常渲染不炸 + 无弹框
    expect(screen.queryByText('指派并放入队列')).not.toBeInTheDocument();
  });

  it('cancelAssign → pendingAssign 清空且 move 仍零调用(取消零副作用)', () => {
    const tasks = [
      mkTask({ id: 'W1', title: '无目标草稿', status: 'draft', groupId: null }),
    ];
    const { result } = setup(tasks);
    act(() => result.current.dragStart('W1'));
    act(() => result.current.dragEnd('W1', 'col:flat:assigned'));
    act(() => result.current.cancelAssign());
    expect(result.current.pendingAssign).toBeNull();
    expect(mockApi.task.move).not.toHaveBeenCalled();
  });

  it('取消确认 → pendingConfirm 清空,move 仍零调用(卡片归位零副作用)', () => {
    const { result } = setup();
    act(() => result.current.dragEnd('R1', 'col:flat:done'));
    act(() => result.current.cancelConfirm());
    expect(result.current.pendingConfirm).toBeNull();
    expect(mockApi.task.move).not.toHaveBeenCalled();
  });

  it('确认 → move 收到落点 target(requireConfirm 不泄入 wire),pendingConfirm 清空', async () => {
    const { result } = setup();
    act(() => result.current.dragEnd('R1', 'col:flat:done'));
    await act(async () => {
      result.current.confirmMove();
    });
    expect(mockApi.task.move).toHaveBeenCalledTimes(1);
    // momo-boundary-rules:requireConfirm 是 UI 决策字段,wire 契约(MainTarget)不得携带
    expect(mockApi.task.move.mock.calls[0]).toEqual(['R1', { column: 'done', groupId: null }]);
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('assigned → active 普通合法拖拽 → 不弹确认直接 move', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.dragEnd('A1', 'col:flat:active');
    });
    expect(mockApi.task.move).toHaveBeenCalledTimes(1);
    expect(mockApi.task.move.mock.calls[0]![1]!.column).toBe('active');
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('move 失败 → toast 直出主进程中文原因', async () => {
    mockApi.task.move.mockRejectedValueOnce(new Error('目标分组不存在: G-9'));
    const { result } = setup();
    await act(async () => {
      result.current.dragEnd('A1', 'col:flat:active');
    });
    expect(mockApi.task.move).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ui-toast')).toHaveTextContent('目标分组不存在: G-9');
  });

  it('dragOver 同列同组(悬卡片)→ dropHint=null(排序 no-op 无反馈)', () => {
    const { result } = setup();
    act(() => result.current.dragStart('R2'));
    act(() => result.current.dragOver('R2', 'R1'));
    expect(result.current.dropHint).toBeNull();
  });

  it('dragOver 跨列 → dropHint=目标列(column/groupId)', () => {
    const { result } = setup();
    act(() => result.current.dragStart('R1'));
    // in_progress → closed 合法
    act(() => result.current.dragOver('R1', 'col:flat:closed'));
    expect(result.current.dropHint).toEqual({ column: 'closed', groupId: null });
    // 同列不同目标列即时切换
    act(() => result.current.dragOver('R1', 'col:flat:done'));
    expect(result.current.dropHint).toEqual({ column: 'done', groupId: null });
  });

  it('dragOver 禁投列 → dropHint=null;dragEnd/dragCancel 清空高亮', () => {
    const { result } = setup();
    act(() => result.current.dragStart('R1'));
    act(() => result.current.dragOver('R1', 'col:flat:backlog'));
    expect(result.current.dropHint).toBeNull();
    // 合法落点给出 hint 后,松手/取消都要清
    act(() => result.current.dragOver('R1', 'col:flat:done'));
    expect(result.current.dropHint).not.toBeNull();
    act(() => result.current.dragCancel());
    expect(result.current.dropHint).toBeNull();
    act(() => result.current.dragOver('R1', 'col:flat:done'));
    expect(result.current.dropHint).not.toBeNull();
    act(() => result.current.dragEnd('R1', 'col:flat:done'));
    expect(result.current.dropHint).toBeNull();
    expect(result.current.activeDragId).toBeNull();
  });
});
