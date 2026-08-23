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
//   - 并发状态从本地 tasks 派生：active=in_progress 数 / queued=assigned 数 / max=3（TODO: 接 settings）
//     说明：当前 ipc.system 无 getConcurrencyStatus 通道，本地派生避免类型错误 + scope creep。
//   - selectedTaskId 持有在 task.store——侧边栏（TaskSidebarPanel）写入，本组件读。
//
// workspace 切换由父层（MiddlePanel）控制，本组件按 workspaceId prop 重 load。
import { useEffect, useMemo } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { TaskDetailPanel } from './TaskDetailPanel';

/** 全局并发上限占位（TODO: 接入 settings 全局配置） */
const MAX_CONCURRENCY = 3;
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

  // mount + workspaceId 变化 → load；定时轮询刷新
  useEffect(() => {
    void load(workspaceId);
    const refresh = (): void => {
      void load(workspaceId);
    };
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [workspaceId, load]);

  // 并发状态从本地 tasks 派生（active=in_progress / queued=assigned）
  const concurrency = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'in_progress').length;
    const queued = tasks.filter((t) => t.status === 'assigned').length;
    return { active, max: MAX_CONCURRENCY, queued };
  }, [tasks]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部状态栏：标题 + 并发/排队 */}
      <div className="flex items-center justify-between p-3 border-b border-border-subtle shrink-0">
        <h2 className="text-lg font-medium">任务看板</h2>
        <div className="text-xs text-neutral-400">
          并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
        </div>
      </div>
      {selectedTaskId ? (
        <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
          从左侧选择任务
        </div>
      )}
    </div>
  );
}
