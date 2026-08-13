// electron/src/main/im/markdown-exporter.ts
//
// 会话导出 Markdown 格式化纯函数。无 IPC / DB 依赖——IPC handler 反查 agent 名字
// 后注入 ExportMessage.botName 字段传入。
//
// v2.0 A 子系统简化：
//   - Matrix event content 富字段（thinking/tool_calls/dispatch 元数据）已废弃，
//     富信息统一在 message_events 表（renderer 端用 aggregateEvents 重建）。
//   - 导出器简化为仅输出 body + 时间戳 + sender（富信息导出留 v2 后续增强）。
//   - 所有消息统一渲染为顶层条目（不再分组 dispatch/task_reply 嵌套）。

import type { MatrixMessagePayload } from '../matrix/sync-manager';

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
  let out = `## ${icon} ${role} ${msg.sender} — ${formatTime(msg.timestamp)}\n\n`;

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

  // 渲染每条消息（统一顶层，不再分组 dispatch/task_reply）
  for (const msg of messages) {
    out += renderMessage(msg) + '---\n\n';
  }

  out += `**导出结束（${meta.actualCount} 条消息）**\n`;
  return out;
}
