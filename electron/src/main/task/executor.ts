// electron/src/main/task/executor.ts
//
// TaskExecutor —— 队列放行 + kickoff 注入（spec §5，方案 B）。
//
// 职责：
//   - admitOnce：全局并发 gate（count(in_progress) < maxConcurrentTasks）
//     → 按优先级/计划时间/创建时间取队首 assigned → 校验目标 → startTask
//     → 向执行会话注入 kickoff 消息
//   - notify：写触发入口（100ms 去抖合并）——task 域写通道成功后调用
//   - start/stop：30s 兜底扫描定时器（丢失通知自愈）
//
// 设计要点：
//   - kickoff 的消息发送通过 deps.sendKickoff 注入（runtime-init 接
//     sendUserMessage）——避免 executor → im/session-service → activation →
//     executor 的 import 环
//   - admitOnce 串行互斥（admitting 标志）：并发放行不超限
//   - 每次成功放行后重查 in_progress 数（以 DB 为准，不信任内存计数）
//   - 全状态在 DB：通知只是加速器，丢了有兜底扫描（与 task-broadcast 同构）
//   - dispatcher.ts 是 2.1 未接线预留（per-agent 并发 + 直启子进程模型），
//     本模块是全新会话驱动路径，互不相干
import { getDb } from '../storage/db';
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { startTask } from './starter';
import { teamExists } from '../agent/team';
import { getSession } from '../storage/sessions/repo';
import { getGlobalSettings } from '../settings/crud';
import { logger } from '../logger';

/** kickoff 注入依赖（runtime-init 装配时注入 sendUserMessage 包装） */
export interface ExecutorDeps {
  sendKickoff(input: { sessionId: string; body: string; mentionedInstanceIds?: string[] }): Promise<void>;
  /** 测试注入全局并发上限；缺省读 global_settings */
  getGlobalMax?(): number;
  /** 兜底扫描间隔（毫秒），默认 30s */
  sweepIntervalMs?: number;
}

const DEFAULT_SWEEP_MS = 30_000;
const NOTIFY_DEBOUNCE_MS = 100;
const PRIORITY_LABEL: Record<number, string> = { 1: '低', 5: '中', 10: '高' };

export class TaskExecutor {
  private deps: ExecutorDeps | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private admitting = false;

  init(deps: ExecutorDeps): void {
    this.deps = deps;
  }

  start(): void {
    if (this.timer || !this.deps) return;
    const interval = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.timer = setInterval(() => this.safeAdmit(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  /** 写触发入口：100ms 去抖合并后立即评估放行 */
  notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.safeAdmit();
    }, NOTIFY_DEBOUNCE_MS);
    this.notifyTimer.unref?.();
  }

  private safeAdmit(): void {
    void this.admitOnce().catch((err: unknown) => {
      logger.warn('executor 放行轮异常', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** 放行一轮：串行互斥（防并发改行超限） */
  async admitOnce(): Promise<void> {
    if (!this.deps || this.admitting) return;
    this.admitting = true;
    try {
      // 末位 ?? 3 与 settings/crud 读侧默认对齐（GlobalSettings 类型上该字段可选）
      const max = this.deps.getGlobalMax?.() ?? getGlobalSettings().maxConcurrentTasks ?? 3;
      let slots = max - countInProgress();
      // 本轮已处理且未放行成功的候选：目标无效者已转 failed（自然出队），
      // startTask 抛错者仍 assigned——必须显式排除，否则同一候选会在
      // while 内被反复选中（持久性 DB 故障时热循环）
      const skipped = new Set<string>();
      while (slots > 0) {
        const candidate = peekNextAssigned(slots, skipped);
        if (!candidate) break;
        const launched = await this.launch(candidate);
        if (!launched) {
          skipped.add(candidate.id); // 本轮跳过，留给兜底扫描重试
          continue; // 目标无效转 failed 不占槽 → 继续看下一候选
        }
        slots = max - countInProgress(); // 以 DB 为准重查
      }
    } finally {
      this.admitting = false;
    }
  }

  /** 单候选放行：目标校验 → startTask → kickoff。返回是否占槽 */
  private async launch(task: TaskRow): Promise<boolean> {
    const invalid = validateTarget(task);
    if (invalid) {
      failQuietly(task.id, invalid);
      return false;
    }
    let executionSessionId: string;
    try {
      const result = await startTask(task.id, task.targetSessionId ? { executionSessionId: task.targetSessionId } : undefined);
      executionSessionId = result.executionSessionId;
    } catch (err) {
      // startTask 抛错（状态竞态 / 锁定冲突等）：留给兜底扫描重试，本轮跳过
      logger.warn('executor startTask 失败（跳过该候选）', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    try {
      await this.deps!.sendKickoff({
        sessionId: executionSessionId,
        body: buildKickoffBody(task),
        mentionedInstanceIds: task.assigneeAgentId ? [task.assigneeAgentId] : undefined,
      });
    } catch (err) {
      failQuietly(task.id, `kickoff 注入失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    logger.info('executor 已放行任务', { taskId: task.id, executionSessionId });
    return true;
  }
}

function countInProgress(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='in_progress'`)
    .get() as { n: number };
  return row.n;
}

/** 队首候选：assigned 按放行序（spec §4.4），排除本轮已处理过的失败候选 */
function peekNextAssigned(slots: number, skip: ReadonlySet<string>): TaskRow | null {
  const skipIds = [...skip];
  // 排除子句只拼接占位符（skip 内容是内部生成的任务 id，仍走参数绑定）
  const excludeClause =
    skipIds.length > 0 ? `AND id NOT IN (${skipIds.map(() => '?').join(',')})` : '';
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status='assigned' ${excludeClause}
       ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...skipIds, Math.max(slots, 1)) as Array<{ id: string }>;
  for (const r of rows) {
    const t = getTask(r.id);
    if (t && t.status === 'assigned') return t; // SELECT 与读取间竞态防御
  }
  return null;
}

/** 目标有效性校验：返回错误文案（null = 通过）。spec §9 边界表 */
function validateTarget(task: TaskRow): string | null {
  if (task.assigneeAgentId) {
    const member = getDb()
      .prepare(
        `SELECT 1 FROM workspace_agent_members WHERE instance_id = ? AND workspace_id = ?`,
      )
      .get(task.assigneeAgentId, task.workspaceId);
    if (!member) return `指派 agent 已不在工作空间: ${task.assigneeAgentId.slice(0, 12)}`;
    return null;
  }
  if (task.targetTeamId && !teamExists(task.targetTeamId)) {
    return `目标团队已解散: ${task.targetTeamId.slice(0, 12)}`;
  }
  if (task.targetSessionId && !getSession(task.targetSessionId)) {
    return `目标会话不存在: ${task.targetSessionId.slice(0, 12)}`;
  }
  // 三目标列全空（手动 transition 产出的无目标 assigned 边角）：自动放行只会
  // 静默新建会话无人接待——明示失败，用户可在 UI 看到原因
  if (!task.targetTeamId && !task.targetSessionId) {
    return '任务无委派目标，无法自动执行';
  }
  return null;
}

/** 转 failed：吞错（任务可能已被并发改态），只留日志 */
function failQuietly(taskId: string, reason: string): void {
  try {
    transitionTaskStatus(taskId, 'failed', { completedAt: Date.now(), errorMessage: reason });
    logger.warn('executor 候选转 failed', { taskId, reason });
  } catch (err) {
    logger.warn('executor 候选转 failed 失败（并发改态）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** kickoff 消息体（spec §5.4） */
export function buildKickoffBody(task: TaskRow): string {
  const lines = [`【任务启动】#${task.id} · ${task.title}`];
  if (task.description) lines.push('', task.description);
  const meta: string[] = [];
  if (PRIORITY_LABEL[task.priority]) meta.push(`优先级:${PRIORITY_LABEL[task.priority]}`);
  if (task.deadlineAt) meta.push(`截止:${new Date(task.deadlineAt).toLocaleString('zh-CN')}`);
  if (meta.length > 0) lines.push('', meta.join('　'));
  return lines.join('\n');
}

/** 模块级单例 + 写触发入口（全线统一 import 这两个） */
export const taskExecutor = new TaskExecutor();
export function notifyExecutor(): void {
  taskExecutor.notify();
}
