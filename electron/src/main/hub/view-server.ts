// electron/src/main/hub/view-server.ts
//
// 远程查看服务端（momo-hub M2e T14，目标节点侧，spec §3.1 view.* 六方法 /
// §5.4 leader 四视图 / §8.4 只读红线 / MC3 拉取+尾部订阅）。
//
// 职责：
//   1) view.workspace / view.sessions / view.messages / view.tasks 四组装器
//      ——查询面全部复用既有域入口（sessions/tasks 域 DAO + snapshot-builder
//      同款配置域查询），零旁路 SQL 写路径
//   2) view.subscribe / view.unsubscribe 尾部订阅登记——复用 message_events
//      缓冲面（与 delegation-ports.sessionTailProduct 同款 rowid 单调游标）；
//      订阅后 500ms 轮询新事件、批 ≤200 条经 VIEW_WIRE.tail 上行（同委派
//      进度拍节流纪律）；consent 关闭时停发（T13 交接：hub 不杀既有订阅，
//      目标侧停上行；重开后游标未推进——关窗期事件在恢复后首批补投，无缺口）
//   3) 只读红线（§8.4）：八方法零写路径——组装器只含 SELECT；subscribe/
//      unsubscribe 仅动内存订阅表（连接管理语义，非业务写）。测试对源码静态
//      断言无 INSERT/UPDATE/DELETE。
//   4) M3.2 远端可见性（协议 1.4.0）：view.workspaces 空间清单（白名单投影）+
//      view.files 只读文件树（list 500 截断 / read 256KB 截断 base64）——全程
//      WorkspaceFS 只读面，零写调用。
//
// ViewMessage 投影（协议 §3.1：seq 天然全序单调，富形态由目标节点序列化进
// content）：seq=message_events.rowid（与 sessionTailProduct 游标同键）、
// role=user/assistant（messages.sender 推导）、content=事件载荷文本投影
// （text_delta/final/tool_call_start/thinking/…）；工具事件以「调用工具 X」
// 前缀序列化——与 DelegationTail excerpt 同约定，leader 端复用同一渲染。
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { listWorkspaces } from '../workspace/crud';
import { listSessionsByWorkspace } from '../storage/sessions/repo';
import { listTasks } from '../storage/tasks/repo';
import { listMembers, getAgentDefinition, listAgentDefinitions } from '../agent/agent-queries';
import { listTeams } from '../agent/team';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled } from '../skill/zip-uploader';
import { listPlugins, isPluginEnabled } from '../plugin/registry';
import { WorkspaceFS } from '../files/workspace-fs';
import {
  VIEW_RPC,
  VIEW_FILES_ENTRIES_MAX,
  VIEW_FILES_PATH_MAX,
  VIEW_FILES_READ_MAX,
  type RequestEnvelope,
  type RpcErrorPayload,
  type ViewMessage,
  type ViewOverview,
  type ViewSessionSummary,
} from './protocol';
import { VIEW_WIRE } from './view-wire';
import type { HubViewSettings } from './view-settings';
import type { HubClient, HubResponderResult } from './client';

/** 尾部轮询周期与单批上限（与委派进度拍同节流纪律：500ms 合并 / ≤200 条）。 */
const TAIL_TICK_MS = 500;
const TAIL_BATCH_MAX = 200;
/** 单事件 content 投影封顶（对齐 hub 侧 TAIL_CONTENT_MAX）。 */
const CONTENT_MAX = 256 * 1024;
/** sessions/messages 列表页尺寸上限（DoS 下限）。 */
const SESSIONS_LIMIT_MAX = 100;
const MESSAGES_LIMIT_MAX = 200;
const TASKS_LIMIT = 200;
/** view.files 限额（协议包单源常量——与 hub 侧限额表同值）：单目录条目上限 / 单文件读取字节上限。 */
const FILES_ENTRIES_MAX = VIEW_FILES_ENTRIES_MAX;
const FILES_READ_MAX = VIEW_FILES_READ_MAX;

export interface ViewServerOpts {
  /** 当前连接惰性取用（tail 上行经当前在线连接；连接重建不持过期引用） */
  clientGetter: () => HubClient | null;
  /** 查看同意设置实时读取（关闭 → 停发 tail） */
  settings: () => HubViewSettings;
  /** 轮询周期注入（测试用；默认 500ms） */
  tailTickMs?: number;
}

interface TailWatch {
  sessionId: string;
  /** 上行成功才推进的单调游标（断线/consent 关窗期不推进——恢复后无缺口） */
  cursor: number;
}

function err(code: RpcErrorPayload['code'], message: string): HubResponderResult {
  return { ok: false, payload: { code, message } satisfies RpcErrorPayload };
}

function boundedInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return fallback;
  return Math.min(raw, max);
}

function clampContent(text: string): string {
  return text.length > CONTENT_MAX ? text.slice(0, CONTENT_MAX) : text;
}

/** 事件载荷 → content 文本投影（「调用工具 X」前缀与 DelegationTail 同约定）。 */
function projectEventContent(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === 'text_delta' && typeof payload.delta === 'string') return payload.delta;
  if (eventType === 'final' && typeof payload.body === 'string') return payload.body;
  if (eventType === 'tool_call_start' && typeof payload.toolName === 'string') return `调用工具 ${payload.toolName}`;
  if (eventType === 'tool_call_end' && typeof payload.toolName === 'string') {
    return typeof payload.result === 'string'
      ? `工具 ${payload.toolName} 完成: ${payload.result.slice(0, 2000)}`
      : `工具 ${payload.toolName} 完成`;
  }
  if (eventType === 'thinking' && typeof payload.delta === 'string') return `（思考）${payload.delta}`;
  if (typeof payload.body === 'string') return payload.body;
  return `（事件 ${eventType}）`;
}

interface EventRow {
  seq: number;
  at: number;
  sender: string;
  event_type: string;
  payload_json: string;
}

/** 会话事件读取（只读面单点）：rowid 全序 + 会话归属 JOIN messages。 */
function sessionEvents(sessionId: string, afterSeq: number, direction: '>' | '>=', limit: number): EventRow[] {
  return getDb()
    .prepare(
      `SELECT e.rowid AS seq, e.created_at AS at, m.sender AS sender, e.event_type AS event_type, e.payload_json AS payload_json
       FROM message_events e JOIN messages m ON m.id = e.message_id
       WHERE m.session_id = ? AND e.rowid ${direction} ?
       ORDER BY e.rowid ASC LIMIT ?`,
    )
    .all(sessionId, afterSeq, limit) as EventRow[];
}

function toViewMessage(r: EventRow): ViewMessage {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload_json) as Record<string, unknown>;
  } catch {
    // 脏载荷退化为事件名占位（显示侧不炸）
  }
  return {
    seq: r.seq,
    at: r.at,
    role: r.sender === 'owner' ? 'user' : 'assistant',
    content: clampContent(projectEventContent(r.event_type, payload)),
  };
}

function findWorkspaceIdByName(workspaceName: string): string | null {
  return listWorkspaces().find((w) => w.name === workspaceName)?.id ?? null;
}

export class ViewServer {
  private readonly watchers = new Map<string, TailWatch>();
  private timer: NodeJS.Timeout | null = null;
  private readonly tailTickMs: number;

  constructor(private readonly opts: ViewServerOpts) {
    this.tailTickMs = opts.tailTickMs ?? TAIL_TICK_MS;
  }

  /** view.* 八方法 responder 入口（hub 定向 req → 组装/登记 → res）。 */
  async handleViewRequest(req: RequestEnvelope): Promise<HubResponderResult> {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case VIEW_RPC.workspace: {
        const name = typeof p.workspaceName === 'string' ? p.workspaceName : '';
        const wsId = findWorkspaceIdByName(name);
        if (!wsId) return err('not_found', `工作空间不存在: ${name || '（未指定）'}`);
        return { ok: true, payload: this.assembleWorkspace(wsId, name) };
      }
      case VIEW_RPC.sessions: {
        const name = typeof p.workspaceName === 'string' ? p.workspaceName : '';
        const wsId = findWorkspaceIdByName(name);
        if (!wsId) return err('not_found', `工作空间不存在: ${name || '（未指定）'}`);
        const limit = boundedInt(p.limit, 50, SESSIONS_LIMIT_MAX);
        const beforeSeq = typeof p.beforeSeq === 'number' && Number.isInteger(p.beforeSeq) && p.beforeSeq > 0
          ? p.beforeSeq
          : null;
        return { ok: true, payload: { sessions: this.assembleSessions(wsId, beforeSeq, limit) } };
      }
      case VIEW_RPC.messages: {
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
        if (!sessionId) return err('bad_request', 'sessionId 缺失');
        const row = getDb()
          .prepare('SELECT id, workspace_id FROM sessions WHERE id = ?')
          .get(sessionId) as { id: string; workspace_id: string } | undefined;
        if (!row) return err('not_found', `会话不存在: ${sessionId}`);
        // workspaceName 为面板上下文附加键（协议 ViewMessagesReq 未含）：携带时
        // 校验会话归属，跨空间会话 id 探测一律 not_found（§3.3 防探测不细分）
        if (typeof p.workspaceName === 'string' && findWorkspaceIdByName(p.workspaceName) !== row.workspace_id) {
          return err('not_found', `会话不存在: ${sessionId}`);
        }
        const fromSeq = typeof p.fromSeq === 'number' && Number.isInteger(p.fromSeq) && p.fromSeq >= 0
          ? p.fromSeq
          : 0;
        const limit = boundedInt(p.limit, 50, MESSAGES_LIMIT_MAX);
        return { ok: true, payload: this.assembleMessages(sessionId, fromSeq, limit) };
      }
      case VIEW_RPC.tasks: {
        const name = typeof p.workspaceName === 'string' ? p.workspaceName : '';
        const wsId = findWorkspaceIdByName(name);
        if (!wsId) return err('not_found', `工作空间不存在: ${name || '（未指定）'}`);
        return { ok: true, payload: { tasks: this.assembleTasks(wsId) } };
      }
      case VIEW_RPC.subscribe: {
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
        if (!sessionId) return err('bad_request', 'sessionId 缺失');
        const exists = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as
          | { id: string }
          | undefined;
        if (!exists) return err('not_found', `会话不存在: ${sessionId}`);
        this.subscribe(sessionId);
        return { ok: true, payload: { ok: true } };
      }
      case VIEW_RPC.unsubscribe: {
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
        if (!sessionId) return err('bad_request', 'sessionId 缺失');
        this.unsubscribe(sessionId);
        return { ok: true, payload: { ok: true } };
      }
      case VIEW_RPC.workspaces: {
        // M3.2 远端空间清单：投影白名单 {id,name,description}——刻意不暴露
        // directoryPath/ownerId（本机路径泄漏面，spec §2.3 风险表末行）
        const workspaces = listWorkspaces().map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
        }));
        return { ok: true, payload: { workspaces } };
      }
      case VIEW_RPC.files: {
        const name = typeof p.workspaceName === 'string' ? p.workspaceName : '';
        const ws = listWorkspaces().find((w) => w.name === name);
        if (!ws) return err('not_found', `工作空间不存在: ${name || '（未指定）'}`);
        if (p.op !== 'list' && p.op !== 'read') return err('bad_request', 'op 缺失或非法（仅 list/read）');
        const relPath = typeof p.path === 'string' && p.path !== '' ? p.path : '.';
        if (relPath.length > VIEW_FILES_PATH_MAX) return err('bad_request', `path 过长（上限 ${VIEW_FILES_PATH_MAX} 字符）`);
        // 每工作空间独立 WorkspaceFS 实例且不带 extraRoots——只读域 = 工作空间根
        // （assertInWorkspace 拒 .. 越界 / 符号链接逃逸 / .git 保护，listDir 再滤 .git* 前缀）。
        // 越界/逃逸/不存在一律 not_found 不细分（沿 messages anti-probe 口径 :167-171）
        const wsFs = new WorkspaceFS(ws.directoryPath);
        if (p.op === 'list') {
          try {
            const all = await wsFs.listDir(relPath);
            const truncated = all.length > FILES_ENTRIES_MAX;
            return {
              ok: true,
              payload: {
                entries: truncated ? all.slice(0, FILES_ENTRIES_MAX) : all,
                truncated,
              },
            };
          } catch {
            return err('not_found', `目录不存在或不可访问: ${relPath}`);
          }
        }
        try {
          const buf = await wsFs.readFile(relPath);
          const truncated = buf.length > FILES_READ_MAX;
          const content = (truncated ? buf.subarray(0, FILES_READ_MAX) : buf).toString('base64');
          return { ok: true, payload: { content, size: buf.length, truncated } };
        } catch {
          return err('not_found', `文件不存在或不可访问: ${relPath}`);
        }
      }
      default:
        return err('unknown_method', `节点不支持的查看方法: ${req.method}`);
    }
  }

  /** view.workspace 组装（七字段——配置面与 snapshot-builder 查询域对齐）。 */
  private assembleWorkspace(workspaceId: string, workspaceName: string): ViewOverview {
    const members = listMembers(workspaceId);
    const nameByInstance = new Map(members.map((m) => [m.instanceId, m.agentName]));
    const agentMembers = members.map((m) => {
      const def = getAgentDefinition(m.agentDefinitionId);
      return { name: m.agentName, ...(def?.slug ? { agentSlug: def.slug } : {}) };
    });
    const teams = listTeams(workspaceId).map((t) => ({
      name: t.name,
      leaderName: nameByInstance.get(t.leaderInstanceId) ?? '',
      memberNames: t.members.map((mm) => nameByInstance.get(mm.instanceId) ?? mm.agentName),
    }));
    const mcpEnabled = listRegistered()
      .filter((m) => m.enabled && m.transport === 'stdio' && !m.url && m.source !== 'plugin')
      .map((m) => m.name);
    const skills = listInstalled().map((s) => s.slug);
    const pluginsEnabled = listPlugins().filter((p) => isPluginEnabled(p.id, workspaceId)).map((p) => p.id);
    logger.info('查看组装：工作空间概览', { workspaceId, workspaceName, members: members.length });
    return {
      overview: {
        name: workspaceName,
        description: listWorkspaces().find((w) => w.id === workspaceId)?.description ?? '',
        sessionCount: listSessionsByWorkspace(workspaceId).length,
      },
      agentMembers,
      teams,
      mcpEnabled,
      skills,
      pluginsEnabled,
      resourcesSummary: {
        agent: listAgentDefinitions().length,
        mcp: listRegistered().length,
        skill: listInstalled().length,
        plugin: listPlugins().length,
      },
    };
  }

  /** view.sessions 组装：lastSeq = 会话事件最大 rowid（≈消息数）；lastSeq 降序分页。 */
  private assembleSessions(workspaceId: string, beforeSeq: number | null, limit: number): ViewSessionSummary[] {
    const sessions = listSessionsByWorkspace(workspaceId);
    const lastSeqBySession = new Map<string, number>();
    if (sessions.length > 0) {
      const placeholders = sessions.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT m.session_id AS sid, MAX(e.rowid) AS last_seq FROM message_events e
           JOIN messages m ON m.id = e.message_id
           WHERE m.session_id IN (${placeholders}) GROUP BY m.session_id`,
        )
        .all(...sessions.map((s) => s.id)) as Array<{ sid: string; last_seq: number }>;
      for (const r of rows) lastSeqBySession.set(r.sid, r.last_seq);
    }
    return sessions
      .map((s) => ({
        sessionId: s.id,
        title: s.title,
        lastSeq: lastSeqBySession.get(s.id) ?? 0,
        updatedAt: s.lastMessageAt ?? s.createdAt,
      }))
      .filter((s) => (beforeSeq === null ? true : s.lastSeq < beforeSeq))
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .slice(0, limit);
  }

  /** view.messages 组装：seq 升序一页 + hasMore（更早事件是否还在）。 */
  private assembleMessages(sessionId: string, fromSeq: number, limit: number): { messages: ViewMessage[]; hasMore: boolean } {
    const rows = sessionEvents(sessionId, fromSeq, '>=', limit);
    const earlier = fromSeq > 0
      ? getDb()
        .prepare(
          `SELECT e.rowid AS seq FROM message_events e JOIN messages m ON m.id = e.message_id
           WHERE m.session_id = ? AND e.rowid < ? LIMIT 1`,
        )
        .get(sessionId, fromSeq) as { seq: number } | undefined
      : undefined;
    return { messages: rows.map(toViewMessage), hasMore: earlier !== undefined };
  }

  /** view.tasks 组装：目标节点本地 #T 任务（最新在前）。 */
  private assembleTasks(workspaceId: string): Array<{ taskId: string; title: string; status: string; updatedAt: number }> {
    return listTasks({ workspaceId, orderBy: 'created_at_desc', limit: TASKS_LIMIT }).map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
      updatedAt: t.updatedAt,
    }));
  }

  /** 订阅登记：游标锚定当前最大事件 rowid（订阅后新事件才上行）。 */
  private subscribe(sessionId: string): void {
    if (this.watchers.has(sessionId)) return; // 幂等（hub 侧登记同键去重）
    const anchor = getDb()
      .prepare(
        `SELECT COALESCE(MAX(e.rowid), 0) AS max_seq FROM message_events e
         JOIN messages m ON m.id = e.message_id WHERE m.session_id = ?`,
      )
      .get(sessionId) as { max_seq: number };
    this.watchers.set(sessionId, { sessionId, cursor: anchor.max_seq });
    this.ensureTimer();
    logger.info('查看尾部订阅已登记', { sessionId, cursor: anchor.max_seq });
  }

  private unsubscribe(sessionId: string): void {
    if (this.watchers.delete(sessionId)) logger.info('查看尾部订阅已注销', { sessionId });
    if (this.watchers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tailTickMs);
    this.timer.unref?.();
  }

  /** 尾部轮询：读增量 → consent 关则跳过（游标不推进）→ 上行成功才推进游标。 */
  private tick(): void {
    if (this.watchers.size === 0) return;
    const allowed = this.opts.settings().allowGroupView;
    const client = this.opts.clientGetter();
    for (const w of [...this.watchers.values()]) {
      const rows = sessionEvents(w.sessionId, w.cursor, '>', TAIL_BATCH_MAX);
      if (rows.length === 0) continue;
      if (!allowed) continue; // 关窗：不读游标推进——重开后首批补投关窗期事件
      if (!client || client.state() !== 'online') continue; // 离线：游标不推进，重连后续传
      const events = rows.map(toViewMessage);
      void client
        .request(VIEW_WIRE.tail, { sessionId: w.sessionId, events })
        .then(() => {
          w.cursor = rows[rows.length - 1]!.seq;
        })
        .catch((err) => {
          logger.warn('查看尾部上行失败（游标不推进，下轮重试）', {
            sessionId: w.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watchers.clear();
  }
}
