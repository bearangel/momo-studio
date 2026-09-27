// renderer/src/components/task-board/BoardCanvas.test.tsx
//
// 看板拖拽测试(看板重构 Task 12):
//   - resolveDrop 纯函数(主战场):三分支语义(同列同泳道纯排序 / 同列跨泳道换组 /
//     跨列透传落点)+ 禁投 null(canDropIntoColumn 单源)+ over 列容器=列尾 +
//     自落原位 no-op + 数据不一致防御
//   - buildDropIndex / buildDropTarget:dnd-kit over.id → 落点目标 组装
//     (列容器前缀解析 / 泳道成员集 / 平铺模式保 active 现组)
//   - 组件渲染:泳道 header/折叠、平铺模式组 chip
//
// DOM 级拖拽模拟(pointer/keyboard 事件序列驱动 DndContext)在 jsdom 下依赖
// getBoundingClientRect 全零矩形——碰撞检测不可信,按 task-12 brief 裁定改为
// 「resolveDrop + buildDropTarget 纯逻辑单测 + handler 组装链覆盖」,拖拽闭环
// 由 Task 13+ e2e 与手工冒烟承接。
//
// mock 边界对齐 TaskBoardView.test:仅 mock IPC(window.api),store 用真实实现
// (momo-test-rules #5)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardCanvas, resolveDrop, buildDropIndex, buildDropTarget, type DropCtx } from './BoardCanvas';
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
    boardPosition: null,
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

/** 板基线:待办列两泳道 G-1(T1,T2) / G-2(T3,T4),boardPosition 升序 */
function backlogFixture(): TaskRow[] {
  return [
    mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: 'G-1', boardPosition: 1024 }),
    mkTask({ id: 'T2', title: '乙', status: 'pending', groupId: 'G-1', boardPosition: 2048 }),
    mkTask({ id: 'T3', title: '丙', status: 'draft', groupId: 'G-2', boardPosition: 1024 }),
    mkTask({ id: 'T4', title: '丁', status: 'pending', groupId: 'G-2', boardPosition: 2048 }),
  ];
}

function idsOf(lane: BoardLane): Set<string> {
  return new Set(lane.tasks.map((t) => t.id));
}

const GROUPS = [mkGroup({ id: 'G-1', name: '组一', position: 1 }), mkGroup({ id: 'G-2', name: '组二', position: 2 })];

// ── resolveDrop:拖拽三分支 + 禁投 + 边界(纯函数,无渲染)─────────────────────
describe('resolveDrop 拖拽落点裁决(纯函数)', () => {
  it('同列同泳道下移 → 纯排序:before=落卡(组不变)', () => {
    const tasks = backlogFixture();
    const laneIds = idsOf(splitLanes(tasks, GROUPS, 'lanes')[0]!);
    // T1 拖到 T2 上(T1 原在 T2 上方 → 落在 T2 之下):seq(除 T1)=[T2],before=T2
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T2', column: 'backlog', groupId: 'G-1' }, { tasks, laneTaskIds: laneIds }),
    ).toEqual({ column: 'backlog', groupId: 'G-1', beforeTaskId: 'T2' });
  });

  it('同列同泳道下移(中段)→ before/after 双邻透传(中值落位)', () => {
    const tasks = [
      mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: null, boardPosition: 1024 }),
      mkTask({ id: 'T2', title: '乙', status: 'draft', groupId: null, boardPosition: 2048 }),
      mkTask({ id: 'T3', title: '丙', status: 'draft', groupId: null, boardPosition: 3072 }),
    ];
    // T1 拖到 T2 上:seq(除 T1)=[T2,T3] → before=T2,after=T3
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T2', column: 'backlog', groupId: null }, { tasks }),
    ).toEqual({ column: 'backlog', groupId: null, beforeTaskId: 'T2', afterTaskId: 'T3' });
  });

  it('同列同泳道上移 → 纯排序:after=落卡', () => {
    const tasks = backlogFixture();
    const laneIds = idsOf(splitLanes(tasks, GROUPS, 'lanes')[1]!);
    // T4 拖到 T3 上(T4 原在 T3 下方 → 落在 T3 之上):seq(除 T4)=[T3] → after=T3
    expect(
      resolveDrop('T4', { type: 'card', taskId: 'T3', column: 'backlog', groupId: 'G-2' }, { tasks, laneTaskIds: laneIds }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', afterTaskId: 'T3' });
  });

  it('同列跨泳道(落卡片)→ 换组:groupId=目标泳道组,跨源默认插落卡之上', () => {
    const tasks = backlogFixture();
    const laneIds = idsOf(splitLanes(tasks, GROUPS, 'lanes')[1]!); // G-2 泳道
    // T1(G-1)拖到 G-2 泳道的 T3 上:不在同序 → 插 T3 之上 → after=T3
    expect(
      resolveDrop('T1', { type: 'card', taskId: 'T3', column: 'backlog', groupId: 'G-2' }, { tasks, laneTaskIds: laneIds }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', afterTaskId: 'T3' });
  });

  it('同列跨泳道(落列容器)→ 换组 + 列尾 afterTaskId=泳道内末卡', () => {
    const tasks = backlogFixture();
    const laneIds = idsOf(splitLanes(tasks, GROUPS, 'lanes')[1]!);
    expect(
      resolveDrop('T1', { type: 'column', column: 'backlog', groupId: 'G-2' }, { tasks, laneTaskIds: laneIds }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', afterTaskId: 'T4' });
  });

  it('over 列容器=空列 → 无锚点,仅 column+groupId(列尾无卡)', () => {
    const tasks = [
      mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: 'G-1', boardPosition: 1024 }),
      mkTask({ id: 'A1', title: '戊', status: 'assigned', groupId: 'G-1', boardPosition: 1024 }),
    ];
    // G-1 已分配列空 → A1 拖进来落列容器(无锚点)
    expect(
      resolveDrop('A1', { type: 'column', column: 'assigned', groupId: 'G-1' }, { tasks }),
    ).toEqual({ column: 'assigned', groupId: 'G-1' });
  });

  it('跨列 assigned→active → column 透传(renderer 只发落点,不定动作)', () => {
    const tasks = [
      mkTask({ id: 'A1', title: '已分配卡', status: 'assigned', groupId: null, boardPosition: 1024 }),
      mkTask({ id: 'R1', title: '运行卡', status: 'in_progress', groupId: null, boardPosition: 1024 }),
      mkTask({ id: 'R2', title: '运行卡二', status: 'in_progress', groupId: null, boardPosition: 2048 }),
    ];
    // A1 拖到 active 列容器 → 列尾 after=R2
    expect(
      resolveDrop('A1', { type: 'column', column: 'active', groupId: null }, { tasks }),
    ).toEqual({ column: 'active', groupId: null, afterTaskId: 'R2' });
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

  it('over 卡片不在目标可见序(泳道外)→ null(数据不一致防御)', () => {
    const tasks = backlogFixture();
    const laneIds = idsOf(splitLanes(tasks, GROUPS, 'lanes')[0]!); // G-1 泳道
    // over 声称 G-1 泳道的 T3,但 T3 属 G-2 → 序中查无 → null
    expect(
      resolveDrop('T2', { type: 'card', taskId: 'T3', column: 'backlog', groupId: 'G-1' }, { tasks, laneTaskIds: laneIds }),
    ).toBeNull();
  });

  it('active 任务不在 ctx.tasks → null(防御)', () => {
    expect(
      resolveDrop('T-ghost', { type: 'column', column: 'backlog', groupId: null }, { tasks: backlogFixture() }),
    ).toBeNull();
  });

  it('泳道成员集裁剪:邻居序只含目标泳道卡(跨泳道卡不参与锚点)', () => {
    const tasks = backlogFixture();
    const laneIds = new Set(['T3', 'T4']);
    // T4 拖到 T3 上(同泳道上移):seq=[T3] → after=T3、无 before(T1/T2 不得成为上邻)
    expect(
      resolveDrop('T4', { type: 'card', taskId: 'T3', column: 'backlog', groupId: 'G-2' }, { tasks, laneTaskIds: laneIds }),
    ).toEqual({ column: 'backlog', groupId: 'G-2', afterTaskId: 'T3' });
  });
});

// ── buildDropIndex / buildDropTarget:dnd over.id → 落点目标组装(纯函数)─────
describe('buildDropTarget 组装(dnd over.id 解析)', () => {
  const tasks = [
    mkTask({ id: 'T1', title: '甲', status: 'draft', groupId: 'G-2', boardPosition: 1024 }),
    mkTask({ id: 'T2', title: '乙', status: 'draft', groupId: 'G-2', boardPosition: 2048 }),
    mkTask({ id: 'U1', title: '未分组卡', status: 'draft', groupId: null, boardPosition: 1024 }),
  ];

  it('泳道模式:col: 前缀 → 列容器目标(组=泳道组 + 泳道成员集)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    const active = tasks[0]!; // G-2 卡
    const built = buildDropTarget('col:G-2:backlog', active, index, 'lanes');
    expect(built).not.toBeNull();
    expect(built!.over).toEqual({ type: 'column', column: 'backlog', groupId: 'G-2' });
    expect(built!.laneTaskIds).toEqual(new Set(['T1', 'T2']));
  });

  it('泳道模式:未分组道 groupId=null', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    const built = buildDropTarget('col:ungrouped:backlog', tasks[0]!, index, 'lanes');
    expect(built!.over).toEqual({ type: 'column', column: 'backlog', groupId: null });
  });

  it('平铺模式:col: 目标 → groupId 保 active 现组(纯排序不换组),laneTaskIds 省略(整列可见)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'flat'), 'flat');
    const active = tasks[0]!; // groupId=G-2
    const built = buildDropTarget('col:flat:backlog', active, index, 'flat');
    expect(built!.over).toEqual({ type: 'column', column: 'backlog', groupId: 'G-2' });
    expect(built!.laneTaskIds).toBeUndefined();
  });

  it('卡片 id → 卡片目标(columnOf(status) 定列,泳道组透传)', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'lanes'), 'lanes');
    const built = buildDropTarget('T2', tasks[0]!, index, 'lanes');
    expect(built!.over).toEqual({ type: 'card', taskId: 'T2', column: 'backlog', groupId: 'G-2' });
    expect(built!.laneTaskIds).toEqual(new Set(['T1', 'T2']));
  });

  it('平铺模式卡片 → groupId 保 active 现组', () => {
    const index = buildDropIndex(splitLanes(tasks, GROUPS, 'flat'), 'flat');
    const built = buildDropTarget('U1', tasks[0]!, index, 'flat');
    expect(built!.over).toEqual({ type: 'card', taskId: 'U1', column: 'backlog', groupId: 'G-2' });
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
    mkTask({ id: 'T1', title: '甲任务', status: 'draft', groupId: 'G-1', boardPosition: 1024 }),
    mkTask({ id: 'T2', title: '乙任务', status: 'in_progress', groupId: 'G-2', boardPosition: 1024 }),
    mkTask({ id: 'U1', title: '散任务', status: 'pending', groupId: null, boardPosition: 1024 }),
  ];

  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({ tasks: [], dragging: false, pendingMoveCount: 0 });
    mockApi.task.move.mockClear().mockResolvedValue(null);
  });

  it('泳道模式:组名 heading + 未分组道 + 卡片入道', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="lanes" selectedId={null} onSelect={() => {}} />);
    // heading 可访问名含计数 span,用正则匹配(组名 + 计数)
    expect(screen.getByRole('heading', { name: /前端组/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /后端组/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /未分组/ })).toBeInTheDocument();
    expect(screen.getByText(/甲任务/)).toBeInTheDocument();
    expect(screen.getByText(/乙任务/)).toBeInTheDocument();
    expect(screen.getByText(/散任务/)).toBeInTheDocument();
  });

  it('平铺模式:无泳道 heading,卡片渲染且带组 chip', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="flat" selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    // 组 chip:平铺模式卡片显示组名(BoardCanvas 内部解析 group)
    expect(screen.getByText('前端组')).toBeInTheDocument();
    expect(screen.getByText('后端组')).toBeInTheDocument();
    // 散任务无组 → 无 chip,仅卡本体
    expect(screen.getByText(/散任务/)).toBeInTheDocument();
  });

  it('泳道折叠:点击 chevron 只留 header,该泳道卡片卸载', () => {
    render(<BoardCanvas tasks={tasks} groups={groups} laneMode="lanes" selectedId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '折叠泳道 前端组' }));
    expect(screen.getByRole('heading', { name: /前端组/ })).toBeInTheDocument();
    expect(screen.queryByText(/甲任务/)).not.toBeInTheDocument();
    // 其余泳道不受影响
    expect(screen.getByText(/乙任务/)).toBeInTheDocument();
  });
});
