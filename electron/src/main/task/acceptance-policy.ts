// electron/src/main/task/acceptance-policy.ts
//
// 验收策略推断单源（2026-11-19 D8）——与 renderer/src/lib/acceptance-policy.ts
// 同语义双实现（跨 workspace 源码不可共享，两侧单测锁同一矩阵）。
// 主进程消费点：create_task 工具缺省（task-tools）、task:create 表单缺省
// （ipc.handlers）、循环续期继承（recurrence）。

/** 推断默认验收策略：循环 → 自动验收；一次性 → 人工验收 */
export function inferAutoAccept(recurrenceRule: string | null | undefined): boolean {
  return typeof recurrenceRule === 'string' && recurrenceRule.trim() !== '';
}

/** create_task 工具的 acceptancePolicy 字符串 → auto_accept 布尔（异形收敛按推断） */
export function parseAcceptancePolicy(
  policy: unknown,
  recurrenceRule: string | null | undefined,
): boolean {
  if (policy === 'auto') return true;
  if (policy === 'manual') return false;
  return inferAutoAccept(recurrenceRule);
}
