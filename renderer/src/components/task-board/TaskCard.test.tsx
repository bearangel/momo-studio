// renderer/src/components/task-board/TaskCard.test.tsx
//
// TaskCard 增量展示（Task 9）：
//   - assigned + queueRank → 标题行「排队 #N」徽标（text-status-warning）
//   - recurrenceRule → Repeat 图标 + humanizeRecurrence 文案；
//     pending 且有 scheduledAt → 「下次 …」时间
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import type { TaskRow } from '../../ipc/types';

const base: TaskRow = {
  id: 'T-001', workspaceId: 'ws1', title: '任务A', description: '', status: 'assigned',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
};

describe('TaskCard 增量展示', () => {
  it('assigned + queueRank → 显示「排队 #N」', () => {
    render(<TaskCard task={base} selected={false} onSelect={() => {}} queueRank={2} />);
    expect(screen.getByText(/排队 #2/)).toBeInTheDocument();
  });
  it('recurrenceRule → 显示循环标记 + pending 显示下次时间', () => {
    render(<TaskCard task={{ ...base, status: 'pending', recurrenceRule: 'daily@09:00', scheduledAt: Date.now() + 3600_000 }} selected={false} onSelect={() => {}} />);
    expect(screen.getByText(/每天 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/下次/)).toBeInTheDocument();
  });
});
