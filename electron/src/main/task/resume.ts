// electron/src/main/task/resume.ts
//
// v2.6.0 任务断点续跑——启动期清扫与恢复编排。
//
// 模块结构：
//   - sweepStaleStreaming（Task 3 落）：boot 陈旧流清扫，App 崩溃路径兜底
//   - detectInterrupted（Task 5 落）：启动恢复卡渲染数据源；命中 in_progress/
//     assigned 任务，按 spec §5.6 字段（taskId/title/status/agentName/
//     journalCount/streamSessionId）返回
//   - resumeTask（Task 5 落）：断点续跑派发——定位断点流 → rebuildTurn →
//     组 TaskConfig（含 resume 载荷 + 复用 streamSessionId）→ 既有 executor
//     派发路径（AgentRunner.executeTask + registerLane）→ 车道检查通过后
//     才把消息行翻回 streaming（审查修复：失败路径不滞留 streaming 行）
//   - notifyExecutor / registerLane / AgentRunner.executeTask 由既有模块承担
//     ——「既有 executor 派发路径，maxConcurrentTasks 天然生效」靠任务行已
//     in_progress 且车道 DB 兜底已占道，slot accounting 自然正确（spec §5.4）
//
// 多路 status 语义（D6：检测时不改任务状态）：
//   - in_progress → 断点续跑（rebuildTurn + resume 载荷）
//   - assigned / session_queued → 全新执行（notifyExecutor 触发 executor 放行
//     链路——并发闸 + 队列序 + kickoff 天然生效）
//   - 其余状态（completed/failed/cancelled/draft/pending）→ 抛错（不该走恢复）

import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import {
  updateMessageStatus,
  getLatestMessageByStreamSessionId,
} from '../storage/messages/repo';
import { aggregateTextDeltas } from '../storage/messages/events-repo';
import { getEventBuffer } from '../agent/stream-relay';
import { listTasks, getTask, type TaskRow } from '../storage/tasks/repo';
import { rebuildTurn } from '../agent/turn-reconstructor';
import { agentRunners } from '../agent/runtime-registry';
import { ensureMemberRuntime } from '../agent/start-chain';
import { registerLane, getLane, clearLaneIfMatch } from '../agent/session-lane';
import { getTeamLeaderInstanceId } from '../agent/team';
import { getJournalStore } from '../journal/recorder';
import type { TaskConfig as AgentTaskConfig } from '../agent/agent-runner';

/**
 * 陈旧 streaming 消息的统一中文错误文案（final 事件 payload.error）。
 * 导出常量供 UI / 恢复链引用——避免文案漂移。
 */
export const STALE_STREAM_ERROR = '进程中断';

/** detectInterrupted 返回条目（spec §5.6） */
export interface InterruptedTaskInfo {
  taskId: string;
  title: string;
  status: 'in_progress' | 'assigned' | 'session_queued';
  /** agent 显示名；workspace_agent_members JOIN agent_definitions.name */
  agentName: string;
  /** v2.5 变更账本条目数（journalEntries where task_id = X） */
  journalCount: number;
  /** 断点流 base id（剥 #roll 后缀）；assigned/session_queued 无流时为空串 */
  streamSessionId: string;
}

/**
 * 清扫 messages 表中滞留 status='streaming' 的行（App 崩溃 / 强制 kill 未
 * 经 finalizeStreamOnCrash 正常收尾的兜底）。每行：聚合 text_delta 写回 body
 * → 标 failed → 追加 final 事件「进程中断」。返回实际清扫行数。
 *
 * 错误隔离：单行收尾失败 log warn 跳过继续；SELECT 失败（DB 未就绪）整体
 * 返回 0 不抛错——调用方是 boot 链，绝不阻断启动。
 */
export function sweepStaleStreaming(): number {
  let staleIds: string[];
  try {
    const rows = getDb()
      .prepare(`SELECT id FROM messages WHERE status = 'streaming'`)
      .all() as Array<{ id: string }>;
    staleIds = rows.map((r) => r.id);
  } catch (err) {
    // DB 未就绪（boot 早于迁移等极端时序）——本次启动跳过清扫，行留待下次；
    // 绝不抛出（调用方是 boot 链）
    logger.warn('陈旧 streaming 消息扫描失败（本次启动跳过清扫）', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let swept = 0;
  for (const id of staleIds) {
    try {
      // 与 finalizeStreamOnCrash 同契约：正文聚合回写（body 单一真相源）
      updateMessageStatus(id, 'failed', aggregateTextDeltas(id));
      getEventBuffer().append({
        messageId: id,
        eventType: 'final',
        payload: { status: 'failed', error: STALE_STREAM_ERROR },
      });
      swept += 1;
    } catch (err) {
      // 单行失败不阻断其余行（下一行可能属于另一个会话/任务）
      logger.warn('陈旧 streaming 消息收尾失败（继续处理其余行）', {
        messageId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // boot 时序：立即落盘——不等下一 append/50ms 窗口（其后可能长期无写入）
  getEventBuffer().flush();
  return swept;
}

/**
 * 定位执行会话的断点流 base id（spec §5.3 车道串行性：同会话同时仅一活跃流）。
 *
 * 查询条件：
 *   - session_id = executionSessionId（任务执行会话）
 *   - stream_session_id IS NOT NULL（agent 流式行；owner 手输行 stream=NULL 排除）
 *   - parent_stream_session_id IS NULL（仅顶层流；dispatch 子流天然排除）
 *   - segment_of IS NULL（排除 #seg 分段快照行）
 * 按 created_at DESC 取最新一行；剥 stream_session_id 的 #roll{n} 后缀回 base id
 * （T1 报告 Concern #2：rebuildTurn 精确等值匹配 base 行）。
 */
function resolveBreakpointStreamId(executionSessionId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT stream_session_id FROM messages
       WHERE session_id = ?
         AND stream_session_id IS NOT NULL
         AND parent_stream_session_id IS NULL
         AND segment_of IS NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(executionSessionId) as { stream_session_id: string } | undefined;
  if (!row?.stream_session_id) return null;
  // 剥 #roll{n} 后缀（message_roll 换行产生的后缀行带 #，rebuildTurn 按 base 匹配）
  const hashIdx = row.stream_session_id.indexOf('#');
  return hashIdx === -1 ? row.stream_session_id : row.stream_session_id.slice(0, hashIdx);
}

/**
 * 解析任务的执行 agent assignmentId。
 *
 * 优先级：
 *   1) 任务行 assigneeAgentId（最常见：手动指派 / executor 放行路径）
 *   2) targetTeamId → 团队 leaderInstanceId（团队任务 kickoff 接待路由）
 *   3) 断点流 agentUserId → workspace_agent_members.instance_id（兜底：能从
 *      断点流的 message sender 反查实例——team 任务 leader 改了 / 历史流无
 *      assignee 时仍可定位）
 * 全部缺失抛错。
 */
function resolveAssignmentId(task: TaskRow, breakpointSsId: string | null): string {
  if (task.assigneeAgentId) return task.assigneeAgentId;
  if (task.targetTeamId) {
    const leader = getTeamLeaderInstanceId(task.targetTeamId);
    if (leader) return leader;
  }
  if (breakpointSsId) {
    // 兜底：断点流的 owner（agent user id）→ workspace_agent_members.instance_id
    const row = getDb()
      .prepare(
        `SELECT wam.instance_id FROM messages m
         JOIN workspace_agent_members wam
           ON wam.agent_user_id = m.sender AND wam.workspace_id = ?
         WHERE m.stream_session_id = ?
           AND m.parent_stream_session_id IS NULL
           AND m.segment_of IS NULL
         ORDER BY m.created_at DESC LIMIT 1`,
      )
      .get(task.workspaceId, breakpointSsId) as { instance_id: string } | undefined;
    if (row?.instance_id) return row.instance_id;
  }
  throw new Error(
    `task ${task.id} 无法解析执行 agent（assignee/targetTeam/断点流 agent 皆缺失）`,
  );
}

/**
 * 启动恢复卡数据源：列出全部可恢复任务（in_progress / assigned / session_queued）。
 *
 * 字段语义：
 *   - taskId / title / status：直接透传任务行
 *   - agentName：JOIN agent_definitions.name；取不到时退回 instance_id
 *     （罕见：def 被删 / builtin YAML 加载失败）
 *   - journalCount：v2.5 变更账本条目数（journal_entries.task_id = X 计数）；
 *     store 未注入时降级 0（不阻断检测）
 *   - streamSessionId：in_progress 才定位断点流；assigned/session_queued 空串
 *     （无 execution_session / 无流事件）
 *
 * D6：检测时**不改任务状态**——卡片是唯一闸门；scheduler 边界回归锁在测试侧固化。
 */
export function detectInterrupted(): InterruptedTaskInfo[] {
  const rows = listTasks({ status: ['in_progress', 'assigned', 'session_queued'] });
  const store = getJournalStore();
  const result: InterruptedTaskInfo[] = [];
  for (const task of rows) {
    const agentName = resolveAgentName(task);
    const journalCount = store
      ? store.listByTask(task.workspaceId, task.id).length
      : 0;
    const streamSessionId = task.executionSessionId
      ? (resolveBreakpointStreamId(task.executionSessionId) ?? '')
      : '';
    result.push({
      taskId: task.id,
      title: task.title,
      status: task.status as InterruptedTaskInfo['status'],
      agentName,
      journalCount,
      streamSessionId,
    });
  }
  return result;
}

/** workspace_agent_members JOIN agent_definitions 取 agent 展示名 */
function resolveAgentName(task: TaskRow): string {
  // 优先 assigneeAgentId → JOIN def 取 name
  if (task.assigneeAgentId) {
    const row = getDb()
      .prepare(
        `SELECT d.name FROM workspace_agent_members wam
         JOIN agent_definitions d ON d.id = wam.agent_definition_id
         WHERE wam.instance_id = ?`,
      )
      .get(task.assigneeAgentId) as { name: string } | undefined;
    if (row?.name) return row.name;
  }
  // team 任务：无 assignee 但有 target_team_id 时取 leader 的 def.name
  if (task.targetTeamId) {
    const leader = getTeamLeaderInstanceId(task.targetTeamId);
    if (leader) {
      const row = getDb()
        .prepare(
          `SELECT d.name FROM workspace_agent_members wam
           JOIN agent_definitions d ON d.id = wam.agent_definition_id
           WHERE wam.instance_id = ?`,
        )
        .get(leader) as { name: string } | undefined;
      if (row?.name) return row.name;
    }
  }
  // 兜底：断点流 sender → JOIN 取名（罕见边角）
  if (task.executionSessionId) {
    const ssId = resolveBreakpointStreamId(task.executionSessionId);
    if (ssId) {
      const row = getDb()
        .prepare(
          `SELECT d.name FROM messages m
           JOIN workspace_agent_members wam
             ON wam.agent_user_id = m.sender AND wam.workspace_id = ?
           JOIN agent_definitions d ON d.id = wam.agent_definition_id
           WHERE m.stream_session_id = ?
             AND m.parent_stream_session_id IS NULL
             AND m.segment_of IS NULL
           ORDER BY m.created_at DESC LIMIT 1`,
        )
        .get(task.workspaceId, ssId) as { name: string } | undefined;
      if (row?.name) return row.name;
    }
  }
  return ''; // 没有任何解析路径（def 已被删等边角）——空串而非抛错，UI 兜底
}

/**
 * 恢复任务——根据 status 多路（spec §5.4）：
 *   - in_progress → 断点续跑（rebuildTurn + resume 载荷 + 复用 streamSessionId）
 *   - assigned / session_queued → 全新执行（notifyExecutor 触发既有 executor 放行）
 *
 * in_progress 路径返回值含 streamSessionId（base id，给 UI 做后续 SSE 关联）；
 * assigned/session_queued 返回空串（无可复用流；新 stream 在 executor 放行后才分配）。
 *
 * 派发链路：resolveAssignmentId → ensureMemberRuntime（runner 不在 Map 时拉起）
 * → agentRunners.get → 组成 AgentTaskConfig{resume,...} → 车道检查（异流占用 /
 * 同流双恢复双拒绝）→ 消息行翻回 streaming → registerLane（占道 + 防 steer
 * 误派）→ runner.executeTask。
 *
 * 不改任务状态（D6：检测卡片是唯一闸门；恢复链路也不改——in_progress 保持，
 * 任务终态由 AgentRunner 的 task-end 处理，与既有 task-driven 路径同语义）。
 *
 * @throws task 不存在 / status 不可恢复 / 无法解析 assignmentId / runner 拉起失败
 *   / 执行会话被异流占用 / 该任务已在恢复中（同流重复恢复）
 */
export async function resumeTask(taskId: string): Promise<{ streamSessionId: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);

  // assigned / session_queued → 全新执行：交给既有 executor 放行（并发闸 + 队列
  // 序 + kickoff 全部天然生效）。notifyExecutor 内部 100ms 去抖合并，丢了有 30s
  // 兜底扫描自愈；本函数不 await executor 完成（executor.launch 是 fire-and-forget
  // 异步路径，不阻塞 IPC 响应）。
  if (task.status === 'assigned' || task.status === 'session_queued') {
    const { notifyExecutor } = await import('./executor');
    notifyExecutor();
    logger.info('resumeTask：assigned/session_queued 任务交由既有 executor 放行', { taskId });
    return { streamSessionId: '' };
  }

  if (task.status !== 'in_progress') {
    throw new Error(`task ${taskId} 不可恢复：status=${task.status}`);
  }
  if (!task.executionSessionId) {
    throw new Error(`task ${taskId} 已 in_progress 但 executionSessionId 缺失，无法恢复`);
  }

  // 定位断点流（base id，剥 #roll 后缀）
  const breakpointSsId = resolveBreakpointStreamId(task.executionSessionId);

  // 决议执行 agent（assignee > team leader > 断点流 agent 兜底）
  const assignmentId = resolveAssignmentId(task, breakpointSsId);

  // 确保 runner 就位（ensureMemberRuntime 内部幂等；runner 缺失时按 start 链拉起）
  await ensureMemberRuntime(assignmentId);
  const runner = agentRunners.get(assignmentId);
  if (!runner) {
    throw new Error(`resumeTask：runner 拉起失败（instance=${assignmentId}）`);
  }

  let cfg: AgentTaskConfig;
  let streamSessionIdForReturn: string;

  if (breakpointSsId) {
    // 有断点流：rebuildTurn 重建段 + 复用 streamSessionId
    const rebuilt = rebuildTurn(breakpointSsId);
    // body 兜底：重建段首条 user 文本 → 否则任务 description → 否则 title
    const firstUserMsg = rebuilt.messages.find((m) => m.role === 'user')?.content;
    const body = firstUserMsg ?? task.description ?? task.title;
    cfg = {
      taskId: task.id,
      executionSessionId: task.executionSessionId,
      body,
      streamSessionId: breakpointSsId,
      resume: {
        messages: rebuilt.messages,
        toolCallsUsed: rebuilt.toolCallsUsed,
        steers: rebuilt.steers,
        degenerate: rebuilt.degenerate,
      },
    };
    streamSessionIdForReturn = breakpointSsId;
    logger.info('resumeTask：in_progress 任务断点续跑派发', {
      taskId,
      streamSessionId: breakpointSsId,
      rebuiltMsgCount: rebuilt.messages.length,
      toolCallsUsed: rebuilt.toolCallsUsed,
      steerCount: rebuilt.steers.length,
    });
  } else {
    // 无断点流：任务 in_progress 但 agent 从未输出（如 kickoff 注入与崩溃之间）
    // 新分配 streamSessionId + 走正常回合（无 resume 载荷 = runChatLoop 当作全新回合）
    const newSsId = randomUUID();
    cfg = {
      taskId: task.id,
      executionSessionId: task.executionSessionId,
      body: task.description ?? task.title,
      streamSessionId: newSsId,
    };
    streamSessionIdForReturn = newSsId;
    logger.info('resumeTask：in_progress 但无断点流，按全新回合派发', {
      taskId,
      streamSessionId: newSsId,
    });
  }

  // 车道并发保护：若同会话已有别的活跃流（手输快速消息等），拒绝派发避免串行性破坏
  const lane = getLane(task.executionSessionId);
  if (lane && lane.streamSessionId !== cfg.streamSessionId) {
    throw new Error(
      `resumeTask：执行会话 ${task.executionSessionId} 已被另一活跃流占用（stream=${lane.streamSessionId}）`,
    );
  }
  // 双恢复守卫：同流已在本进程占道（首次 resumeTask 已 registerLane + executeTask、
  // 流未收尾）→ 二次恢复会给同一 child 发双 task-config 跑双 chat loop，必须拒绝。
  // registerLane 先于 executeTask 且收尾时 clearLaneIfMatch 清道，故同流 lane 命中
  // 即等价「该任务已在恢复中」。
  if (lane && lane.streamSessionId === cfg.streamSessionId) {
    throw new Error(`resumeTask：该任务已在恢复中（stream=${cfg.streamSessionId}），勿重复恢复`);
  }
  // 翻回 streaming 后置到车道检查之后、registerLane/executeTask 之前——
  // 异流占用 / 双恢复 / runner 拉起失败等拒绝路径不再遗留滞留 streaming 的消息行
  if (breakpointSsId) {
    flipMessageBackToStreaming(breakpointSsId);
  }
  // 注册车道（占道 + 防后续 steer 误派入本流）。
  // 顺序与 router-service.routeUserChat 相反（其 executeTask 成功后才
  // registerLane）：resume 的 streamSessionId 是预先复用的断点 base id，
  // 必须先占道才能让上方「双恢复守卫」在 executeTask 的 await 窗口内立即
  // 生效——后置注册则两次 resumeTask 可在同一条流上并发派发双 task-config。
  // 代价：executeTask 同步抛错时无收尾方清道，下方 catch 必须补偿。
  registerLane(
    task.executionSessionId,
    {
      taskId: task.id,
      streamSessionId: cfg.streamSessionId,
      assignmentId,
    },
    { kickoff: true },
  );

  try {
    await runner.executeTask(cfg);
  } catch (err) {
    // C1 补偿（对照 router-service：其 registerLane 后置于成功路径故无需补偿）：
    // executeTask 同步抛错（warmPool.acquire spawn ENOENT 等）时流必然不会
    // 产生任何 chunk、也没有收尾方调 clearLaneIfMatch——不补偿则车道永久
    // 占道，该会话死锁至重启。
    clearLaneIfMatch(task.executionSessionId, cfg.streamSessionId);
    if (breakpointSsId) {
      rollbackMessageFromStreaming(
        breakpointSsId,
        `恢复派发失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  return { streamSessionId: streamSessionIdForReturn };
}

/**
 * 把中断流的最新消息行翻回 streaming（spec §5.4：恢复时翻回）。
 *
 * 形态：
 *   - 取该流「当前行」——stream_session_id = base OR LIKE 'base#%' 的非
 *     segment 顶层行中最新一行（I1 修复：SQL 与注释对齐。带 roll 的断点流
 *     真正中断的是 #roll{n} 行——status 当时被 sweepStaleStreaming /
 *     finalizeStreamOnCrash 标 failed；已被 roll 正常终态化的 base 行不翻回。
 *     无 roll 时族内仅 base 行，与旧精确匹配行为一致）
 *   - updateMessageStatus(rowId, 'streaming') —— 不改 body（保留聚合正文）
 *   - 追加 status_change 事件 { status: 'streaming' }——事件时间线诚实呈现
 *     「翻回」动作（与 start chunk 写入的 status_change 事件同型；renderer
 *     聚合器会消费该事件把聚合状态翻回 streaming——与消息行状态一致，
 *     实时 / 重启两侧同视图）
 *
 * 行定位经 getLatestMessageByStreamSessionId 单点——与 stream-relay start
 * 幂等复用（续流必须落 flip 翻过的同一行）和 rebuildTurn 跨行聚合共用
 * 「流族 = base + #roll，当前行 = 最新一行」语义（防契约漂移；ssi 系统生成
 * 全局唯一，无需 session 过滤，与 collectStreamEvents 同口径）。
 *
 * 若无匹配行（极罕见：assigned 路径被覆盖到此分支等）静默 no-op——调用方已
 * 处理新建流场景。
 */
export function flipMessageBackToStreaming(baseSsId: string): void {
  const row = getLatestMessageByStreamSessionId(baseSsId);
  if (!row) return;
  updateMessageStatus(row.id, 'streaming');
  getEventBuffer().append({
    messageId: row.id,
    eventType: 'status_change',
    payload: { status: 'streaming' },
  });
  // 立即落盘（renderer 可能在状态变更事件到达前就拉了消息列表；status 列已是 streaming）
  getEventBuffer().flush();
}

/**
 * flipMessageBackToStreaming 的反向补偿（C1）：resume 派发失败时把翻回
 * streaming 的行退回 failed。收尾形态对齐 sweepStaleStreaming 的崩溃兜底
 * 契约——final 事件携带失败原因，renderer 聚合状态与消息行列同步翻回
 * failed，不滞留「流不存在却 streaming」的幽灵行。
 *
 * 行定位与 flip 同点（getLatestMessageByStreamSessionId 单点——流族 =
 * base + #roll，当前行 = 最新一行，防两辅助各自理解流族语义的契约漂移）；
 * 不改 body（flip 未触碰 body，回滚对称）。无匹配行静默 no-op。
 */
function rollbackMessageFromStreaming(baseSsId: string, error: string): void {
  const row = getLatestMessageByStreamSessionId(baseSsId);
  if (!row) return;
  updateMessageStatus(row.id, 'failed');
  getEventBuffer().append({
    messageId: row.id,
    eventType: 'final',
    payload: { status: 'failed', error },
  });
  getEventBuffer().flush();
}
