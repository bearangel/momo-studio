// renderer/src/lib/mention-parser.ts
//
// @ + # 双语法 Mention 解析器。
// 规则：
//   - @ 紧跟 agent slug（字母/数字/短横线），仅在前面是空白或行首时识别
//   - # 紧跟 T-XXX（T-加数字），仅在前面是空白或行首时识别
//   - 避免误识别邮箱（a@b.com）和 markdown 标题（# 标题）

export interface Mention {
  type: 'agent' | 'task';
  raw: string;        // 完整原始文本，如 '@PM-agent' 或 '#T-001'
  refId: string;      // agent bot user id 或 task id（'T-001' 部分）
  start: number;      // 在原文中的起始 offset
  end: number;        // 结束 offset
}

// @ 后接 slug（字母数字短横线，至少 1 字符）；尾部必须有空白或行尾，
// 否则像 @QA_agent（下划线紧接 slug）不应被识别为合法 mention
const AGENT_REGEX = /(?:^|\s)(@[A-Za-z0-9-]+)(?=\s|$)/g;
// # 后接 T-数字（至少 1 位）；同样要求 slug 边界
const TASK_REGEX = /(?:^|\s)(#T-\d+)(?=\s|$)/g;

export function parseMentions(text: string): Mention[] {
  if (!text) return [];
  const result: Mention[] = [];

  for (const m of text.matchAll(AGENT_REGEX)) {
    const fullMatch = m[1];
    if (!fullMatch) continue;
    const offsetInFull = (m.index ?? 0) + (m[0].length - fullMatch.length);
    result.push({
      type: 'agent',
      raw: fullMatch,
      refId: fullMatch.slice(1),
      start: offsetInFull,
      end: offsetInFull + fullMatch.length,
    });
  }

  for (const m of text.matchAll(TASK_REGEX)) {
    const fullMatch = m[1];
    if (!fullMatch) continue;
    const offsetInFull = (m.index ?? 0) + (m[0].length - fullMatch.length);
    result.push({
      type: 'task',
      raw: fullMatch,
      refId: fullMatch.slice(1),
      start: offsetInFull,
      end: offsetInFull + fullMatch.length,
    });
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}