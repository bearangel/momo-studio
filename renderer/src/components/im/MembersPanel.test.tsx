// renderer/src/components/im/MembersPanel.test.tsx
// MembersPanel 成员列表：在线/离线 badge 渲染。
// mock im.store（selector 模式）+ agent.store（返回受控 assignments/running）+ useBotNames。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentAssignment, RoomMember } from '../../ipc/types';

// 受控 agent store 数据
const mockAssignments: AgentAssignment[] = [
  { instanceId: 'inst-online', workspaceId: 'w1', agentDefinitionId: 'd1',
    botMatrixUserId: '@online-bot:local', enabled: true, createdAt: '',
    role: 'standalone', parentInstanceId: null, hasApiKeyOverride: false },
  { instanceId: 'inst-offline', workspaceId: 'w1', agentDefinitionId: 'd2',
    botMatrixUserId: '@offline-bot:local', enabled: true, createdAt: '',
    role: 'standalone', parentInstanceId: null, hasApiKeyOverride: false },
];
const mockRunning: Record<string, boolean> = {
  'inst-online': true,
  'inst-offline': false,
};

vi.mock('../../stores/agent.store', () => ({
  useAgentStore: vi.fn(() => ({
    assignments: mockAssignments,
    running: mockRunning,
  })),
}));
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map([['@online-bot:local', '在线Agent'], ['@offline-bot:local', '离线Agent']]),
  resolveBotName: (userId: string, m: Map<string, string>) => m.get(userId) ?? userId,
}));

import { MembersPanel } from './MembersPanel';

// 模拟 im.store 的 selector 调用
const mockMembers: RoomMember[] = [
  { userId: '@online-bot:local', displayName: '在线Agent', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@offline-bot:local', displayName: '离线Agent', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@no-assign-bot:local', displayName: '无Assignment的Bot', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@local:local', displayName: '我', avatarUrl: null, powerLevel: 100, isBot: false, isLocalUser: true },
];

vi.mock('../../stores/im.store', () => ({
  useImStore: vi.fn((selector?: (s: { members: RoomMember[] }) => unknown) => {
    const state = { members: mockMembers };
    return selector ? selector(state) : state;
  }),
}));

describe('MembersPanel 在线/离线标签', () => {
  it('运行中的 bot 显示"在线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('在线Agent')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
  });

  it('已停止的 bot 显示"离线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('离线Agent')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
  });

  it('无 assignment 的 bot 不显示在线/离线标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('无Assignment的Bot')).toBeInTheDocument();
    // 在线/离线 badge 各只有一个（在线Agent 和 离线Agent），无Assignment的Bot 没有
    const badges = screen.getAllByText(/^(在线|离线)$/);
    expect(badges).toHaveLength(2);
  });

  it('非 bot 成员（本地用户）不显示在线/离线标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('我')).toBeInTheDocument();
    // 总共只有 2 个 badge（在线Agent + 离线Agent）
    const badges = screen.getAllByText(/^(在线|离线)$/);
    expect(badges).toHaveLength(2);
  });

  it('显示成员数量标题', () => {
    render(<MembersPanel />);
    expect(screen.getByText(/成员（4）/)).toBeInTheDocument();
  });

  it('浮层定位为 absolute right-0（覆盖模式）', () => {
    const { container } = render(<MembersPanel />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('absolute');
    expect(aside?.className).toContain('right-0');
    expect(aside?.className).toContain('z-30');
  });
});
