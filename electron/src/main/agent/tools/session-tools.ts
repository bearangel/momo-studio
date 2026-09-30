// electron/src/main/agent/tools/session-tools.ts
//
// 跨会话引用工具（spec 2026-09-30 §4）：
//   list_sessions —— 本 workspace 会话发现与消歧（标题关键词 + 元信息冗余）
//   read_session  —— 范围门（不存在/跨 workspace/读自己）+ 最近 N 条 + 工具调用摘要
// 严格只读：只 SELECT sessions / session_members / messages / message_events，
// 不写任何表。数据访问全部走既有 repo（本文件不含 SQL）。
import { listSessionsByWorkspace, listSessionMembers } from '../../storage/sessions/repo';
import {
  countMessagesBySession,
  getFirstUserMessage,
  listRecentMessagesBySession,
} from '../../storage/messages/repo';
import { listEventsForMessages } from '../../storage/messages/events-repo';
import { exportAggregateEvents } from '../../im/export-aggregator';
import { listMembers } from '../crud';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
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

/** SessionTools：跨会话引用工具模块（spec 2026-09-30 §4） */
export class SessionTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [LIST_SESSIONS_DEF];
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

// executeReadSession 在 read_session 任务（Task 3）落地；先以占位实现保证模块完整可注册。
async function executeReadSession(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  void args; void ctx;
  return 'read_session 尚未实现';
}