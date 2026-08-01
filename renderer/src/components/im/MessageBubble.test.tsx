// renderer/src/components/im/MessageBubble.test.tsx
// MessageBubble 路由行为：按 eventType 分发到 DispatchCard/TaskReplyCard/普通气泡，
// 并正确透传 isSelf + senderName。用 vi.mock 把卡片替换为可控桩，隔离 store 依赖。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
