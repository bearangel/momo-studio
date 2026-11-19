// electron/src/main/task/recurrence.ts
//
// 循环任务规则（spec §7）：三种预设编码 + 完成后续期生成。
//   every:Nm|Nh|Nd  间隔型——从完成时间起算
//   daily@HH:mm      每天——取严格晚于 from 的下一个时间点
//   weekly@D,HH:mm   每周（0=周日）——取严格晚于 from 的下一个时间点
// 本期不做 cron 解析（spec D5）；非法规则一律 nextRun → null（不抛错，
// spawn 侧静默跳过——规则坏了不能拖垮任务终态处理链）。
import { getDb } from '../storage/db';
import { getTask, insertTask } from '../storage/tasks/repo';
import { logger } from '../logger';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 推算下次运行时间；规则非法返回 null */
export function nextRun(from: number, rule: string): number | null {
  // 捕获组索引访问（noUncheckedIndexedAccess 下为 string | undefined）；
  // 正则匹配后必存在，?? '' 仅作 TS 兜底，运行时不触发（regex 命中）。
  const ev = /^every:(\d+)([mhd])$/.exec(rule);
  if (ev) {
    const n = parseInt(ev[1] ?? '', 10);
    if (n <= 0) return null;
    const unitMs = ev[2] === 'm' ? MINUTE : ev[2] === 'h' ? HOUR : DAY;
    return from + n * unitMs;
  }
  const dv = /^daily@(\d{1,2}):(\d{2})$/.exec(rule);
  if (dv) {
    const h = parseInt(dv[1] ?? '', 10);
    const mi = parseInt(dv[2] ?? '', 10);
    if (h > 23 || mi > 59) return null;
    const d = new Date(from);
    d.setHours(h, mi, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const wv = /^weekly@(\d),(\d{1,2}):(\d{2})$/.exec(rule);
  if (wv) {
    const wd = parseInt(wv[1] ?? '', 10);
    const h = parseInt(wv[2] ?? '', 10);
    const mi = parseInt(wv[3] ?? '', 10);
    if (wd > 6 || h > 23 || mi > 59) return null;
    const d = new Date(from);
    d.setHours(h, mi, 0, 0);
    const offset = (wd - d.getDay() + 7) % 7;
    let t = d.getTime() + offset * DAY;
    if (t <= from) t += 7 * DAY;
    return t;
  }
  return null;
}

/**
 * 完成后续期（spec §7.2）：任务带规则且已 completed → 生成下一实例。
 * failed / cancelled / 无规则 / 规则非法 → 静默跳过（链自然停止）。
 * transition 单点调用（agent-runner task-end / task-tools completeTask），
 * 天然无重复 spawn。
 *
 * 2026-11-19 归档聚合：续期成功即自动归档旧实例——已完成泳道只保留活跃
 * 实例（循环任务在看板上恒为「下一次待执行」一条），历史进归档区（按
 * recurrenceChainRoot 聚合展示）。链断分支（规则坏/无规则）不归档：最后
 * 实例留 completed 泳道作循环终点记录，用户可手动归档。
 */
export function spawnNextInstanceIfRecurring(taskId: string): void {
  const task = getTask(taskId);
  if (!task?.recurrenceRule || task.status !== 'completed') return;
  const at = nextRun(task.completedAt ?? Date.now(), task.recurrenceRule);
  if (at === null) {
    logger.warn('循环规则无法解析，链停止', { taskId, rule: task.recurrenceRule });
    return;
  }
  // 链根继承：前任的 root ?? 前任 id——恒等于链上第一个实例的 id（聚合组键）
  const chainRoot = task.recurrenceChainRoot ?? task.id;
  const next = insertTask({
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    creatorUserId: task.creatorUserId,
    sourceSessionId: task.sourceSessionId,
    assigneeAgentId: task.assigneeAgentId,
    targetTeamId: task.targetTeamId,
    targetSessionId: task.targetSessionId,
    priority: task.priority,
    recurrenceRule: task.recurrenceRule,
    status: 'assigned', // 泳道语义重构 §4.3：续期即入队，下次时间由闸门管——pending 中转退役
    scheduledAt: at,
    recurrenceParentId: task.id,
    recurrenceChainRoot: chainRoot,
    // D8 验收策略继承（2026-11-19）：巡检循环任务的下一轮保持同一策略
    autoAccept: task.autoAccept,
    // D9 会话复用（2026-11-19）：继承上一实例的执行会话——同一循环任务所有轮次
    // 共用一条会话时间线（每轮 kickoff「【任务启动】」天然成分隔符）；否则每轮
    // 新建会话会把会话列表淹没（每小时巡检 = 每天 24 条会话）
    executionSessionId: task.executionSessionId,
    // deadline 不复制（spec §7.2：绝对截止时间对下次运行无意义）
  });
  // 续期成功 → 归档旧实例（幂等：已归档不重写）。直写 UPDATE 照 task-groups
  // 级联先例；不走 updateTask（归档非状态机转移，无转态广播需求）
  const now = Date.now();
  getDb()
    .prepare(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(now, now, task.id);
  logger.info('循环任务已续期（旧实例已归档）', { parent: task.id, next: next.id, scheduledAt: at });
}
