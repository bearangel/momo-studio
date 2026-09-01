// renderer/src/components/im/DispatchCard.test.tsx
// DispatchCard v2.0 A 子系统简化后的渲染行为。
//
// v2.0 A 子系统：ImMessage 已删除 content 字段，DispatchCard 改为仅用 ImMessage
// 字段（body / taskId / sender）渲染。富字段（dispatch_to / deadline_ms）由
// 父 agent 气泡的 DispatchChip 渲染，本卡片仅作防御性兜底。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { DispatchCard } from './DispatchCard';

function makeDispatch(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'd1',
    sessionId: '!team:local',
    sender: '@pm:local',
    body: '请实现登录页',
    eventType: 'io.momo-studio.dispatch',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: 'task-abc1234567',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('DispatchCard', () => {
  it('frame 头显示主 agent 配置名（协调员）', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('协调员')).toBeInTheDocument();
  });

  it('显示调度徽标', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('调度')).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('请实现登录页')).toBeInTheDocument();
  });

  it('taskId 为 null 时不显示 # 前缀', () => {
    render(<DispatchCard message={makeDispatch({ taskId: null })} isSelf={false} senderName="协调员" />);
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  it('body 为空时不渲染正文区', () => {
    render(<DispatchCard message={makeDispatch({ body: '' })} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('协调员')).toBeInTheDocument();
    expect(screen.getByText('调度')).toBeInTheDocument();
  });
});
