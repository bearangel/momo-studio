// renderer/src/components/im/MessageBubble.test.tsx
// MessageBubble 路由行为：按 eventType 分发到 DispatchCard/TaskReplyCard/普通气泡，
// 并正确透传 isSelf + senderName。用 vi.mock 把卡片替换为可控桩，隔离 store 依赖。
// v1.4：补充增强气泡测试——content 含 io.momo-studio.thinking / tool_calls 时渲染
// ThinkingSection + ToolCallChip（这两个组件不 mock，测真实集成）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';

// 把两个卡片 mock 成带 testid 的桩，便于断言"哪个被渲染"+ 捕获 props
vi.mock('./DispatchCard', () => ({
  DispatchCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="dispatch" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./TaskReplyCard', () => ({
  TaskReplyCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="task-reply" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));

import { MessageBubble } from './MessageBubble';

describe('MessageBubble 路由', () => {
  it('io.momo-studio.dispatch → DispatchCard', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.dispatch', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('dispatch')).toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });

  it('dispatch 透传 isSelf + senderName', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.dispatch', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={true} senderName="协调员" />);
    const card = screen.getByTestId('dispatch');
    expect(card).toHaveAttribute('data-self', 'true');
    expect(card).toHaveAttribute('data-name', '协调员');
  });

  it('io.momo-studio.task_reply → TaskReplyCard', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.task_reply', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByTestId('task-reply')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
  });

  it('task_reply 透传 isSelf + senderName', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.task_reply', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    const card = screen.getByTestId('task-reply');
    expect(card).toHaveAttribute('data-self', 'false');
    expect(card).toHaveAttribute('data-name', '码农');
  });

  it('m.room.message → 普通气泡（走 MessageFrame，显示 body）', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '你好',
      eventType: 'm.room.message', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });
});

describe('MessageBubble 增强（agent 持久化字段）', () => {
  it('content 含 io.momo-studio.thinking → 渲染 ThinkingSection', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '回复正文',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.thinking': '深度分析中...' },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    // ThinkingSection 的 toggle 按钮可见
    expect(screen.getByText(/思考过程/)).toBeInTheDocument();
    // 正文也渲染
    expect(screen.getByText('回复正文')).toBeInTheDocument();
  });

  it('ThinkingSection 展开后显示 thinking 内容（content 正确透传）', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '回复',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.thinking': '我在认真思考' },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    // 默认折叠：内容不可见
    expect(screen.queryByText('我在认真思考')).not.toBeInTheDocument();
    // 点击展开
    fireEvent.click(screen.getByText(/思考过程/));
    expect(screen.getByText('我在认真思考')).toBeInTheDocument();
  });

  it('content 含 io.momo-studio.tool_calls → 渲染 ToolCallChip', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '回复正文',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          { name: 'read_file', args: { path: 'a.ts' }, result: '内容', success: true },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    // ToolCallChip 头部的工具名可见
    expect(screen.getByText('read_file')).toBeInTheDocument();
    // 正文也渲染
    expect(screen.getByText('回复正文')).toBeInTheDocument();
    // 不应渲染 ThinkingSection
    expect(screen.queryByText(/思考过程/)).not.toBeInTheDocument();
  });

  it('thinking + tool_calls 同时存在 → 两者都渲染', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '最终回复',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.thinking': '先想想',
        'io.momo-studio.tool_calls': [
          { name: 'grep', args: { q: 'x' }, result: '命中', success: true },
          { name: 'bash', args: { cmd: 'ls' }, result: 'done', success: false },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText(/思考过程/)).toBeInTheDocument();
    // 两个工具名都可见
    expect(screen.getByText('grep')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('最终回复')).toBeInTheDocument();
  });

  it('content 仅含 stream_session_id（无 thinking/tools）→ 普通气泡', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '纯文本回复',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.stream_session_id': 'sess-123' },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('纯文本回复')).toBeInTheDocument();
    // 无 ThinkingSection
    expect(screen.queryByText(/思考过程/)).not.toBeInTheDocument();
  });

  it('tool_calls 字段格式非法（非数组）→ 安全降级为普通气泡', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '回复',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.tool_calls': '不是数组' },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('回复')).toBeInTheDocument();
    // 非法格式被 extractAgentMeta 过滤，不渲染工具卡片
  });
});

describe('MessageBubble 历史 dispatch chips（v1.4）', () => {
  it('tool_calls 含 dispatch: 前缀 → 渲染 DispatchChip（不渲染 ToolCallChip）', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: 'PM 汇总',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          { name: 'dispatch:coder', args: { task: '写代码' }, result: '完成', success: true },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    // DispatchChip 头行的 📤 图标可见
    expect(screen.getByText('📤')).toBeInTheDocument();
    // 子 agent 名从 slug 推导（dispatch:coder → coder）
    expect(screen.getByText('coder')).toBeInTheDocument();
    // completed 状态文案可见
    expect(screen.getByText(/完成/)).toBeInTheDocument();
    // 不应作为 ToolCallChip 渲染（完整工具名 dispatch:coder 不出现）
    expect(screen.queryByText('dispatch:coder')).not.toBeInTheDocument();
    // 正文仍渲染
    expect(screen.getByText('PM 汇总')).toBeInTheDocument();
  });

  it('tool_calls 含 isDispatch:true + subAgentName → DispatchChip 显示 subAgentName', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '已委派',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          {
            name: 'dispatch:researcher',
            args: {},
            result: 'ok',
            success: true,
            isDispatch: true,
            subStreamSessionId: 'sub-sess-1',
            subAgentName: '研究员',
            subAgentAvatar: '🔬',
          },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    // 使用持久化的 subAgentName（而非 slug）
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText('🔬')).toBeInTheDocument();
    expect(screen.getByText('📤')).toBeInTheDocument();
  });

  it('dispatch 失败（success:false）→ DispatchChip 显示失败状态', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '委派出错',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          { name: 'dispatch:coder', args: {}, result: '超时', success: false },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('📤')).toBeInTheDocument();
    // failed 状态文案
    expect(screen.getByText(/失败/)).toBeInTheDocument();
  });

  it('dispatch + 普通工具混合 → DispatchChip 与 ToolCallChip 共存', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '综合回复',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          { name: 'read_file', args: { path: 'a.ts' }, result: '内容', success: true },
          { name: 'dispatch:coder', args: {}, result: 'done', success: true },
          { name: 'bash', args: { cmd: 'ls' }, result: 'out', success: true },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    // 普通工具作为 ToolCallChip（工具名可见）
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    // dispatch 作为 DispatchChip
    expect(screen.getByText('📤')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
    // dispatch:coder 不作为 ToolCallChip 渲染
    expect(screen.queryByText('dispatch:coder')).not.toBeInTheDocument();
  });

  it('仅普通 tool_calls（无 dispatch）→ 不渲染 DispatchChip', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '纯工具回复',
      eventType: 'm.room.message',
      content: {
        'io.momo-studio.tool_calls': [
          { name: 'read_file', args: { path: 'b.ts' }, result: 'x', success: true },
        ],
      },
      timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('read_file')).toBeInTheDocument();
    // 无 DispatchChip（无 📤 图标）
    expect(screen.queryByText('📤')).not.toBeInTheDocument();
  });
});
