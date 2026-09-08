// electron/src/main/im/markdown-exporter.ts
//
// 会话导出 Markdown 格式化纯函数。无 IPC / DB 依赖——IPC handler 反查 agent 名字
// 后注入 ExportMessage.botName 字段传入。
//
// v2.0 A 子系统简化：
//   - Matrix event content 富字段（thinking/tool_calls/dispatch 元数据）已废弃，
//     富信息统一在 message_events 表（renderer 端用 aggregateEvents 重建）。
//   - v2.3.2 已升级：rich 字段为可选，缺省（legacy-export 路径 / 无事件消息）仍
//     仅输出 body；存在 rich 时按段序列交错渲染工具调用 / 委派 / todo 与状态标注。
//   - 所有消息统一渲染为顶层条目（不再分组 dispatch/task_reply 嵌套）；
//     子 agent 嵌套由 dispatch.subMarkdown 以引块形式呈现（handler 递归填充）。
//
// v2.0 P1 Task 12：原 extends MatrixMessagePayload（matrix/sync-manager 已删），
// 字段就地展开——形状与 SQLite MessageRow 导出视图一致。

import type { ExportDispatchStatus, ExportSegment } from './export-aggregator';

export const TOOL_RESULT_MAX_CHARS = 2000;

export interface ExportMessage {
  /** 消息唯一标识（SQLite messages.id） */
  eventId: string;
  /** 所属会话 ID */
  roomId: string;
  sender: string;
  body: string;
  /** 事件类型（m.room.message / dispatch / task_reply；renderer 渲染分支依据） */
  eventType: string;
  content: Record<string, unknown>;
  timestamp: number;
  botName: string | null;
  /** 富信息（v2.3.2）：事件聚合段序列；缺省（legacy / 无事件消息）走纯 body 渲染 */
  rich?: {
    segments: ExportSegment[];
    status: 'streaming' | 'done' | 'failed' | 'aborted';
    error?: string;
  };
}

export interface ExportMeta {
  roomName: string;
  roomId: string;
  exportedAt: Date;
  requestedLimit: number;
  actualCount: number;
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

/** 工具结果截断：超限截到 2000 字符并标注原文长度 */
function truncateResult(result: string): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) return result;
  return `${result.slice(0, TOOL_RESULT_MAX_CHARS)}…（已截断，原文 ${result.length} 字符）`;
}

const DISPATCH_STATUS_ICON: Record<ExportDispatchStatus, string> = {
  queued: '🕒 排队',
  executing: '⏳ 执行中',
  completed: '✅ completed',
  failed: '❌ failed',
  timeout: '⏱ timeout',
  aborted: '🛑 aborted',
};

/** 逐行加 `> ` 前缀（工具结果 / 子 agent 嵌套内容用引块呈现） */
function quoteBlock(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

function renderSegments(segments: ExportSegment[]): string {
  let out = '';
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        if (seg.text) out += `${seg.text}\n\n`;
        break;
      case 'tool': {
        out += `🔧 **工具** \`${seg.toolName}\` → \`${JSON.stringify(seg.args)}\`\n\n`;
        const result = seg.result === null ? '（执行中）' : truncateResult(seg.result);
        out += `${quoteBlock(result)}\n\n`;
        break;
      }
      case 'dispatch': {
        out += `📤 **委派** ${seg.subAgentName || '子 agent'}：${seg.task || '（无任务描述）'} —— ${DISPATCH_STATUS_ICON[seg.status]}\n\n`;
        if (seg.subMarkdown !== undefined && seg.subMarkdown.length > 0) {
          out += `${quoteBlock(seg.subMarkdown)}\n\n`;
        } else if (seg.subOmitted === true) {
          out += '> （深层委派已省略）\n\n';
        }
        break;
      }
      case 'todo': {
        for (const item of seg.items) {
          const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○';
          out += `- ${mark} ${item.subject}\n`;
        }
        out += '\n';
        break;
      }
    }
  }
  return out;
}

/** 消息头状态标注（failed / aborted 时追加） */
function statusSuffix(rich: ExportMessage['rich']): string {
  if (!rich || (rich.status !== 'failed' && rich.status !== 'aborted')) return '';
  const label = rich.status === 'failed' ? '失败' : '已中断';
  return rich.error ? `（${label}：${rich.error}）` : `（${label}）`;
}

function renderMessage(msg: ExportMessage): string {
  // v1.7.3 修复：不能只靠 sender.startsWith('@bot.') 判断 bot——实际 agent userId
  // 格式是 @<slug>.<workspaceSlug>.<ownerLocalpart>.<suffix>:localhost（如
  // @sisyphus.momo-test.stbearangel.u3nx4w:localhost），不带 bot. 前缀。
  // 改为优先用 IPC handler 反查注入的 botName 字段判断；sender.startsWith
  // 仅作 fallback（兼容历史 @bot.xxx 格式）。
  const isBot = msg.botName !== null || msg.sender.startsWith('@bot.');
  const icon = isBot ? '🤖' : '👤';
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  // Matrix sender 已是 @user:host 形式，无需额外 @ 前缀
  let out = `## ${icon} ${role} ${msg.sender} — ${formatTime(msg.timestamp)}${statusSuffix(msg.rich)}\n\n`;

  if (msg.rich && msg.rich.segments.length > 0) {
    out += renderSegments(msg.rich.segments);
  } else if (msg.body) {
    out += msg.body + '\n\n';
  }

  return out;
}

/**
 * 子 agent 消息嵌套渲染（v2.3.2 spec §5）：无 `##` 头（避免污染文档大纲），
 * 角色行 + 段内容，产出被 dispatch 段以引块包裹。
 */
export function renderSubMessage(msg: ExportMessage): string {
  const isBot = msg.botName !== null || msg.sender.startsWith('@bot.');
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  let out = `**${role}** — ${formatTime(msg.timestamp)}${statusSuffix(msg.rich)}\n\n`;
  if (msg.rich && msg.rich.segments.length > 0) {
    out += renderSegments(msg.rich.segments);
  } else if (msg.body) {
    out += `${msg.body}\n\n`;
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

  // 渲染每条消息（统一顶层，不再分组 dispatch/task_reply）
  for (const msg of messages) {
    out += renderMessage(msg) + '---\n\n';
  }

  out += `**导出结束（${meta.actualCount} 条消息）**\n`;
  return out;
}
