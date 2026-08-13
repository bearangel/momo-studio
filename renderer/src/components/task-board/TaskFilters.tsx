// renderer/src/components/task-board/TaskFilters.tsx
//
// 任务筛选条（D 子系统 D7）：status / assignee / sort 三个 select。
// 受控组件——value + onChange 由 TaskBoardView 持有。
// assignee 下拉目前只放"全部 agent"占位（TODO: 后续从 agent store 拉列表）。
import type { TaskStatus } from '../../ipc/types';

export interface FilterState {
  status: 'all' | TaskStatus;
  assignee: 'all' | string;
  sort: 'priority' | 'scheduled_at' | 'created_at';
}

interface TaskFiltersProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function TaskFilters({ value, onChange }: TaskFiltersProps) {
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
        {/* TODO: 从 agent store 拉指派列表动态填充 */}
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
