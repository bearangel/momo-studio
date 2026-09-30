// electron/src/main/agent/turn-context.ts
// ExpandedContext → <user-context> XML 块渲染（v2.11，spec 2026-09-16 §5.5；
// session 指针块见 spec 2026-09-30 §6）。
// 纯函数：只做字符串组装，IO（skill 加载 / 文件读取）全部在主进程 context-expander。
import type { ExpandedContext } from './runtime-config';

/** 单文件超大 / 读取失败的降级提示行（LLM 可据此转用文件工具自读） */
const FILE_FALLBACK_HINT = '文件过大，请用文件工具按需读取';

export function renderUserContext(context: ExpandedContext): string {
  const parts: string[] = [];
  for (const s of context.skills) {
    parts.push(`<skill name="${escapeAttr(s.name)}">\n${s.body}\n</skill>`);
  }
  for (const f of context.files) {
    parts.push(
      `<file path="${escapeAttr(f.path)}">\n${f.content ?? FILE_FALLBACK_HINT}\n</file>`,
    );
  }
  // session 指针块（跨会话引用 spec 2026-09-30 §6）：missing 先判——降级文案
  // 不消费 kind/memberNames/messageCount/lastMessageAt（missing 项它们是占位值）
  for (const s of context.sessions ?? []) {
    if (s.missing) {
      parts.push(
        `<session id="${escapeAttr(s.sessionId)}" title="${escapeAttr(s.title)}">\n该会话已删除或不可访问。\n</session>`,
      );
      continue;
    }
    const active = s.lastMessageAt === null ? '未知' : new Date(s.lastMessageAt).toISOString().slice(5, 16).replace('T', ' ');
    parts.push(
      `<session id="${escapeAttr(s.sessionId)}" title="${escapeAttr(s.title)}">\n` +
        `类型=${s.kind} 成员=${s.memberNames.join('/')} 消息数=${s.messageCount} 最近活跃=${active}\n` +
        `用户引用此会话作为参考。完整内容请调用 read_session 工具读取（sessionId="${escapeAttr(s.sessionId)}"）。\n` +
        `</session>`,
    );
  }
  if (parts.length === 0) return '';
  return `<user-context>\n${parts.join('\n')}\n</user-context>`;
}

/** 把渲染块包装进本轮用户正文：块在前、正文在后；两者皆空返回空串 */
export function renderTurnBody(body: string, context?: ExpandedContext): string {
  if (!context) return body;
  const block = renderUserContext(context);
  if (block === '') return body;
  return body === '' ? block : `${block}\n\n${body}`;
}

/** steer 载荷 context 字段的形状收窄（unknown → ExpandedContext | undefined） */
export function isExpandedContext(v: unknown): v is ExpandedContext {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return Array.isArray(c['skills']) && Array.isArray(c['files']);
}

/** XML 属性值转义（name/path 是受控输入，仍防御引号破坏标签结构） */
function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}