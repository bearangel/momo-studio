// renderer/src/components/im/TaskReplyCard.test.tsx
// TaskReplyCard 归属修复后的渲染行为。
// 卡片不调 useBotNameMap（senderName 经 prop 传入），无需 mock store。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { TaskReplyCard } from './TaskReplyCard';

function makeReply(status: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    eventId: '$r1:local',
    roomId: '!team:local',
    sender: '@coder:local',
    body: '',
    eventType: 'io.momo-studio.task_reply',
    content: { body: '任务完成结果', task_id: 'task-abc1234567', status },
    timestamp: 0,
    ...overrides,
  };
}

describe('TaskReplyCard', () => {
  it('frame 头显示子 agent 配置名（码农）', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('码农')).toBeInTheDocument();
  });

  it('senderName 缺失时 frame 回退 shortName（@coder:local → coder）', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} />);
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it.each([
    ['completed', '已完成'],
    ['in_progress', '进行中'],
    ['failed', '失败'],
    ['needs_input', '需补充输入'],
  ])('status=%s 显示对应 label %s', (status, label) => {
    render(<TaskReplyCard message={makeReply(status)} isSelf={false} senderName="码农" />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('任务完成结果')).toBeInTheDocument();
  });

  it('有 progress_pct 时显示进度条', () => {
    const msg = makeReply('in_progress', {
      content: { body: '处理中', task_id: 'task-abc1234567', status: 'in_progress', progress_pct: 60 },
    });
    const { container } = render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width: 60%"]');
    expect(bar).not.toBeNull();
  });

  it('无 progress_pct 时不显示进度条', () => {
    const { container } = render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width:');
    expect(bar).toBeNull();
  });

  it('progress_pct 钳到 0-100（150 → 100）', () => {
    const msg = makeReply('in_progress', {
      content: { body: 'x', task_id: 'task-abc1234567', status: 'in_progress', progress_pct: 150 },
    });
    const { container } = render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width: 100%"]');
    expect(bar).not.toBeNull();
  });

  it('content 缺 task_id 时回退普通气泡（仍走 frame 保留归属）', () => {
    const msg = makeReply('completed', { content: { body: '畸形', status: 'completed' } });
    render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('畸形')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
  });
});