// renderer/src/components/task-board/TaskBoardView.tsx
//
// 任务看板顶层视图（D 子系统 D7-D10，合并实现）：
//   - 顶部状态栏：标题 + 并发状态（active/max + queued）
//   - TaskFilters：status / assignee / sort 三 select
//   - TaskList：筛选+排序后的任务列表（TaskCard）
//   - TaskDetailPanel：选中任务时右侧侧滑详情面板
//
// 数据流：
//   - mount 时调 task.store.load(workspaceId) 拉取任务（仅 draft/pending/assigned）
//   - 每 5s 轮询刷新一次（捕获状态变化 / 新任务）
//   - 并发状态从本地 tasks 派生：active=in_progress 数 / queued=assigned 数 / max=3（TODO: 接 settings）
//     说明：当前 ipc.system 无 getConcurrencyStatus 通道，本地派生避免类型错误 + scope creep。
//
// workspace 切换由父层（MiddlePanel）控制，本组件按 workspaceId prop 重 load。
import { useEffect, useMemo, useState } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { TaskList } from './TaskList';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskFilters, type FilterState } from './TaskFilters';

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
  const [filter, setFilter] = useState<FilterState>({
    status: 'all',
    assignee: 'all',
    sort: 'priority',
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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

  // 筛选 + 排序
  const filteredTasks = useMemo(() => {
    let list = [...tasks];
    if (filter.status !== 'all') {
      list = list.filter((t) => t.status === filter.status);
    }
    if (filter.assignee !== 'all') {
      list = list.filter((t) => t.assigneeAgentId === filter.assignee);
    }
    list.sort((a, b) => {
      if (filter.sort === 'priority') {
        return b.priority - a.priority || a.createdAt - b.createdAt;
      }
      if (filter.sort === 'scheduled_at') {
        return (
          (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) -
          (b.scheduledAt ?? Number.MAX_SAFE_INTEGER)
        );
      }
      // created_at
      return a.createdAt - b.createdAt;
    });
    return list;
  }, [tasks, filter]);

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部状态栏：标题 + 并发/排队 */}
        <div className="flex items-center justify-between p-3 border-b border-border-subtle">
          <h2 className="text-lg font-medium">任务看板</h2>
          <div className="text-xs text-neutral-400">
            并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
          </div>
        </div>
        <TaskFilters value={filter} onChange={setFilter} />
        <TaskList
          tasks={filteredTasks}
          selectedId={selectedTaskId}
          onSelect={(id) => setSelectedTaskId(id)}
        />
      </div>
      {selectedTaskId && (
        <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
    </div>
  );
}
