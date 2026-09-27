// renderer/src/components/task-board/TaskBoardView.tsx
//
// 任务看板主区（看板重构 Task 12 改造）：
//   - 顶部标题栏：SidebarRestoreButton + 标题（并发徽标在 BoardToolbar）
//   - BoardToolbar：搜索/指派人筛选（filterBoardTasks 生效）/ 泳道模式开关
//     （Task 12 接线；localStorage 持久化）/ 并发徽标 / 归档入口（Task 14 接线
//     ArchivePanel）/ 新建任务（CreateTaskDialog）
//   - BoardCanvas：DndContext 拖拽画板（泳道 splitLanes / 平铺单道；拖拽三分支
//     语义与 DragOverlay 见 BoardCanvas 头注）
//   - selectedTaskId → TaskDetailDrawer 右侧滑入抽屉叠加（主区互斥渲染退役，
//     Task 12 起画板常驻）
//
// 数据流（保持不变）：
//   - mount 时 task.store.load(workspaceId) 全生命周期拉取 + 每 5s 轮询
//     （拖拽手持/在途乐观 move 期间 store 内部自守卫跳过）
//   - group.store.load 与任务并行拉取一次（spec §6；组变更走 store 动作本地同步）
//   - 并发从本地 tasks 派生（active=in_progress / queued=assigned）；max 接
//     settings:getGlobal 的 maxConcurrentTasks，失败/缺字段 fallback 3
//   - selectedTaskId 持有在 task.store——点卡片写入，抽屉读
//
// 泳道模式默认值（spec §5.3）：无持久化偏好时有活跃组→lanes、无组→flat；
// 用户手动切换写 localStorage（纯 UI 偏好不入库），key 见 LANE_MODE_STORAGE_KEY。
// workspace 切换由父层（MiddlePanel）控制，本组件按 workspaceId prop 重 load。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';
import { filterBoardTasks } from '../../lib/board';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useAgentStore } from '../../stores/agent.store';
import { SidebarRestoreButton } from '../layout/SidebarRestoreButton';
import { CreateTaskDialog } from '../im/CreateTaskDialog';
import { BoardToolbar, type BoardConcurrency } from './BoardToolbar';
import { BoardCanvas } from './BoardCanvas';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { ArchivePanel } from './ArchivePanel';

/** 泳道模式持久化 key（spec §5.3 纯 UI 偏好） */
const LANE_MODE_STORAGE_KEY = 'kanban-lane-mode';
/** 并发上限缺省值（后端 GlobalSettings 缺 maxConcurrentTasks 字段时的 UI 兜底） */
const MAX_CONCURRENCY_FALLBACK = 3;
/** 列表轮询间隔（毫秒） */
const REFRESH_INTERVAL_MS = 5000;

type LaneMode = 'flat' | 'lanes';

/** 读持久化泳道偏好；非法值/存储不可用 → null（走派生默认） */
function readStoredLaneMode(): LaneMode | null {
  try {
    const v = window.localStorage.getItem(LANE_MODE_STORAGE_KEY);
    return v === 'lanes' || v === 'flat' ? v : null;
  } catch {
    return null;
  }
}

interface TaskBoardViewProps {
  workspaceId: string;
}

export function TaskBoardView({ workspaceId }: TaskBoardViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const load = useTaskStore((s) => s.load);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const groups = useGroupStore((s) => s.groups);
  const selectedGroupId = useGroupStore((s) => s.selectedGroupId);
  const loadGroups = useGroupStore((s) => s.load);
  const members = useAgentStore((s) => s.members);

  const [maxConcurrency, setMaxConcurrency] = useState<number>(MAX_CONCURRENCY_FALLBACK);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState<string>('all');
  /** 用户手动切换的持久化偏好；null=未表态 → 按组存在性派生默认（spec §5.3） */
  const [laneModePref, setLaneModePref] = useState<LaneMode | null>(() => readStoredLaneMode());
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const laneMode: LaneMode = laneModePref ?? (groups.length > 0 ? 'lanes' : 'flat');

  const handleLaneMode = useCallback((mode: LaneMode): void => {
    setLaneModePref(mode);
    try {
      window.localStorage.setItem(LANE_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage 不可用（极端环境）只丢偏好，不阻塞切换
    }
  }, []);

  // mount + workspaceId 变化 → 任务 load（5s 轮询）+ 组并行拉取
  useEffect(() => {
    void load(workspaceId);
    void loadGroups(workspaceId).catch(() => {
      // 组拉取失败不阻塞画板渲染——组 chip 回退不显示
    });
    const refresh = (): void => {
      void load(workspaceId);
    };
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [workspaceId, load, loadGroups]);

  // 切 workspace 清空筛选（spec §6 与 TaskSidebarPanel 同款语义）
  useEffect(() => {
    setText('');
    setAssignee('all');
  }, [workspaceId]);

  // mount 拉一次全局并发上限——失败/字段缺失都走兜底，用户改设置下次 mount 生效
  useEffect(() => {
    let cancelled = false;
    ipc.settings
      .getGlobal()
      .then((g: GlobalSettings) => {
        if (cancelled) return;
        if (g && typeof g.maxConcurrentTasks === 'number' && g.maxConcurrentTasks > 0) {
          setMaxConcurrency(g.maxConcurrentTasks);
        }
      })
      .catch(() => {
        // 静默兜底：工具栏 max 错误不阻塞任何用户操作
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 并发状态从本地 tasks 派生（active=in_progress / queued=assigned）
  const concurrency = useMemo<BoardConcurrency>(
    () => ({
      active: tasks.filter((t) => t.status === 'in_progress').length,
      queued: tasks.filter((t) => t.status === 'assigned').length,
      max: maxConcurrency,
    }),
    [tasks, maxConcurrency],
  );

  // assignee 下拉选项：当前 workspace 的 members 派生（TaskSidebarPanel 同款）
  const assigneeOptions = useMemo(
    () =>
      members
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => ({ value: a.instanceId, label: a.agentName })),
    [members, workspaceId],
  );

  // 生效的组过滤：选中组已不在活跃组集合（被归档等）→ 视为未选中，防死过滤
  const activeGroupId = useMemo(
    () =>
      selectedGroupId !== null && groups.some((g) => g.id === selectedGroupId)
        ? selectedGroupId
        : null,
    [selectedGroupId, groups],
  );

  // 搜索 + 指派人过滤（Task 9 纯函数）+ 组过滤（UX 修复）→ BoardCanvas 可见任务
  const visibleTasks = useMemo(() => {
    const base = filterBoardTasks(tasks, { text, assigneeId: assignee === 'all' ? null : assignee });
    return activeGroupId === null ? base : base.filter((t) => t.groupId === activeGroupId);
  }, [tasks, text, assignee, activeGroupId]);

  // 选中组时泳道只留该组（view 层先过滤，BoardCanvas 零改动；未分组道因任务
  // 已按组过滤自然为空，splitLanes 不产出空未分组道）
  const visibleGroups = useMemo(
    () => (activeGroupId === null ? groups : groups.filter((g) => g.id === activeGroupId)),
    [groups, activeGroupId],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏（收起时首位停靠恢复按钮） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-subtle p-3">
        <SidebarRestoreButton />
        <h2 className="text-lg font-medium">任务看板</h2>
      </div>
      <BoardToolbar
        text={text}
        onText={setText}
        assignee={assignee}
        onAssignee={setAssignee}
        assigneeOptions={assigneeOptions}
        laneMode={laneMode}
        onLaneMode={handleLaneMode}
        onOpenArchive={() => setArchiveOpen(true)}
        concurrency={concurrency}
        onCreateTask={() => setCreateOpen(true)}
      />
      <BoardCanvas
        tasks={visibleTasks}
        groups={visibleGroups}
        laneMode={laneMode}
        selectedId={selectedTaskId}
        onSelect={setSelectedTaskId}
      />
      {/* 详情抽屉叠加层：画板常驻，selectedTaskId 驱动滑入 */}
      {selectedTaskId !== null && (
        <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
      {/* 归档面板（Task 14）：工具栏归档入口打开，恢复走 task.store.unarchive */}
      <ArchivePanel
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        workspaceId={workspaceId}
      />
      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(taskId) => setSelectedTaskId(taskId)}
        workspaceId={workspaceId}
      />
    </div>
  );
}
