// renderer/src/components/im/TaskReplyCard.test.tsx
// TaskReplyCard v2.0 A 子系统简化后的渲染行为。
//
// v2.0 A 子系统：ImMessage 已删除 content 字段，TaskReplyCard 改为仅用 ImMessage
// 字段（body / taskId / sender）渲染。富字段（status / progress_pct）由父 agent
// 气泡的 DispatchChip 渲染，本卡片仅作防御性兜底。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { TaskReplyCard } from './TaskReplyCard';

function makeReply(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'r1',
    roomId: '!team:local',
    sender: '@coder:local',
    body: '任务完成结果',
    eventType: 'io.momo-studio.task_reply',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    matrixEventId: null,
    workspaceId: null,
    taskId: 'task-abc1234567',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('TaskReplyCard', () => {
  it('frame 头显示子 agent 配置名（码农）', () => {
    render(<TaskReplyCard message={makeReply()} isSelf={false} senderName="码农" />);
    expect(screen.getByText('码农')).toBeInTheDocument();
  });

  it('senderName 缺失时 frame 回退 shortName（@coder:local → coder）', () => {
    render(<TaskReplyCard message={makeReply()} isSelf={false} />);
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it('显示任务回执徽标', () => {
    render(<TaskReplyCard message={makeReply()} isSelf={false} senderName="码农" />);
    expect(screen.getByText('任务回执')).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<TaskReplyCard message={makeReply()} isSelf={false} senderName="码农" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<TaskReplyCard message={makeReply()} isSelf={false} senderName="码农" />);
    expect(screen.getByText('任务完成结果')).toBeInTheDocument();
  });

  it('taskId 为 null 时不显示 # 前缀', () => {
    render(<TaskReplyCard message={makeReply({ taskId: null })} isSelf={false} senderName="码农" />);
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });
});
