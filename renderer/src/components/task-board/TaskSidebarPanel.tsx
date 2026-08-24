// renderer/src/components/task-board/TaskSidebarPanel.tsx
//
// 看板侧边栏面板（P2 Task 3）：TaskFilters + TaskList + 新建任务按钮从
// TaskBoardView 整体迁入。选中态与筛选逻辑与主区解耦——
//   - 任务数据/选中态走 task.store（TaskBoardView 主区负责 load + 5s 轮询）
//   - 筛选/排序 state 本地持有（原 TaskBoardView filteredTasks useMemo 等价迁移）
//   - 新建任务复用 CreateTaskDialog（与 IM 输入条 📌 入口同源），创建后自动选中
import { useMemo, useState } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentStore } from '../../stores/agent.store';
import { CreateTaskDialog } from '../im/CreateTaskDialog';
import { TaskList } from './TaskList';
import { TaskFilters, type FilterState, type AssigneeOption } from './TaskFilters';

export function TaskSidebarPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const assignments = useAgentStore((s) => s.assignments);
  const [filter, setFilter] = useState<FilterState>({
    status: 'all',
    assignee: 'all',
    sort: 'priority',
  });
  const [createOpen, setCreateOpen] = useState(false);

  // assignee 下拉选项：从当前 workspace 的 assignment 派生
  // （label=agentName 优先，回退 agentUserId，最后 instanceId——确保至少有可读名）
  const assigneeOptions = useMemo<AssigneeOption[]>(
    () =>
      assignments
        .filter((a) => (workspace ? a.workspaceId === workspace.id : true))
        .map((a) => ({
          value: a.instanceId,
          label: a.agentName ?? a.agentUserId ?? a.instanceId,
        })),
    [assignments, workspace],
  );

  // 筛选 + 排序（自 TaskBoardView 原样迁移）
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
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0">
        <span className="text-sm font-medium text-neutral-200">任务</span>
        {/* 无 workspace 时 CreateWorkspaceDialog 无宿主，禁用入口避免死按钮 */}
        <button
          type="button"
          aria-label="新建任务"
          title="新建任务"
          onClick={() => setCreateOpen(true)}
          disabled={!workspace}
          className="text-neutral-400 hover:text-neutral-100 disabled:opacity-40 disabled:hover:text-neutral-400 text-sm px-1 rounded"
        >
          ＋
        </button>
      </div>
      <TaskFilters value={filter} onChange={setFilter} assigneeOptions={assigneeOptions} />
      <TaskList
        tasks={filteredTasks}
        selectedId={selectedTaskId}
        onSelect={(id) => setSelectedTaskId(id)}
      />
      {workspace && (
        <CreateTaskDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(taskId) => setSelectedTaskId(taskId)}
          workspaceId={workspace.id}
        />
      )}
    </div>
  );
}
