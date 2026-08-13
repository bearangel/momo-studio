// renderer/src/components/task-board/TaskList.tsx
//
// 任务列表容器（D 子系统 D7）：渲染 TaskCard 列表 + 空态。
// 滚动容器 flex-1，空态居中提示。
import type { TaskRow } from '../../ipc/types';
import { TaskCard } from './TaskCard';

interface TaskListProps {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selectedId, onSelect }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        暂无任务
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {tasks.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          selected={selectedId === t.id}
          onSelect={() => onSelect(t.id)}
        />
      ))}
    </div>
  );
}
