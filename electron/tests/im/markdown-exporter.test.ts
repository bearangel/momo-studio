// electron/tests/im/markdown-exporter.test.ts
//
// formatRoomToMarkdown 纯函数测试：覆盖文件头 / 用户消息 / agent 文本 /
// thinking 折叠 / tool_calls 表格 / dispatch 嵌套 / 多消息分隔 共 11 个用例。
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

describe('thinking 渲染', () => {
  it('渲染为 **💭 thinking** + 引用块（> 前缀）', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: { 'io.momo-studio.thinking': '用户想读文件...' },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('**💭 thinking**');
    expect(out).toContain('> 用户想读文件...');
  });
});

describe('tool_calls 渲染', () => {
  it('表格：工具/参数/结果', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'read_file',
          args: { path: 'docs/spec.md' },
          result: '文件内容...',
          success: true,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('**🔧 工具调用**');
    expect(out).toContain('| 工具 | 参数 | 结果 |');
    expect(out).toContain('`read_file`');
    expect(out).toContain('"path": "docs/spec.md"');
    expect(out).toContain('✅ 成功');
  });

  it('result 超 500 字符：表格摘要 + 单独代码块展开完整', () => {
    const longResult = 'x'.repeat(800);
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'read_file',
          args: { path: 'big.txt' },
          result: longResult,
          success: true,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    // 表格摘要显示总字符数
    expect(out).toContain('✅ 成功（返回 800 字符）');
    // 完整结果在代码块（不折叠）
    expect(out).toContain('**📄 read_file 完整结果（800 字符）**');
    expect(out).toContain(longResult);
  });

  it('失败 tool_call：❌ + error message', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'bash',
          args: { cmd: 'rm -rf /' },
          result: '命令被黑名单拒绝',
          success: false,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('❌ 失败');
    expect(out).toContain('命令被黑名单拒绝');
  });
});

describe('dispatch 嵌套', () => {
  it('渲染为 📨 委派块 + 子 agent 信息', () => {
    const dispatchMsg = mkMsg({
      eventId: 'd1',
      eventType: 'io.momo-studio.dispatch',
      sender: '@bot.pm:localhost',
      botName: '项目经理',
      body: '实现第 3 章',
      content: {
        body: '实现第 3 章',
        task_id: 't1',
        dispatch_from: '@bot.pm:localhost',
        dispatch_to: '@bot.coder:localhost',
      },
      timestamp: Date.parse('2026-08-12T13:20:15+08:00'),
    });
    const replyMsg = mkMsg({
      eventId: 'r1',
      eventType: 'io.momo-studio.task_reply',
      sender: '@bot.coder:localhost',
      botName: 'coder',
      body: '已完成',
      content: {
        body: '已完成',
        task_id: 't1',
        status: 'completed',
      },
      timestamp: Date.parse('2026-08-12T13:25:00+08:00'),
    });
    const out = formatRoomToMarkdown([dispatchMsg, replyMsg], meta);
    // dispatch 作为顶层消息
    expect(out).toContain('📨 委派子 agent：coder');
    // task_reply 嵌套进 dispatch 块（不作为顶层 ## 标题）
    expect(out).toContain('子 agent coder 工作过程');
    expect(out).toContain('已完成');
    // task_reply 不应作为顶层消息标题
    expect(out).not.toMatch(/## 🤖 coder @bot\.coder:localhost — 2026-08-12 13:25:00\n\n已完成\n\n---/);
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
