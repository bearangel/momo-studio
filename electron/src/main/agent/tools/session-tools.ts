// electron/src/main/agent/tools/session-tools.ts
//
// 跨会话引用工具（spec 2026-09-30 §4）：
//   list_sessions —— 本 workspace 会话发现与消歧（标题关键词 + 元信息冗余）
//   read_session  —— 范围门（不存在/跨 workspace/读自己）+ 最近 N 条 + 工具调用摘要
// 严格只读：只 SELECT sessions / session_members / messages / message_events，
// 不写任何表。数据访问全部走既有 repo（本文件不含 SQL）。
import { getSession, listSessionsByWorkspace, listSessionMembers } from '../../storage/sessions/repo';
import {
  countMessagesBySession,
  getFirstUserMessage,
  listRecentMessagesBySession,
} from '../../storage/messages/repo';
import { listEventsForMessages } from '../../storage/messages/events-repo';
import type { MessageEventRow } from '../../storage/messages/events-repo';
import { exportAggregateEvents } from '../../im/export-aggregator';
import { listMembers } from '../crud';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import { parseStringArg } from './shared/arg-parse';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';

/** list_sessions 默认 / 上限条数 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
/** 首条用户消息预览截断（字符） */
const PREVIEW_CHARS = 80;

/** 时间戳 → MM-DD HH:mm（工具输出行内紧凑格式） */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** workspace 成员显示名映射：agentUserId → name、instanceId → name；'owner' → '用户'（单用户应用 sender 约定） */
function buildNameMaps(ctx: ToolContext): { byUserId: Map<string, string>; byInstanceId: Map<string, string> } {
  const byUserId = new Map<string, string>();
  const byInstanceId = new Map<string, string>();
  try {
    for (const m of listMembers(ctx.workspaceId)) {
      byUserId.set(m.agentUserId, m.agentName);
      byInstanceId.set(m.instanceId, m.agentName);
    }
  } catch {
    // DB 不可用 → 空映射，sender 原样显示（降级不阻塞）
  }
  return { byUserId, byInstanceId };
}

const LIST_SESSIONS_DEF: LLMToolDef = {
  name: 'list_sessions',
  description:
    '列出当前 workspace 的会话（可用 read_session 读取内容）。支持按标题关键词过滤；' +
    '返回 id、类型、最近活跃、成员、消息数与首条用户消息预览，供消歧。当前会话不在列表中。',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '标题关键词（不区分大小写子串）；缺省列出全部' },
      limit: { type: 'number', description: `返回条数上限，默认 ${LIST_DEFAULT_LIMIT}，最大 ${LIST_MAX_LIMIT}` },
    },
  },
};

/** list_sessions 主逻辑（导出供单测直调渲染层） */
async function executeListSessions(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : LIST_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), LIST_MAX_LIMIT));

  const rows = listSessionsByWorkspace(ctx.workspaceId).filter((s) => s.id !== ctx.roomId);
  const matched = keyword === '' ? rows : rows.filter((s) => s.title.toLowerCase().includes(keyword));
  if (matched.length === 0) return '没有匹配的会话。可去掉关键词用 list_sessions 浏览全部，或与用户确认会话标题。';

  const { byInstanceId } = buildNameMaps(ctx);
  const lines: string[] = [];
  for (const s of matched.slice(0, limit)) {
    const members = listSessionMembers(s.id)
      .map((m) => byInstanceId.get(m.instanceId) ?? m.instanceId)
      .join('/');
    const preview = getFirstUserMessage(s.id)?.body ?? '';
    const previewText = preview === '' ? '（无用户消息）' : truncateString(preview, PREVIEW_CHARS);
    lines.push(
      `- id=${s.id} 《${s.title}》 [${s.kind}] 活跃=${formatTs(s.lastMessageAt ?? s.createdAt)} 消息数=${countMessagesBySession(s.id)}`,
      `  成员: ${members === '' ? '（无成员）' : members}  预览: ${previewText}`,
    );
  }
  const header = keyword === '' ? `共 ${Math.min(matched.length, limit)} 个会话：` : `关键词「${keyword}」命中 ${Math.min(matched.length, limit)} 个会话：`;
  return `${header}\n${lines.join('\n')}\n读取内容：read_session(sessionId=...)`;
}

/** read_session 默认 / 上限条数 */
const READ_DEFAULT_LIMIT = 50;
const READ_MAX_LIMIT = 200;
/** 工具摘要行内截断（字符）：args / result / dispatch task */
const SUMMARY_ARG_CHARS = 120;
const SUMMARY_RESULT_CHARS = 200;
const SUMMARY_TASK_CHARS = 80;

const READ_SESSION_DEF: LLMToolDef = {
  name: 'read_session',
  description:
    '读取当前 workspace 内另一会话的内容：每条消息一行（时间/发送者/正文），agent 消息附工具调用摘要行。' +
    '默认返回最近 50 条；beforeTs / afterTs（毫秒时间戳，取自输出行时间对应值）可翻页。当前会话不可读。',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: '目标会话 id（list_sessions 获取）' },
      limit: { type: 'number', description: `本页条数，默认 ${READ_DEFAULT_LIMIT}，最大 ${READ_MAX_LIMIT}` },
      beforeTs: { type: 'number', description: '仅取 created_at 严格小于该值的消息（向更早翻页）' },
      afterTs: { type: 'number', description: '仅取 created_at 严格大于该值的消息（向更新翻页）' },
    },
    required: ['sessionId'],
  },
};

/** 单条 assistant 消息的工具摘要行（B 颗粒度；段聚合复用 export-aggregator，不重写配对逻辑） */
function renderToolSummaryLines(events: MessageEventRow[]): string[] {
  const { segments } = exportAggregateEvents(events);
  const lines: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'tool') {
      const argsStr = truncateString(JSON.stringify(seg.args ?? {}), SUMMARY_ARG_CHARS);
      const resultStr = seg.result === null ? '(结果未回传)' : truncateString(seg.result, SUMMARY_RESULT_CHARS);
      // success===null（未配对 result）用 …，与 ✓/✗ 区分「未知」而非「成功」
      lines.push(`    🔧 ${seg.toolName}(${argsStr}) → ${seg.success === false ? '✗' : seg.success === null ? '…' : '✓'} ${resultStr}`);
    } else if (seg.kind === 'dispatch') {
      lines.push(`    📤 dispatch→${seg.subAgentName}: ${truncateString(seg.task, SUMMARY_TASK_CHARS)} (${seg.status})`);
    }
  }
  return lines;
}

async function executeReadSession(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const sessionId = parseStringArg(args.sessionId, 'sessionId');
  // 范围门三连（spec §4.2，先于任何内容读取）
  const session = getSession(sessionId);
  if (session === null) return `会话不存在（可能已解散）：${sessionId}`;
  if (session.workspaceId !== ctx.workspaceId) return `会话不在当前 workspace，拒绝读取：${sessionId}`;
  if (sessionId === ctx.roomId) return '这是当前会话，内容已在你的上下文中，无需读取。';

  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : READ_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), READ_MAX_LIMIT));
  const opts: { beforeTs?: number; afterTs?: number } = {};
  if (typeof args.beforeTs === 'number' && Number.isFinite(args.beforeTs)) opts.beforeTs = args.beforeTs;
  if (typeof args.afterTs === 'number' && Number.isFinite(args.afterTs)) opts.afterTs = args.afterTs;

  const messages = listRecentMessagesBySession(sessionId, limit, opts);
  const header =
    `会话《${session.title}》 [${session.kind}] 活跃=${formatTs(session.lastMessageAt ?? session.createdAt)}`;
  if (messages.length === 0) return `${header}\n会话无消息。`;

  const { byUserId } = buildNameMaps(ctx);
  const eventsByMsg = listEventsForMessages(messages.map((m) => m.id));
  const lines: string[] = [header];
  for (const m of messages) {
    const name = m.sender === 'owner' ? '用户' : (byUserId.get(m.sender) ?? m.sender);
    lines.push(`[${formatTs(m.createdAt)}] ${name}: ${m.body}`);
    const summary = renderToolSummaryLines(eventsByMsg.get(m.id) ?? []);
    lines.push(...summary);
  }
  // FIX(终审)：footer 必须在截断之后追加——truncateString 保头切尾，若随正文一起截断，
  // 翻页游标恰在最需要翻页时丢失。bodyText 截断标记（含「截断」二字）仅超限时出现。
  const bodyText = truncateString(lines.join('\n'), OUTPUT_LIMITS.read_session);
  const earliest = messages[0]!.createdAt;
  const latest = messages[messages.length - 1]!.createdAt;
  const footer = `本页 ${messages.length} 条（时间升序）。翻页游标：更早用 beforeTs=${earliest}，更新用 afterTs=${latest}`;
  return `${bodyText}\n${footer}`;
}

/** SessionTools：跨会话引用工具模块（spec 2026-09-30 §4） */
// 类外常量（Tier 划分见 spec §3）：
const SESSION_CATALOG_META: Record<string, ToolMeta> = {
  list_sessions: { category: '会话', categoryEmoji: '💬', defaultOn: true },
  read_session: { category: '会话', categoryEmoji: '💬', defaultOn: true },
};

export class SessionTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [LIST_SESSIONS_DEF, READ_SESSION_DEF];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), SESSION_CATALOG_META);
  }

  handles(name: string): boolean {
    return name === 'list_sessions' || name === 'read_session';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'list_sessions') return executeListSessions(args, ctx);
    if (name === 'read_session') return executeReadSession(args, ctx);
    throw new Error(`未知 session 工具: ${name}`);
  }
}
