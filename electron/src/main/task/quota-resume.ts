// electron/src/main/task/quota-resume.ts
//
// 配额受限自动续跑（2026-11-04 生产事故）：
// 事故链路——子 agent 429 配额错误（错误体带「已达到 … 使用上限。您的限额将在
// YYYY-MM-DD HH:mm:ss 重置。」）→ 重试 5 次耗尽 → 任务落终态 failed，重置时刻
// 已知却无人利用，leader 与用户空等 43 分钟直到人工发「继续」。
// 本模块把该类失败（QUOTA_LIMITED）转为定时自动续跑：
//   - 分类：HTTP 429 + 配额措辞（上限/配额/限额/quota）——与瞬时限流（服务繁忙、
//     无配额措辞）严格区分，后者行为不变（不自动续跑）
//   - 时刻：错误体重置时间（按本地时间解析，未来且 24h 内才可信）+30s；解析
//     失败按连续次数退避 5/15/30 分钟（垃圾/荒谬解析一律降级退避）
//   - 落库：不落终态 failed，updateTask 权威复位 assigned + scheduled_at（走既有
//     executor 放行链到点捞起；in_progress→assigned 无状态机合法转换，权威复位
//     与 dispatch-task-ledger 的 followup 复位 / 启动对账同纪律——registry/调度
//     权威决策，非任务生命周期转换）；error_message 保留配额错误文案（等待期
//     UI 显示暂停原因）
//   - 计数：routing_json 嵌套 {"quotaRetryCount":N}（零迁移；hub 路由消费方
//     parseTaskRouting 对未知形状兜底 local，两个键空间互不干扰）；连续 3 次
//     自动续跑用尽后回落既有终态 failed（人工介入）；任何非配额结局清零
//   - 通知：每次调度向任务执行会话插恰一条系统消息（与 deliverChainResult 的
//     回执行同 sender='system' 形态）
// 两个 settle 入口（dispatch-task-ledger 的 task_reply 链路 / AgentRunner 的
// task-end 链路）共用 handleQuotaFailureSettle，幂等：先到者调度，后到者按
// 行状态 no-op（assigned/session_queued = 已在排队等待续跑）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { updateTask, type TaskRow } from '../storage/tasks/repo';
import { insertMessage } from '../storage/messages/repo';
import { pushSessionMessage } from '../agent/stream-relay';
import { logger } from '../logger';

/** 连续配额自动续跑上限（第 4 次配额失败回落终态 failed——人工介入） */
export const QUOTA_RETRY_CAP = 3;

/** details 段的 429 状态标记（buildStreamErrorMessage 拼装：`HTTP <status> <body>`） */
const HTTP_429_RE = /HTTP 429\b/;

/** 配额措辞（区别于瞬时限流的服务繁忙）：中英供应商常见表述（额度/上限/配额/限额/quota） */
const QUOTA_WORDING_RE = /上限|配额|限额|额度|quota/i;

/** 重置时间句式：`将于/将在 2026-11-04 18:31:52 重置`（前缀不参与匹配，锚定 日期时间+重置） */
const RESET_TIME_RE = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*重置/;

/** 重置时间合理性窗：供应商重置均在 24h 内，超出视为垃圾解析（降级退避） */
const RESET_SANITY_WINDOW_MS = 24 * 3600_000;

/** 解析成功时的续跑延迟：重置时刻 + 30s（跨过供应商侧的准点抖动） */
const PARSED_RESUME_DELAY_MS = 30_000;

/** 解析失败退避序列：第 1/2/3 次 → 5/15/30 分钟 */
const BACKOFF_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000];

/**
 * 判定错误文本是否为配额受限（QUOTA_LIMITED）：HTTP 429 且错误体含配额措辞。
 * 瞬时限流（429 但无配额措辞）、非 429 错误（500/401 等）一律 false——行为不变。
 */
export function isQuotaLimitError(errText: string): boolean {
  return HTTP_429_RE.test(errText) && QUOTA_WORDING_RE.test(errText);
}

/**
 * 解析错误体里的重置时间为本地时间戳。不可信解析（过去 / 超 24h / 无时间句式）
 * 一律返回 null——调用方降级退避模式。
 */
export function parseQuotaResetAt(errText: string, now: number): number | null {
  const m = RESET_TIME_RE.exec(errText);
  if (!m) return null;
  const ts = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ).getTime();
  if (!Number.isFinite(ts)) return null;
  if (ts <= now || ts > now + RESET_SANITY_WINDOW_MS) return null;
  return ts;
}

/**
 * 续跑时刻：解析成功 → 重置时刻 + 30s（不随次数升级——供应商已给出准确恢复点）；
 * 解析失败 → now + 退避（按连续配额次数 5/15/30 分钟升级，越界钳到最后一档）。
 */
export function computeQuotaResumeAt(consecutiveCount: number, resetAt: number | null, now: number): number {
  if (resetAt !== null) return resetAt + PARSED_RESUME_DELAY_MS;
  const idx = Math.min(Math.max(consecutiveCount, 0), BACKOFF_DELAYS_MS.length - 1);
  return now + BACKOFF_DELAYS_MS[idx]!;
}

/** routing_json 附加键信封（与 hub 路由三选一共存于同一 JSON 对象，互不解析） */
interface QuotaEnvelope {
  quotaRetryCount?: number;
}

/** 读行上的信封（行缺失 / 非法 JSON → 空对象，永不抛） */
function readEnvelope(taskId: string): QuotaEnvelope {
  try {
    const row = getDb()
      .prepare('SELECT routing_json FROM tasks WHERE id = ?')
      .get(taskId) as { routing_json: string | null } | undefined;
    if (!row?.routing_json) return {};
    const parsed = JSON.parse(row.routing_json) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as QuotaEnvelope;
  } catch {
    return {};
  }
}

/** routing_json 原文 + 新计数 → 合并信封（保留对象上其余键，含 hub 路由键） */
function mergeRetryCount(raw: string | null, count: number): string {
  let base: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // 原 JSON 非法——丢弃重写（本模块此前必然写过合法信封，损坏即重建）
    }
  }
  return JSON.stringify({ ...base, quotaRetryCount: count });
}

/** 当前行上的连续配额续跑计数（无标记 = 0） */
export function readQuotaRetryCount(taskId: string): number {
  const n = readEnvelope(taskId).quotaRetryCount;
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
}

/**
 * 是否配额续跑排队/在途行（executor kickoff 分流判定：标记行到点放行走
 * resumeTask 的 task-driven 续跑，不走通用 kickoff 的 ephemeral 回合）。
 */
export function isQuotaResumePending(taskId: string): boolean {
  return readEnvelope(taskId).quotaRetryCount !== undefined;
}

/**
 * 清零连续配额计数（任何非配额结局：成功 / needs_input / 取消 / 判死 / 非配额
 * 失败 / 预算耗尽落终态）。幂等——无标记时 no-op（不产生写放大）。
 */
export function resetQuotaRetryCount(taskId: string): void {
  const env = readEnvelope(taskId);
  if (env.quotaRetryCount === undefined) return;
  const raw = getDb()
    .prepare('SELECT routing_json FROM tasks WHERE id = ?')
    .get(taskId) as { routing_json: string | null } | undefined;
  if (!raw) return;
  let cleaned: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.routing_json ?? '') as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      cleaned = parsed as Record<string, unknown>;
    }
  } catch {
    // 非法原文——按空对象处理
  }
  delete cleaned.quotaRetryCount;
  updateTask(taskId, { routingJson: JSON.stringify(cleaned) });
}

/** handleQuotaFailureSettle 的三态结果 */
export type QuotaSettleOutcome = 'scheduled' | 'pending' | 'fallthrough';

/**
 * 配额失败的统一调度入口（两个 settle 钩子共用）：
 *   - 行 in_progress 且预算未耗尽 → 权威复位 assigned + scheduled_at + 计数 +1
 *     + 会话系统通知，返回 'scheduled'（调用方不得再落终态）
 *   - 行已 assigned/session_queued → 另一入口先到已调度，返回 'pending'
 *     （调用方 no-op，防覆盖 / 防重复通知）
 *   - 其余（预算耗尽 / 行处于既非运行也非排队的态）→ 'fallthrough'，调用方
 *     走原有终态 failed 路径
 * 只认 in_progress 为可调度起点（失败发生在运行中；failed 终态不可转出，
 * paused=needs_input 等待人工，均不该被自动续跑覆盖）。
 */
export function handleQuotaFailureSettle(taskId: string, row: TaskRow, errText: string): QuotaSettleOutcome {
  if (row.status !== 'in_progress') {
    return row.status === 'assigned' || row.status === 'session_queued' ? 'pending' : 'fallthrough';
  }
  const count = readQuotaRetryCount(taskId);
  if (count >= QUOTA_RETRY_CAP) return 'fallthrough';
  const now = Date.now();
  const due = computeQuotaResumeAt(count, parseQuotaResetAt(errText, now), now);
  const nextCount = count + 1;
  updateTask(taskId, {
    status: 'assigned',
    scheduledAt: due,
    errorMessage: errText.slice(0, 200),
    routingJson: mergeRetryCount(row.routingJson ?? null, nextCount),
  });
  insertQuotaResumeNotice(row, due, nextCount);
  logger.info('配额受限：任务已排自动续跑（既有 executor 放行链到点捞起）', {
    taskId,
    due,
    retryCount: nextCount,
  });
  return 'scheduled';
}

/**
 * 调度时向任务执行会话插恰一条系统通知（与 deliverChainResult 回执行同
 * sender='system' + streamSessionId 单点生成形态；失败只 warn 不影响调度——
 * 账本韧性纪律）。
 */
function insertQuotaResumeNotice(row: TaskRow, dueAt: number, retryCount: number): void {
  const sessionId = row.executionSessionId ?? row.sourceSessionId;
  if (!sessionId) {
    logger.warn('配额续跑通知跳过：任务行无执行/来源会话', { taskId: row.id });
    return;
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date(dueAt);
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const body =
    `【配额受限自动续跑】任务 #${row.id} · ${row.title} 因模型配额上限暂停，` +
    `将于 ${hhmm} 自动续跑（第 ${retryCount}/${QUOTA_RETRY_CAP} 次）。`;
  try {
    const message = insertMessage({
      sessionId,
      sender: 'system',
      eventType: 'm.room.message',
      body,
      taskId: row.id,
      streamSessionId: randomUUID(),
    });
    pushSessionMessage(message);
  } catch (err) {
    logger.warn('配额续跑通知落库失败（不影响调度）', {
      taskId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
