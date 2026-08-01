// renderer/src/components/im/DispatchCard.test.tsx
// DispatchCard 对话化后的渲染行为：归属（frame 头）+ 紧凑 target + 解析失败回退。
// useBotNameMap 读 agent.store，用 vi.mock 隔离成受控映射。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';

// 受控 botNameMap：主 agent + 子 agent 各一条
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map([['@coordinator:local', '协调员'], ['@coder:local', '码农']]),
  resolveBotName: (userId: string, m: Map<string, string>) => m.get(userId) ?? userId,
}));

import { DispatchCard } from './DispatchCard';

function makeDispatch(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    eventId: '$d1:local',
    roomId: '!team:local',
    sender: '@coordinator:local',
    body: '',
    eventType: 'io.momo-studio.dispatch',
    content: {
      body: '请实现登录页',
      task_id: 'task-abc1234567',
      dispatch_from: '@coordinator:local',
      dispatch_to: '@coder:local',
    },
    timestamp: 0,
    ...overrides,
  };
}

describe('DispatchCard', () => {
  it('frame 头显示主 agent 配置名（协调员）', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    // 名字由 MessageFrame 渲染（senderName prop）
    expect(screen.getByText('协调员')).toBeInTheDocument();
  });

  it('卡片内紧凑显示目标 agent（→ 码农）', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('请实现登录页')).toBeInTheDocument();
  });

  it('有 deadline_ms 时显示截止时间', () => {
    const msg = makeDispatch({
      content: {
        body: '任务',
        task_id: 'task-abc1234567',
        dispatch_from: '@coordinator:local',
        dispatch_to: '@coder:local',
        deadline_ms: 1800000000000,
      },
    });
    render(<DispatchCard message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByText(/截止/)).toBeInTheDocument();
  });

  it('无 deadline_ms 时不显示截止', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.queryByText(/截止/)).not.toBeInTheDocument();
  });

  it('content 缺 task_id 时回退为普通气泡（仍走 frame 保留归属）', () => {
    const msg = makeDispatch({ content: { body: '畸形', dispatch_from: '@c:local', dispatch_to: '@d:local' } });
    render(<DispatchCard message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('畸形')).toBeInTheDocument();
    expect(screen.getByText('协调员')).toBeInTheDocument();
  });
});
