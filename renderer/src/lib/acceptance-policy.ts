// renderer/src/lib/acceptance-policy.ts
//
// 验收策略推断单源（2026-11-19 D8）：任务的验收方式 = 任务属性，而非全局流程。
//   巡检/循环任务（每小时查邮件等）→ 自动验收（auto_accept=1）：完成即结束、
//   零打扰、失败才提醒；交付型一次性任务 → 人工验收（两段式）。
// 推断规则：带循环规则（recurrenceRule 非空）→ auto；否则 manual。
// 与 electron/src/main/task/acceptance-policy.ts 同语义双实现（跨 workspace
// 源码不可共享——两侧单测锁同一矩阵）。UI 缺省值 / create_task 工具缺省 /
// 续期继承都以本判定为单源；用户显式选择永远覆盖推断。
import type { TaskRow } from '../ipc/types';

/** 推断默认验收策略：循环 → 自动验收；一次性 → 人工验收 */
export function inferAutoAccept(recurrenceRule: string | null): boolean {
  return recurrenceRule !== null && recurrenceRule.trim() !== '';
}

/** 任务行的验收策略显示值（autoAccept 列直读；历史行缺省 manual） */
export function acceptancePolicyOf(task: Pick<TaskRow, 'autoAccept' | 'recurrenceRule'>): 'auto' | 'manual' {
  return task.autoAccept ? 'auto' : 'manual';
}
