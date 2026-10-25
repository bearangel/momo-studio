// 委派执行器生产端口装配（M2e T10/T11）——全部边界实装，delegation-runner 保持纯端口消费。
// 会话执行复用既有入口：createCollabSession（单 agent 目标 is_leader=1——路由接待
// 语义要求）/ sendUserMessage（systemKickoff：任务书非用户手输，跳过冲突检测与
// #T 激活两个用户语义钩子）/ RouterService.stopAll（会话级急停，三级中断既有入口）。
// 完成观测：轮询会话最新 agent 流行 status（messages 表是回合终态单一真相源——
// stream-relay end 路径回写 done/failed/aborted；重启后 sweepStaleStreaming 兜底）。
import { getDb } from '../storage/db';
import { listWorkspaces, getWorkspace } from '../workspace/crud';
import { listMembers, getAgentDefinition } from '../agent/agent-queries';
import { createCollabSession } from '../im/session-ops';
import { sendUserMessage } from '../im/session-service';
import { getRouterService } from '../agent/router-bootstrap';
import type { DelegationRunPorts, DelegationTail, TurnTerminal } from './delegation-runner';
import type { HubDelegationSettings } from './delegation-settings';
import { TASK_WIRE, type TaskReportPayload } from './delegation-wire';
import type { HubClient } from './client';
import { TASK_RPC } from './protocol';
import { logger } from '../logger';

/** agent 流行终态轮询周期（1s——messages.status 单一真相源，非高频面） */
const TURN_POLL_MS = 1000;

type Row = { id: string; sender: string; status: string; stream_session_id: string | null };

/** 会话 attach 基线：当前最大 messages.rowid（attach 之后新落的行才属本回合观测面） */
function sessionMaxRowId(sessionId: string): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages WHERE session_id = ?')
    .get(sessionId) as { max_rowid: number };
  return r.max_rowid;
}

/** 会话内最新 agent 流行（sender 非 owner 的顶层流行）——回合终态判定对象。
 *  sinceRowIdExclusive：F1 回合界定下界——只观测 attach 基线之后新落的行。 */
function latestAgentStreamRow(sessionId: string, sinceRowIdExclusive: number): Row | null {
  const row = getDb()
    .prepare(
      `SELECT id, sender, status, stream_session_id FROM messages
       WHERE session_id = ? AND rowid > ? AND stream_session_id IS NOT NULL
         AND parent_stream_session_id IS NULL AND segment_of IS NULL
         AND sender != 'owner'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId, sinceRowIdExclusive) as Row | undefined;
  return row ?? null;
}

/**
 * 回合终态订阅：轮询最新 agent 流行 status。
 * 'streaming'=在跑（继续等）；终态行（done/failed/aborted）回调一次；
 * 无流行（用户消息已落、agent 尚未开始）继续等——路由失败时 sendUserMessage
 * 链路已写启动失败气泡（writeStreamStartFailure，failed 行），轮询可捕获。
 *
 * F1 回合界定（T10/T11 评审 Important）：attach 时刻记录 rowid 基线，查询加
 * `rowid >` 下界。idle 续传路径（handleOnline 复用同一会话注入续跑回合）上，
 * 上一回合的陈旧终态行仍是 ORDER BY 首位——无下界时新回合首个流行落库前它就
 * 胜出 → 假 failed 立即回调。基线在 watchTurn 调用（= runner attachWatcher）
 * 时捕获，先于 startTurn 注入，新回合全部行必在基线之后。
 */
export function watchTurnProduct(sessionId: string, onTerminal: (t: TurnTerminal) => void): () => void {
  let settled = false;
  const baseline = sessionMaxRowId(sessionId);
  const timer = setInterval(() => {
    if (settled) return;
    const row = latestAgentStreamRow(sessionId, baseline);
    if (!row || row.status === 'streaming') return;
    settled = true;
    clearInterval(timer);
    onTerminal({
      status: row.status === 'done' ? 'done' : row.status === 'failed' ? 'failed' : 'aborted',
    });
  }, TURN_POLL_MS);
  timer.unref?.();
  return () => {
    settled = true;
    clearInterval(timer);
  };
}

type EventRow = { rid: number; event_type: string; payload_json: string };

/**
 * 会话尾部增量（进度拍原料）：message_events 按 rowid 单调游标（RF#5 lastSeq——
 * rowid 是插入序全序键，天然单调不丢）。excerpt 取批内末条可读文本
 * （text_delta / final.body / tool_call_start 工具名），恒非空兜底占位。
 * 导出供真 DB 回归锁直测（delegation-ports.test）。
 */
export function sessionTailProduct(sessionId: string, afterRowId: number): DelegationTail | null {
  const rows = getDb()
    .prepare(
      `SELECT e.rowid AS rid, e.event_type, e.payload_json FROM message_events e
       JOIN messages m ON m.id = e.message_id
       WHERE m.session_id = ? AND e.rowid > ?
       ORDER BY e.rowid ASC`,
    )
    .all(sessionId, afterRowId) as EventRow[];
  if (rows.length === 0) return null;
  let lastSeq = afterRowId;
  let excerpt = '';
  for (const r of rows) {
    lastSeq = r.rid;
    const p = JSON.parse(r.payload_json) as Record<string, unknown>;
    if (r.event_type === 'text_delta' && typeof p.delta === 'string' && p.delta.trim()) {
      excerpt = p.delta;
    } else if (r.event_type === 'final' && typeof p.body === 'string' && p.body.trim()) {
      excerpt = p.body;
    } else if (r.event_type === 'tool_call_start' && typeof p.toolName === 'string') {
      excerpt = `调用工具 ${p.toolName}`;
    }
  }
  return { lastSeq, excerpt: excerpt.trim() || '（无文本增量）' };
}

export interface WireDelegationPortsOpts {
  /** 当前连接惰性取用（连接随 hubConfigure/Forget 重建——端口不持有过期引用） */
  clientGetter: () => HubClient | null;
  /** 本机 nodeId（task.list 结果过滤——hub 返回所在组全部中断任务，只恢复派给本机的） */
  selfNodeId: () => string | null;
  /** 设置实时读取（hub/index 持 settings store——开关/并发上限即时生效） */
  settings: () => HubDelegationSettings;
}

/**
 * agent 实例解析：agentSlug 匹配工作空间成员（按定义 slug）；缺省 → 工作空间默认
 * agent（须仍是在册成员——跨空间脏默认值拒绝）；均无 → null。
 * 导出供真 DB 回归锁直测（delegation-ports.test）。
 */
export function resolveAgentInstanceProduct(workspaceId: string, agentSlug: string | undefined): string | null {
  const members = listMembers(workspaceId);
  if (agentSlug !== undefined) {
    const hit = members.find((m) => getAgentDefinition(m.agentDefinitionId)?.slug === agentSlug);
    return hit?.instanceId ?? null;
  }
  const fallback = getWorkspace(workspaceId)?.defaultAgentInstanceId ?? null;
  return fallback && members.some((m) => m.instanceId === fallback) ? fallback : null;
}

export function wireDelegationRunnerPorts(opts: WireDelegationPortsOpts): DelegationRunPorts {
  const { clientGetter, selfNodeId, settings } = opts;
  return {
    settings,
    findWorkspaceByName(name) {
      return listWorkspaces().find((w) => w.name === name) ?? null;
    },
    resolveAgentInstance: resolveAgentInstanceProduct,
    createDelegatedSession(input) {
      // MC1：普通 collab 会话（单 agent 目标 is_leader=1）+ 标题=任务书摘要
      return createCollabSession(input.workspaceId, input.title, {
        type: 'agent',
        instanceId: input.memberInstanceId,
      }).id;
    },
    startTurn: async (input) => {
      // D6 boot 竞态守卫：RouterService lazy 启动前 sendUserMessage 会「路由目标已解析
      // 但 RouterService 未就绪，消息跳过派发」——消息落库但永无回合（幽灵 running）。
      // 此处显式拒绝，把等待/重试责任交还 delegation-runner（退避重试）。
      if (!getRouterService()) {
        throw new Error('RouterService 未就绪（boot 竞态），回合未注入');
      }
      await sendUserMessage({
        sessionId: input.sessionId,
        body: input.body,
        systemKickoff: true,
      });
    },
    stopSession(sessionId) {
      const stopped = getRouterService()?.stopAll(sessionId);
      logger.info('委派取消停跑', { sessionId, stopped });
    },
    watchTurn: watchTurnProduct,
    sessionTail: sessionTailProduct,
    report: (taskId: string, payload: TaskReportPayload) => {
      const client = clientGetter();
      return Promise.resolve(client ? client.sendRes(taskId, TASK_WIRE.report, payload) : false);
    },
    listInterruptedDelegations: async () => {
      const client = clientGetter();
      if (!client) return [];
      const res = await client.request<{
        tasks: Array<{ taskId: string; title: string; workspaceName: string; targetNodeId: string }>;
      }>(TASK_RPC.list, { status: 'interrupted' });
      const me = selfNodeId();
      return res.tasks
        .filter((t) => me === null || t.targetNodeId === me)
        .map((t) => ({ taskId: t.taskId, title: t.title, workspaceName: t.workspaceName }));
    },
  };
}
