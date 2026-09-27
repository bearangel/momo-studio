// renderer/src/components/task-board/TaskBoardView.tsx
//
// 任务看板主区（看板重构 Task 11 改造）：
//   - 顶部标题栏：SidebarRestoreButton + 标题（并发徽标迁入 BoardToolbar）
//   - BoardToolbar：搜索/指派人筛选（filterBoardTasks 生效）/ 分组开关（disabled，
//     Task 12）/ 并发徽标 / 归档（disabled，Task 14）/ 新建任务（CreateTaskDialog）
//   - 平铺画板：BOARD_COLUMNS 五列横排（列宽 ~232px，横向滚动），任务按
//     column.statuses 分桶进列；平铺模式卡片带组 chip（group.store 解析）
//
// 数据流（保持不变）：
//   - mount 时 task.store.load(workspaceId) 全生命周期拉取 + 每 5s 轮询
//   - group.store.load 与任务并行拉取一次（spec §6；组变更走 store 动作本地同步）
//   - 并发从本地 tasks 派生（active=in_progress / queued=assigned）；max 接
//     settings:getGlobal 的 maxConcurrentTasks，失败/缺字段 fallback 3
//   - selectedTaskId 持有在 task.store——点卡片写入，主区渲染 TaskDetailPanel
//     （右侧滑出抽屉是 Task 12，当前沿用主区面板避免中间态断档）
//
// 本任务静态渲染边界：laneMode 恒 'flat'（开关 disabled）、无拖拽（Task 12）。
// workspace 切换由父层（MiddlePanel）控制，本组件按 workspaceId prop 重 load。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';
import { BOARD_COLUMNS } from '../../ipc/board-columns';
import { filterBoardTasks } from '../../lib/board';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useAgentStore } from '../../stores/agent.store';
import { TaskDetailPanel } from './TaskDetailPanel';
import { SidebarRestoreButton } from '../layout/SidebarRestoreButton';
import { CreateTaskDialog } from '../im/CreateTaskDialog';
import { BoardToolbar, type BoardConcurrency } from './BoardToolbar';
import { BoardColumn } from './BoardColumn';
import type { BoardGroupChip } from './BoardCard';

/** 并发上限缺省值（后端 GlobalSettings 缺 maxConcurrentTasks 字段时的 UI 兜底） */
const MAX_CONCURRENCY_FALLBACK = 3;
/** 列表轮询间隔（毫秒） */
const REFRESH_INTERVAL_MS = 5000;

interface TaskBoardViewProps {
  workspaceId: string;
}

export function TaskBoardView({ workspaceId }: TaskBoardViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const load = useTaskStore((s) => s.load);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const groups = useGroupStore((s) => s.groups);
  const loadGroups = useGroupStore((s) => s.load);
  const members = useAgentStore((s) => s.members);

  const [maxConcurrency, setMaxConcurrency] = useState<number>(MAX_CONCURRENCY_FALLBACK);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState<string>('all');
  /** 视图模式：本任务恒 'flat'（开关 disabled），Task 12 接泳道后开放切换 */
  const [laneMode] = useState<'flat' | 'lanes'>('flat');
  const [createOpen, setCreateOpen] = useState(false);

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

  // 搜索 + 指派人过滤（Task 9 纯函数）；组 chip 解析表（平铺模式专用）
  const visibleTasks = useMemo(
    () => filterBoardTasks(tasks, { text, assigneeId: assignee === 'all' ? null : assignee }),
    [tasks, text, assignee],
  );
  const chipByGroup = useMemo(() => {
    const map = new Map<string, BoardGroupChip>();
    for (const g of groups) map.set(g.id, { name: g.name, color: g.color });
    return map;
  }, [groups]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏（收起时首位停靠恢复按钮） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-subtle p-3">
        <SidebarRestoreButton />
        <h2 className="text-lg font-medium">任务看板</h2>
      </div>
      {selectedTaskId ? (
        // 点卡片仍走现状主区 TaskDetailPanel；右侧滑出抽屉 Task 12 接线
        <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      ) : (
        <>
          <BoardToolbar
            text={text}
            onText={setText}
            assignee={assignee}
            onAssignee={setAssignee}
            assigneeOptions={assigneeOptions}
            laneMode={laneMode}
            onLaneMode={() => {
              // Task 12 接线：开关 disabled 期间不可达，保持受控签名完整
            }}
            onOpenArchive={() => {
              // Task 14 接线：ArchivePanel 入口，按钮 disabled 期间不可达
            }}
            concurrency={concurrency}
            onCreateTask={() => setCreateOpen(true)}
          />
          {/* 平铺画板：五列横排 + 横向滚动（mockup 基线 ~232px 列宽） */}
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {BOARD_COLUMNS.map((column) => (
              <BoardColumn
                key={column.key}
                column={column}
                tasks={visibleTasks.filter((t) => column.statuses.includes(t.status))}
                selectedId={selectedTaskId}
                onSelect={(id) => setSelectedTaskId(id)}
                groupChipOf={(t) =>
                  laneMode === 'flat' && t.groupId !== null
                    ? (chipByGroup.get(t.groupId) ?? null)
                    : null
                }
              />
            ))}
          </div>
        </>
      )}
      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(taskId) => setSelectedTaskId(taskId)}
        workspaceId={workspaceId}
      />
    </div>
  );
}
