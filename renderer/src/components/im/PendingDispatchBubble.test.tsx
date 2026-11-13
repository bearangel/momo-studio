// renderer/src/components/im/PendingDispatchBubble.test.tsx
//
// 启动期排队占位气泡回归锁（spec 2026-11-13；预览方案 A）。
// 锁：主文案「正在启动智能体」+ 排队条数副行 + 超时态转红提示 + agent 身份展示。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingDispatchBubble } from './PendingDispatchBubble';
import type { PendingDispatchState } from '../../ipc/types';

function mkState(over: Partial<PendingDispatchState> = {}): PendingDispatchState {
  return {
    sessionId: 's1',
    count: 1,
    timedOut: false,
    agentName: '代码专家',
    iconEmoji: '🧑‍💻',
    ...over,
  };
}

describe('PendingDispatchBubble（启动期排队占位）', () => {
  it('单条排队：agent 名 + 启动中文案 + 就绪后自动发送', () => {
    render(<PendingDispatchBubble state={mkState()} />);

    expect(screen.getByTestId('pending-dispatch-bubble')).toBeInTheDocument();
    expect(screen.getByText('代码专家')).toBeInTheDocument();
    expect(screen.getByText('正在启动智能体')).toBeInTheDocument();
    expect(screen.getByText('消息已排队，就绪后自动发送')).toBeInTheDocument();
  });

  it('多条排队：副行显示条数', () => {
    render(<PendingDispatchBubble state={mkState({ count: 3 })} />);
    expect(screen.getByText('消息已排队（3 条），就绪后自动发送')).toBeInTheDocument();
  });

  it('等待超时：转红提示可重发，不再显示启动中文案', () => {
    render(<PendingDispatchBubble state={mkState({ timedOut: true })} />);

    expect(screen.getByText('智能体启动超时，请稍后重发')).toBeInTheDocument();
    expect(screen.queryByText('正在启动智能体')).not.toBeInTheDocument();
  });

  it('agent 名缺失时不渲染名字行（emoji 缺失时回退 lucide 图标）', () => {
    render(<PendingDispatchBubble state={mkState({ agentName: '', iconEmoji: '' })} />);
    expect(screen.queryByText('代码专家')).not.toBeInTheDocument();
    expect(screen.getByText('正在启动智能体')).toBeInTheDocument();
  });
});
