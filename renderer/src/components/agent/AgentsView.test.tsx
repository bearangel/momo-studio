// renderer/src/components/agent/AgentsView.test.tsx
//
// v25 Task 12：AgentsView 双 Tab 测试（spec §6.1）。
// Tab 容器 =「Agent 成员」/「团队」：默认成员 Tab（MembersPanel），切「团队」
// 渲染 TeamsPanel 且 MembersPanel 不渲染。旧「本工作空间 / Agent 库」双 Tab
// 随 WorkspaceAgentsPanel/AgentLibrary 退役；L2 工作空间共享能力面板已废弃拆除。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// 子面板桩：隔离 AgentsView 的 tab 切换逻辑与面板内部 store/IPC 依赖
vi.mock('./MembersPanel', () => ({
  MembersPanel: () => <div data-testid="members-panel" />,
}));
vi.mock('./TeamsPanel', () => ({
  TeamsPanel: () => <div data-testid="teams-panel" />,
}));

const { AgentsView } = await import('./AgentsView');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [{
      id: 'ws-1',
      name: '测试工作空间',
      description: '',
      directoryPath: '/tmp/ws',
      gitInitialized: true,
      createdAt: '',
      ownerId: 'u',
      iconEmoji: '📁',
      defaultAgentInstanceId: null,
    }],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [],
    members: [],
    teams: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn().mockResolvedValue(undefined),
  });
});

describe('AgentsView — 双 Tab 切换（spec §6.1）', () => {
  it('默认激活「Agent 成员」Tab：渲染 MembersPanel，无 L2 共享能力区', async () => {
    render(<AgentsView />);

    await waitFor(() => {
      expect(screen.getByTestId('members-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('teams-panel')).not.toBeInTheDocument();
    // L2 面板已废弃：区块标题不渲染
    expect(screen.queryByText(/工作空间共享能力/)).not.toBeInTheDocument();
  });

  it('切到「团队」Tab → 渲染 TeamsPanel，MembersPanel 不渲染', async () => {
    render(<AgentsView />);

    await waitFor(() => {
      expect(screen.getByTestId('members-panel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '团队' }));

    await waitFor(() => {
      expect(screen.getByTestId('teams-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('members-panel')).not.toBeInTheDocument();
  });

  it('「团队」Tab 切回「Agent 成员」→ MembersPanel 恢复渲染', async () => {
    render(<AgentsView />);

    await waitFor(() => {
      expect(screen.getByTestId('members-panel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '团队' }));
    await waitFor(() => {
      expect(screen.getByTestId('teams-panel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent 成员' }));

    await waitFor(() => {
      expect(screen.getByTestId('members-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('teams-panel')).not.toBeInTheDocument();
  });
});
