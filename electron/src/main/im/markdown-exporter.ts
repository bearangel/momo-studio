// electron/src/main/im/markdown-exporter.ts
//
// 会话导出 Markdown 格式化纯函数。无 IPC / DB 依赖——IPC handler 反查 agent 名字
// 后注入 ExportMessage.botName 字段传入。所有 content 字段缺失做 ?? '' 兜底，
// 兼容 v1.4 / v1.5 / v1.6 / v1.7 各版本消息结构差异。
//
// 渲染规则详见 spec Section 6.2：
//   - 用户消息：## 👤 用户 @userId — 时间
//   - agent 文本：## 🤖 {botName ?? shortName(sender)} @botId — 时间
//   - thinking：<details><summary>💭 thinking</summary> ... </details>
//   - tool_calls：表格（工具/参数/结果），result > 500 字符单独 <details> 折叠
//   - dispatch：📨 委派子 agent 块 + task_reply 嵌套进同一块（不作为顶层消息）
//
// 大 result 阈值 500 字符：表格只放摘要「✅ 成功（返回 N 字符）」，
// 完整 result 单独 <details><summary>📄 {toolName} 完整结果</summary> 包裹。

import type { MatrixMessagePayload } from '../matrix/sync-manager';

const DISPATCH_EVENT_TYPE = 'io.momo-studio.dispatch';
const TASK_REPLY_EVENT_TYPE = 'io.momo-studio.task_reply';
const THINKING_KEY = 'io.momo-studio.thinking';
const TOOL_CALLS_KEY = 'io.momo-studio.tool_calls';

const LARGE_RESULT_THRESHOLD = 500;
const TABLE_RESULT_PREVIEW = 200;

export interface ExportMessage extends MatrixMessagePayload {
  botName: string | null;
}

export interface ExportMeta {
  roomName: string;
  roomId: string;
  exportedAt: Date;
  requestedLimit: number;
  actualCount: number;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  isDispatch?: boolean;
  subStreamSessionId?: string;
  subAgentName?: string;
}

function shortName(userId: string): string {
  // @bot.pm-agent:localhost → pm-agent
  const m = userId.match(/^@([^:]+):/);
  return m ? m[1]!.replace(/^bot\./, '') : userId;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toJsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

function escapePipe(s: string): string {
  // 表格单元格内的 | 转义
  return s.replace(/\|/g, '\\|');
}

function renderThinking(content: Record<string, unknown>): string {
  const thinking = content[THINKING_KEY];
  if (typeof thinking !== 'string' || !thinking) return '';
  return `<details>\n<summary>💭 thinking（点击展开）</summary>\n\n${thinking}\n\n</details>\n\n`;
}

function renderToolCall(tc: ToolCallRecord): string {
  const status = tc.success ? '✅ 成功' : '❌ 失败';
  const isLarge = tc.result.length > LARGE_RESULT_THRESHOLD;

  let tableResultCell: string;
  if (isLarge) {
    tableResultCell = `${status}（返回 ${tc.result.length} 字符）`;
  } else {
    tableResultCell = tc.result ? `${status}（${escapePipe(tc.result.slice(0, TABLE_RESULT_PREVIEW))}${tc.result.length > TABLE_RESULT_PREVIEW ? '...' : ''}）` : status;
  }

  const args = toJsonBlock(tc.args).replace(/\n/g, '\n  ').slice(0, -3); // indent args in table cell
  let table = `| 工具 | 参数 | 结果 |\n|---|---|---|\n`;
  table += `| \`${tc.name}\` | ${args} | ${tableResultCell} |`;

  // 大 result 单独折叠
  if (isLarge) {
    table += `\n\n<details>\n<summary>📄 ${tc.name} 完整结果（点击展开）</summary>\n\n\`\`\`\n${tc.result}\n\`\`\`\n\n</details>`;
  }

  return table;
}

function renderToolCalls(content: Record<string, unknown>): string {
  const calls = content[TOOL_CALLS_KEY];
  if (!Array.isArray(calls) || calls.length === 0) return '';
  let out = '**🔧 工具调用**\n\n';
  for (const c of calls) {
    out += renderToolCall(c as ToolCallRecord) + '\n\n';
  }
  return out;
}

interface DispatchGroup {
  dispatch: ExportMessage;
  replies: ExportMessage[];
}

/**
 * 把 dispatch + task_reply 按 task_id 分组：dispatch 顶层渲染，task_reply 嵌套进对应 dispatch 块。
 * 没有 dispatch 父级的 orphan task_reply 作为顶层消息渲染（兜底，正常不应出现）。
 */
function groupDispatchAndReplies(messages: ExportMessage[]): {
  topLevels: ExportMessage[];  // 普通 + dispatch（不含 task_reply）
  dispatchReplies: Map<string, ExportMessage[]>;  // task_id → replies
} {
  const dispatchByTaskId = new Map<string, ExportMessage>();
  const repliesByTaskId = new Map<string, ExportMessage[]>();
  const topLevels: ExportMessage[] = [];

  for (const m of messages) {
    if (m.eventType === DISPATCH_EVENT_TYPE) {
      const taskId = (m.content as { task_id?: string }).task_id;
      if (taskId) dispatchByTaskId.set(taskId, m);
      topLevels.push(m);
    } else if (m.eventType === TASK_REPLY_EVENT_TYPE) {
      const taskId = (m.content as { task_id?: string }).task_id;
      if (taskId) {
        const list = repliesByTaskId.get(taskId) ?? [];
        list.push(m);
        repliesByTaskId.set(taskId, list);
      } else {
        topLevels.push(m);  // orphan reply
      }
    } else {
      topLevels.push(m);
    }
  }

  return { topLevels, dispatchReplies: repliesByTaskId };
}

function renderDispatchBlock(msg: ExportMessage, replies: ExportMessage[]): string {
  const content = msg.content as {
    body: string;
    task_id: string;
    dispatch_to: string;
  };
  const subAgentName = shortName(content.dispatch_to);
  let out = '**📨 委派子 agent：' + subAgentName + '**\n\n';
  out += `<details>\n<summary>📦 子 agent ${subAgentName} 工作过程（点击展开）</summary>\n\n`;

  // 任务描述
  if (msg.body) {
    out += `**任务**：${msg.body}\n\n`;
  }

  // 子 agent 回执
  for (const reply of replies) {
    const replyContent = reply.content as {
      body: string;
      status: string;
    };
    const statusIcon = replyContent.status === 'completed' ? '✅' :
                       replyContent.status === 'failed' ? '❌' :
                       replyContent.status === 'in_progress' ? '⏳' : '❓';
    out += `#### ${statusIcon} ${reply.botName ?? shortName(reply.sender)} @ ${formatTime(reply.timestamp)}\n\n`;
    if (reply.body) {
      out += reply.body + '\n\n';
    }
  }

  out += `</details>\n`;
  return out;
}

function renderMessage(msg: ExportMessage, dispatchReplies: Map<string, ExportMessage[]>): string {
  // dispatch 消息
  if (msg.eventType === DISPATCH_EVENT_TYPE) {
    const taskId = (msg.content as { task_id?: string }).task_id ?? '';
    const replies = dispatchReplies.get(taskId) ?? [];
    return renderDispatchBlock(msg, replies);
  }

  // 普通 m.room.message
  // v1.7.3 修复：不能只靠 sender.startsWith('@bot.') 判断 bot——实际 agent userId
  // 格式是 @<slug>.<workspaceSlug>.<ownerLocalpart>.<suffix>:localhost（如
  // @sisyphus.momo-test.stbearangel.u3nx4w:localhost），不带 bot. 前缀。
  // 改为优先用 IPC handler 反查注入的 botName 字段判断；sender.startsWith
  // 仅作 fallback（兼容历史 @bot.xxx 格式）。
  const isBot = msg.botName !== null || msg.sender.startsWith('@bot.');
  const icon = isBot ? '🤖' : '👤';
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  // Matrix sender 已是 @user:host 形式，无需额外 @ 前缀
  let out = `## ${icon} ${role} ${msg.sender} — ${formatTime(msg.timestamp)}\n\n`;

  if (isBot) {
    out += renderThinking(msg.content);
    out += renderToolCalls(msg.content);
  }

  if (msg.body) {
    out += msg.body + '\n\n';
  }

  return out;
}

export function formatRoomToMarkdown(messages: ExportMessage[], meta: ExportMeta): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const formatMetaDate = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // 文件头
  let out = `# 会话导出：${meta.roomName}\n\n`;
  out += `- **房间**：\`${meta.roomId}\`（${meta.roomName}）\n`;
  out += `- **导出时间**：${formatMetaDate(meta.exportedAt)}\n`;
  out += `- **消息范围**：最近 ${meta.requestedLimit} 条（实际 ${meta.actualCount} 条）\n`;

  if (messages.length > 0) {
    const earliest = Math.min(...messages.map((m) => m.timestamp));
    const latest = Math.max(...messages.map((m) => m.timestamp));
    out += `- **时间跨度**：${formatTime(earliest)} ~ ${formatTime(latest)}\n`;
  }
  out += `\n---\n\n`;

  // 分组 dispatch / task_reply
  const { topLevels, dispatchReplies } = groupDispatchAndReplies(messages);

  // 渲染每条顶层消息
  for (const msg of topLevels) {
    out += renderMessage(msg, dispatchReplies) + '---\n\n';
  }

  out += `**导出结束（${meta.actualCount} 条消息）**\n`;
  return out;
}
