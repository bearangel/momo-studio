// renderer/src/lib/task-status.ts
// 任务状态统一映射（v2.1 设计系统）：终结 TaskChip/TaskCard/DispatchChip/ToolCallChip
// 四份重复调色板。样式类与 Badge tone 完全同源，禁止在此文件外另造状态色。
import { BADGE_TONE_CLASSES, type BadgeTone } from '../components/ui/Badge';
import type { TaskStatus } from '../ipc/types';

// 派生自 ipc TaskStatus（types.d.ts），消除双声明漂移——禁止改回本地字面量联合
export type TaskStatusKey = TaskStatus;

const STATUS_LABEL: Record<TaskStatusKey, string> = {
  draft: '草稿',
  pending: '待分配',
  assigned: '排队中',
  session_queued: '排队中',
  in_progress: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

/**
 * 任务状态语义映射（UX 波 2 重映射：用户反馈 4 个灰无区分，目标列内零同色冲突）：
 * 灰只留 draft/cancelled；等待系（pending/session_queued）统一琥珀；
 * 活跃管线系（assigned/in_progress）统一蓝；completed 升绿、failed 保持红。
 */
const STATUS_TONE: Record<TaskStatusKey, BadgeTone> = {
  draft: 'neutral',
  pending: 'warning',
  assigned: 'accent',
  session_queued: 'warning',
  in_progress: 'accent',
  paused: 'violet',
  completed: 'success',
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

export type DispatchStatus = 'queued' | 'executing' | 'completed' | 'failed' | 'aborted' | 'delegated';

const DISPATCH_LABEL: Record<DispatchStatus, string> = {
  queued: '排队',
  executing: '执行中',
  completed: '完成',
  failed: '失败',
  aborted: '已中断',
  delegated: '已派出',
};

/** dispatch 委派状态 tone（旧 DispatchChip STATUS_CONFIG 的 hex 收敛） */
const DISPATCH_TONE: Record<DispatchStatus, BadgeTone> = {
  queued: 'neutral',
  executing: 'warning',
  completed: 'success',
  failed: 'error',
  aborted: 'warning',
  delegated: 'neutral',
};

export function dispatchStatusStyle(status: DispatchStatus): TaskStatusStyle {
  const tone = DISPATCH_TONE[status];
  return {
    label: DISPATCH_LABEL[status],
    tone,
    className: `inline-flex h-5 items-center gap-1 rounded px-2 text-xs font-medium ${BADGE_TONE_CLASSES[tone]}`,
  };
}

/**
 * 派生徽标「待收尾」（turn reconciliation spec §3.5）：任务 in_progress 且宿主会话
 * 无运行回合时的纯状态推导提示——不是状态机成员，仅与状态徽标并列展示
 * （状态仍是 in_progress 真相）。色值复用 warning tone（等待系语义），禁新造色。
 */
export const PENDING_WRAP_UP_STYLE: TaskStatusStyle = {
  label: '待收尾',
  tone: 'warning',
  className: `inline-flex h-5 items-center rounded px-2 text-xs font-medium ${BADGE_TONE_CLASSES.warning}`,
};
/**
 * 远端任务状态的安全展示（跨版本对端可能送来 TaskStatus 之外的枚举）：
 * 已知状态走 taskStatusStyle；未知回退 neutral tone + 原样文案。
 * TaskSidebarPanel 远端只读分区专用（spec D7 只读镜像）。
 */
export function remoteStatusStyle(status: string): { label: string; className: string } {
  if (STATUS_LABEL[status as TaskStatusKey] !== undefined) {
    const s = taskStatusStyle(status as TaskStatusKey);
    return { label: s.label, className: s.className };
  }
  return {
    label: status,
    className: `inline-flex h-5 items-center rounded px-2 text-xs font-medium ${BADGE_TONE_CLASSES.neutral}`,
  };
}
