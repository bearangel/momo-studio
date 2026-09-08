// renderer/src/components/task-board/TaskCard.test.tsx
//
// TaskCard 增量展示（Task 9）：
//   - assigned + queueRank → 标题行「排队 #N」徽标（text-status-warning）
//   - recurrenceRule → Repeat 图标 + humanizeRecurrence 文案；
//     pending 且有 scheduledAt → 「下次 …」时间
// K4：指派/团队/会话目标显示名称（useTaskEntityNames 解析 store 数据），
//     不再显示 ID 片段。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import type { TaskRow, WorkspaceAgentMember } from '../../ipc/types';
import { useAgentStore } from '../../stores/agent.store';

const mockApi = {
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
};

const base: TaskRow = {
  id: 'T-001', workspaceId: 'ws1', title: '任务A', description: '', status: 'assigned',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
};

function mkMember(instanceId: string, agentName: string): WorkspaceAgentMember {
  return {
    instanceId,
    workspaceId: 'ws1',
    agentDefinitionId: `def-${instanceId}`,
    agentUserId: `@${instanceId}:s`,
    agentName,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '2026-01-01',
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.agent.listMembers.mockClear();
  useAgentStore.setState({
    members: [mkMember('inst-coder-99', 'coder')],
    teams: [
      {
        id: 'team-rd-01',
        workspaceId: 'ws1',
        name: '研发一组',
        iconEmoji: '',
        leaderInstanceId: 'x',
        members: [],
        createdAt: '2026-01-01',
      },
    ],
  });
});

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

describe('TaskCard 名称化（K4）', () => {
  it('指派 agent 显示名称而非 ID 片段', () => {
    render(
      <TaskCard
        task={{ ...base, assigneeAgentId: 'inst-coder-99' }}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.queryByText(/inst-coder/)).not.toBeInTheDocument();
  });

  it('团队目标显示名称而非 ID 片段', () => {
    render(
      <TaskCard
        task={{ ...base, targetTeamId: 'team-rd-01' }}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('研发一组')).toBeInTheDocument();
    expect(screen.queryByText(/team-rd/)).not.toBeInTheDocument();
  });
});
