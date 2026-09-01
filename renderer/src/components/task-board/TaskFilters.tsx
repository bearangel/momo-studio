// renderer/src/components/task-board/TaskFilters.tsx
//
// 任务筛选条（D 子系统 D7）：status / assignee / sort 三个 select。
// 受控组件——value + onChange 由 TaskBoardView 持有。
// assignee 下拉选项由父层（TaskSidebarPanel）从 agent.store.members 派生
// 后传入——保持本组件 dumb，避免与 store 直接耦合。
import type { TaskStatus } from '../../ipc/types';

export interface FilterState {
  status: 'all' | TaskStatus;
  assignee: 'all' | string;
  sort: 'priority' | 'scheduled_at' | 'created_at';
}

/** assignee 下拉单个选项；label=agentName，value=instanceId（用于与 task.assigneeAgentId 匹配） */
export interface AssigneeOption {
  value: string;
  label: string;
}

interface TaskFiltersProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
  /** assignee 下拉选项（不含「全部 agent」占位，由本组件固定渲染） */
  assigneeOptions: AssigneeOption[];
}

export function TaskFilters({ value, onChange, assigneeOptions }: TaskFiltersProps) {
  return (
    <div className="flex items-center gap-2 p-2 border-b border-border-subtle text-xs">
      <select
        value={value.status}
        onChange={(e) =>
          onChange({ ...value, status: e.target.value as FilterState['status'] })
        }
      >
        <option value="all">全部状态</option>
        <option value="draft">草稿</option>
        <option value="pending">待启动</option>
        <option value="assigned">排队中</option>
        <option value="in_progress">执行中</option>
        <option value="paused">已暂停</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
        <option value="cancelled">已取消</option>
      </select>
      <select
        value={value.assignee}
        onChange={(e) => onChange({ ...value, assignee: e.target.value })}
      >
        <option value="all">全部 agent</option>
        {assigneeOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <select
        value={value.sort}
        onChange={(e) => onChange({ ...value, sort: e.target.value as FilterState['sort'] })}
      >
        <option value="priority">按优先级</option>
        <option value="scheduled_at">按计划时间</option>
        <option value="created_at">按创建时间</option>
      </select>
    </div>
  );
}
