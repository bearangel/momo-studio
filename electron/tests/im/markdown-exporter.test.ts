// electron/tests/im/markdown-exporter.test.ts
//
// formatRoomToMarkdown 纯函数测试。
//
// v2.0 A 子系统简化：
//   - 导出器仅输出 body + 时间戳 + sender（富字段 thinking/tool_calls/dispatch 已废弃）
//   - dispatch/task_reply 消息作为顶层消息统一渲染（不再分组嵌套）
import { describe, it, expect } from 'vitest';
import { formatRoomToMarkdown, type ExportMessage, type ExportMeta } from '../../src/main/im/markdown-exporter';

const meta: ExportMeta = {
  roomName: '项目经理办公室',
  roomId: '!abc:localhost',
  exportedAt: new Date('2026-08-12T14:30:15+08:00'),
  requestedLimit: 100,
  actualCount: 1,
};

function mkMsg(overrides: Partial<ExportMessage> = {}): ExportMessage {
  return {
    eventId: 'ev1',
    roomId: '!abc:localhost',
    sender: '@owner:localhost',
    body: '',
    eventType: 'm.room.message',
    content: {},
    timestamp: Date.parse('2026-08-12T13:15:42+08:00'),
    botName: null,
    ...overrides,
  };
}

describe('formatRoomToMarkdown 文件头', () => {
  it('含 # 会话导出：{roomName} + 元数据列表', () => {
    const out = formatRoomToMarkdown([], meta);
    expect(out).toContain('# 会话导出：项目经理办公室');
    expect(out).toContain('!abc:localhost');
    expect(out).toContain('2026-08-12 14:30:15');  // 导出时间本地化
    expect(out).toContain('最近 100 条（实际 1 条）');
  });
});

describe('用户消息', () => {
  it('渲染：## 👤 用户 @userId — 时间 + body', () => {
    const msg = mkMsg({ body: '帮我读 docs/spec.md' });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 👤 用户 @owner:localhost — 2026-08-12 13:15:42');
    expect(out).toContain('帮我读 docs/spec.md');
  });
});

describe('agent 文本消息', () => {
  it('渲染：## 🤖 {botName} @botId — 时间 + body', () => {
    const msg = mkMsg({
      sender: '@bot.pm-agent:localhost',
      botName: '项目经理',
      body: '已读完文件',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 项目经理 @bot.pm-agent:localhost —');
    expect(out).toContain('已读完文件');
  });

  it('botName 为 null 时 fallback shortName(sender)', () => {
    const msg = mkMsg({
      sender: '@bot.pm-agent:localhost',
      botName: null,
      body: '...',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 pm-agent @bot.pm-agent:localhost');
  });
});

describe('dispatch/task_reply 消息（A 子系统：统一顶层渲染）', () => {
  it('dispatch 消息作为顶层消息渲染 body', () => {
    const msg = mkMsg({
      eventType: 'io.momo-studio.dispatch',
      sender: '@bot.pm:localhost',
      botName: '项目经理',
      body: '实现第 3 章',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 项目经理 @bot.pm:localhost');
    expect(out).toContain('实现第 3 章');
  });

  it('task_reply 消息作为顶层消息渲染 body', () => {
    const msg = mkMsg({
      eventType: 'io.momo-studio.task_reply',
      sender: '@bot.coder:localhost',
      botName: 'coder',
      body: '已完成',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 coder @bot.coder:localhost');
    expect(out).toContain('已完成');
  });
});

describe('多消息分隔', () => {
  it('每条消息之间 --- 分隔，文件末尾「导出结束」标记', () => {
    const msgs = [
      mkMsg({ body: '第一条' }),
      mkMsg({ body: '第二条' }),
    ];
    const out = formatRoomToMarkdown(msgs, { ...meta, actualCount: 2 });
    expect(out).toContain('---');
    expect(out).toContain('**导出结束（2 条消息）**');
  });
});
