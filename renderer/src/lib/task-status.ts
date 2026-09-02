// renderer/src/lib/task-status.ts
// 任务状态统一映射（v2.1 设计系统）：终结 TaskChip/TaskCard/DispatchChip/ToolCallChip
// 四份重复调色板。样式类与 Badge tone 完全同源，禁止在此文件外另造状态色。
import { BADGE_TONE_CLASSES, type BadgeTone } from '../components/ui/Badge';

export type TaskStatusKey =
  | 'draft'
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

const STATUS_LABEL: Record<TaskStatusKey, string> = {
  draft: '草稿',
  pending: '待分配',
  assigned: '已分配',
  in_progress: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

/** 规范 §3.6 任务状态语义映射 */
const STATUS_TONE: Record<TaskStatusKey, BadgeTone> = {
  draft: 'neutral',
  pending: 'warning',
  assigned: 'accent',
  in_progress: 'success',
  paused: 'violet',
  completed: 'neutral',
  cancelled: 'neutral',
  failed: 'error',
};

export interface TaskStatusStyle {
  label: string;
  tone: BadgeTone;
  className: string;
}

export function taskStatusStyle(status: TaskStatusKey): TaskStatusStyle {
  const tone = STATUS_TONE[status];
  return {
    label: STATUS_LABEL[status],
    tone,
    className: `inline-flex h-5 items-center rounded px-2 text-xs font-medium ${BADGE_TONE_CLASSES[tone]}`,
  };
}