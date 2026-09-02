// renderer/src/components/task-board/TaskBoardView.tsx
//
// 任务看板主区（P2 Task 3 拆分后）：
//   - 顶部状态栏：标题 + 并发状态（active/max + queued）
//   - 主区：selectedTaskId ? TaskDetailPanel : 空态「从左侧选择任务」
//   - TaskFilters/TaskList/新建任务入口迁至侧边栏 TaskSidebarPanel
//
// 数据流：
//   - mount 时调 task.store.load(workspaceId) 拉取任务（仅 draft/pending/assigned）
//   - 每 5s 轮询刷新一次（捕获状态变化 / 新任务）
//   - 并发状态从本地 tasks 派生：active=in_progress 数 / queued=assigned 数；
//     max 接 settings:getGlobal 返回的 maxConcurrentTasks（global_settings 表，默认 3），
//     IPC 失败/字段缺失时本地 fallback 3
//   - selectedTaskId 持有在 task.store——侧边栏（TaskSidebarPanel）写入，本组件读。
//
// workspace 切换由父层（MiddlePanel）控制，本组件按 workspaceId prop 重 load。
// v2.1 P3：样式 token 化（旧色阶 / border-border-subtle 退役）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';
import { TaskDetailPanel } from './TaskDetailPanel';

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

  const [maxConcurrency, setMaxConcurrency] = useState<number>(MAX_CONCURRENCY_FALLBACK);

  // mount + workspaceId 变化 → load；定时轮询刷新
  useEffect(() => {
    void load(workspaceId);
    const refresh = (): void => {
      void load(workspaceId);
    };
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [workspaceId, load]);

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
        // 静默兜底：状态栏 max 错误不阻塞任何用户操作
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 并发状态从本地 tasks 派生（active=in_progress / queued=assigned）
  const concurrency = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'in_progress').length;
    const queued = tasks.filter((t) => t.status === 'assigned').length;
    return { active, max: maxConcurrency, queued };
  }, [tasks, maxConcurrency]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部状态栏：标题 + 并发/排队 */}
      <div className="flex items-center justify-between p-3 border-b border-subtle shrink-0">
        <h2 className="text-lg font-medium">任务看板</h2>
        <div className="text-xs text-tertiary">
          并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
        </div>
      </div>
      {selectedTaskId ? (
        <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-tertiary text-sm">
          从左侧选择任务
        </div>
      )}
    </div>
  );
}
