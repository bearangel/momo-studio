// renderer/src/components/im/TaskChip.tsx
//
// #T-XXX 任务 chip 渲染。展示任务编号 + 短标题，可点击触发跳转。
// 颜色按 status 区分；超过 12 字标题截断（hover title 显示完整文本）。
import type { TaskRow } from '../../ipc/types';

interface TaskChipProps {
  task: Pick<TaskRow, 'id' | 'title' | 'status'>;
  onClick?: (taskId: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  draft: '#888',
  pending: '#fbbf24',
  assigned: '#3b82f6',
  in_progress: '#10b981',
  paused: '#a78bfa',
  completed: '#6b7280',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

export function TaskChip({ task, onClick }: TaskChipProps) {
  const color = STATUS_COLOR[task.status] ?? '#888';
  const truncated = task.title.length > 12 ? task.title.slice(0, 12) + '...' : task.title;
  return (
    <button
      type="button"
      onClick={() => onClick?.(task.id)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 6px', borderRadius: 4,
        backgroundColor: 'rgba(0,0,0,0.2)', border: `1px solid ${color}`,
        fontSize: 12, cursor: 'pointer',
      }}
      title={task.title}
    >
      <span style={{ color }}>📌</span>
      <span style={{ color: '#ccc' }}>{task.id}</span>
      <span style={{ color: '#999', fontSize: 11 }}>{truncated}</span>
    </button>
  );
}
