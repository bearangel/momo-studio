// renderer/src/components/im/MessageFrame.test.tsx
// MessageFrame 共享消息外壳的渲染行为测试。
// 纯组件，不依赖 store / IPC，无需 vi.mock。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageFrame } from './MessageFrame';

const SENDER = '@coder:local';

describe('MessageFrame', () => {
  it('非自己消息时显示 senderName', () => {
    render(
      <MessageFrame sender={SENDER} isSelf={false} senderName="coder-bot">
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.getByText('coder-bot')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });

  it('senderName 缺失时回退到 shortName（@coder:local → coder）', () => {
    render(
      <MessageFrame sender={SENDER} isSelf={false}>
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it('自己消息（isSelf）时不显示名字', () => {
    render(
      <MessageFrame sender={SENDER} isSelf={true} senderName="coder-bot">
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.queryByText('coder-bot')).not.toBeInTheDocument();
  });

  it('bubbleClassName 应用到内层气泡 div', () => {
    render(
      <MessageFrame sender={SENDER} isSelf={false} bubbleClassName="border-status-violet/40 bg-status-violet-tint">
        <span data-testid="child">x</span>
      </MessageFrame>,
    );
    const bubble = screen.getByTestId('child').parentElement;
    expect(bubble?.className).toContain('border-status-violet/40');
    expect(bubble?.className).toContain('rounded-lg');
  });

  it('渲染 children', () => {
    render(
      <MessageFrame sender={SENDER} isSelf={false}>
        <span data-testid="child">子内容</span>
      </MessageFrame>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

describe('MessageFrame — 时间戳（v2.1）', () => {
  const TS = new Date('2026-09-06T14:32:00').getTime(); // 本地时区构造，断言同源

  it('非自己消息：名字行旁显示 HH:mm', () => {
    render(
      <MessageFrame sender="@bot:server" isSelf={false} senderName="coder" timestamp={TS}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.getByText('14:32')).toBeInTheDocument();
  });

  it('自己消息：气泡下方右对齐显示时间', () => {
    render(
      <MessageFrame sender="@owner:server" isSelf={true} timestamp={TS}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.getByText('14:32')).toBeInTheDocument();
  });

  it('不传 timestamp 不渲染时间', () => {
    render(
      <MessageFrame sender="@bot:server" isSelf={false}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
  });
});
