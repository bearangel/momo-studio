// electron/src/main/agent/turn-context.ts
// ExpandedContext → <user-context> XML 块渲染（v2.11，spec 2026-09-16 §5.5）。
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

/** XML 属性值转义（name/path 是受控输入，仍防御引号破坏标签结构） */
function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}