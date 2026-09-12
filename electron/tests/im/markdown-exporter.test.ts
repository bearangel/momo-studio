// electron/tests/im/markdown-exporter.test.ts
//
// formatRoomToMarkdown 纯函数测试。
//
// v2.0 A 子系统简化：
//   - 导出器仅输出 body + 时间戳 + sender（富字段 thinking/tool_calls/dispatch 已废弃）
//   - dispatch/task_reply 消息作为顶层消息统一渲染（不再分组嵌套）
import { describe, it, expect } from 'vitest';
import { formatRoomToMarkdown, renderSubMessage, TOOL_RESULT_MAX_CHARS, type ExportMessage, type ExportMeta } from '../../src/main/im/markdown-exporter';

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

describe('富信息渲染（v2.3.2）', () => {
  const base: ExportMessage = {
    eventId: 'e1', roomId: 'r1', sender: '@a:home', body: '',
    eventType: 'm.room.message', content: {}, timestamp: 1700000000000, botName: 'coder',
  };

  it('段序列交错渲染：text → 工具块 → dispatch → todo', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [
        { kind: 'text', text: '先看目录' },
        { kind: 'tool', callId: 'c1', toolName: 'list_files', args: { path: '/src' }, result: 'a.ts', success: true },
        { kind: 'dispatch', callId: 'd1', subStreamSessionId: 'ss-sub', subAgentName: 'tester', task: '验证', status: 'completed', subMarkdown: '**tester** — 2026\n\n验证通过' },
        { kind: 'todo', items: [{ id: '1', subject: 'A', status: 'completed', source: 'agent' }, { id: '2', subject: 'B', status: 'in_progress', source: 'agent' }, { id: '3', subject: 'C', status: 'pending', source: 'agent' }] },
      ], status: 'done' } }],
      { roomName: '测试', roomId: 'r1', exportedAt: new Date(), requestedLimit: 10, actualCount: 1 },
    );
    const iText = md.indexOf('先看目录');
    const iTool = md.indexOf('🔧 **工具** `list_files` → `{"path":"/src"}`');
    const iDisp = md.indexOf('📤 **委派** tester：验证 —— ✅ completed');
    const iTodo = md.indexOf('- ✓ A');
    expect(iText).toBeGreaterThanOrEqual(0);
    expect(iTool).toBeGreaterThan(iText);
    expect(iDisp).toBeGreaterThan(iTool);
    expect(iTodo).toBeGreaterThan(iDisp);
    expect(md).toContain('> a.ts');                       // 结果进引块
    expect(md).toContain('> **tester** — 2026');          // 子回复引块嵌套
    expect(md).toContain('> 验证通过');
    expect(md).toContain('- ◐ B');
    expect(md).toContain('- ○ C');
  });

  it('工具结果截断 2000 字符并标注原长', () => {
    const long = 'x'.repeat(2500);
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [
        { kind: 'tool', callId: 'c1', toolName: 'grep', args: {}, result: long, success: true },
      ], status: 'done' } }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(TOOL_RESULT_MAX_CHARS).toBe(2000);
    expect(md).toContain('（已截断，原文 2500 字符）');
    expect(md).not.toContain('x'.repeat(2001));
  });

  it('无 rich 字段回退纯 body（legacy 兼容路径不变）', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, body: '纯正文' }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(md).toContain('纯正文');
    expect(md).not.toContain('🔧');
  });

  it('failed/aborted 消息头带状态标注与错误文本', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [{ kind: 'text', text: '部分输出' }], status: 'failed', error: '429' } }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(md).toMatch(/## 🤖 coder .*（失败：429）/);
  });

  it('renderSubMessage：无 ## 头、含角色行与段内容', () => {
    const out = renderSubMessage({ ...base, rich: { segments: [{ kind: 'text', text: '子回复' }], status: 'done' } });
    expect(out).not.toContain('## ');
    expect(out).toContain('**coder** — ');
    expect(out).toContain('子回复');
  });

  it('dispatch subOmitted 渲染省略标记；无子内容仅显示状态', () => {
    const mk = (seg: Parameters<typeof renderSubMessage>[0]['rich']): string =>
      formatRoomToMarkdown(
        [{ ...base, rich: seg }],
        { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
      );
    expect(mk({ segments: [{ kind: 'dispatch', callId: 'd1', subStreamSessionId: 's', subAgentName: 't', task: 'x', status: 'completed', subOmitted: true }], status: 'done' })).toContain('（深层委派已省略）');
    expect(mk({ segments: [{ kind: 'dispatch', callId: 'd1', subStreamSessionId: 's', subAgentName: 't', task: 'x', status: 'completed' }], status: 'done' })).toContain('✅ completed');
  });
});
