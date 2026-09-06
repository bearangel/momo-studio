// renderer/src/components/agent/AddAgentDialog.test.tsx
//
// 添加已有 Agent 弹窗（Bug 3）：全量定义列表（builtin + custom），
// 排除当前 workspace 已加入的 def；点「加入」走 agent.store.addMember。
//
// Mock 策略（momo-test-rules）：window.api 桩（agent 命名空间）；
// store setState 注入 action 桩——loadMembers 用 mockImplementation 回写 store，
// 仿真「加入成功后成员列表更新 → 行消失」的真实数据流。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddAgentDialog } from './AddAgentDialog';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

const agentList = vi.fn();
const agentListMembers = vi.fn();
const agentAddMember = vi.fn();

beforeEach(() => {
  agentList.mockReset();
  agentListMembers.mockReset();
  agentAddMember.mockReset();

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    agent: { list: agentList, listMembers: agentListMembers, addMember: agentAddMember },
  };

  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'ws-1',
        name: 'WS',
        description: '',
        directoryPath: '/tmp',
        gitInitialized: true,
        createdAt: '',
        ownerId: 'u',
        iconEmoji: '📁',
        defaultAgentInstanceId: null,
      },
    ],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
    setDefaultAgent: vi.fn(),
  });
});

/** 全量字段 AgentDefinition fixture */
function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'def-x',
    name: 'X',
    slug: 'x',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [],
    source: 'custom',
    description: 'd',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'p1',
    modelName: 'm',
    ...overrides,
  };
}

/** 全量字段成员 fixture */
function member(defId: string, name: string): WorkspaceAgentMember {
  return {
    instanceId: `inst-${defId}`,
    workspaceId: 'ws-1',
    agentDefinitionId: defId,
    agentUserId: `@${defId}:local`,
    agentName: name,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '',
  };
}

/** store 种子：definitions + members + action 桩 */
function seedStore(defs: AgentDefinition[], members: WorkspaceAgentMember[]): void {
  useAgentStore.setState({
    definitions: defs,
    members,
    teams: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn().mockImplementation(async () => {
      useAgentStore.setState({ definitions: defs });
    }),
    loadMembers: vi.fn().mockImplementation(async () => {
      useAgentStore.setState({ members });
    }),
    loadBuiltinSuggestions: vi.fn(),
    addMember: agentAddMember,
    removeMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    loadTeams: vi.fn(),
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: vi.fn(),
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });
}

describe('AddAgentDialog — 列表与过滤', () => {
  it('全量列出 builtin + custom；已加入当前 ws 的 def 不显示', async () => {
    seedStore(
      [
        def({ id: 'def-b', name: '内置编码员', slug: 'coder', source: 'builtin' }),
        def({ id: 'def-c', name: '审查员', slug: 'reviewer', source: 'custom' }),
        def({ id: 'def-in', name: '已在工作空间的', slug: 'already-in', source: 'custom' }),
      ],
      [member('def-in', '已在工作空间的')],
    );

    render(<AddAgentDialog onClose={() => {}} />);
    expect(await screen.findByText('内置编码员')).toBeInTheDocument();
    expect(screen.getByText('审查员')).toBeInTheDocument();
    expect(screen.queryByText('已在工作空间的')).not.toBeInTheDocument();
  });

  it('source 徽标：builtin=系统预置，custom=自定义', async () => {
    seedStore(
      [
        def({ id: 'def-b', name: '内置编码员', slug: 'coder', source: 'builtin' }),
        def({ id: 'def-c', name: '审查员', slug: 'reviewer', source: 'custom' }),
      ],
      [],
    );
    render(<AddAgentDialog onClose={() => {}} />);
    await screen.findByText('内置编码员');
    expect(screen.getByText('系统预置')).toBeInTheDocument();
    expect(screen.getByText('自定义')).toBeInTheDocument();
  });
});

describe('AddAgentDialog — 加入动作', () => {
  it('点「加入」→ addMember(ws-1, def.id)；成功后该行从列表消失', async () => {
    const defs = [def({ id: 'def-c', name: '审查员', slug: 'reviewer' })];
    seedStore(defs, []);
    agentAddMember.mockImplementation(async (_ws: string, defId: string) => {
      // 仿真真实 store addMember 成功后的 members 追加（组件靠 members 响应式重算使行消失）
      useAgentStore.setState({ members: [member(defId, '审查员')] });
      return member(defId, '审查员');
    });

    render(<AddAgentDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '加入' }));

    await waitFor(() => {
      expect(agentAddMember).toHaveBeenCalledWith('ws-1', 'def-c');
    });
    await waitFor(() => {
      expect(screen.queryByText('审查员')).not.toBeInTheDocument();
    });
  });

  it('addMember 失败（UNIQUE 竞态）→ 行内 error 提示', async () => {
    seedStore([def({ id: 'def-c', name: '审查员', slug: 'reviewer' })], []);
    agentAddMember.mockRejectedValue(new Error('该 agent 定义已加入 workspace，不可重复添加'));

    render(<AddAgentDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '加入' }));

    expect(await screen.findByText(/不可重复添加/)).toBeInTheDocument();
    // 弹窗不关闭
    expect(screen.getByText('添加 Agent 到工作空间')).toBeInTheDocument();
  });
});

describe('AddAgentDialog — 空态与取消', () => {
  it('所有定义均已加入 → 显示空态文案', async () => {
    seedStore([def({ id: 'def-in', name: '已在工作空间的', slug: 'x' })], [
      member('def-in', '已在工作空间的'),
    ]);
    render(<AddAgentDialog onClose={() => {}} />);
    expect(
      await screen.findByText('所有 agent 均已加入本工作空间'),
    ).toBeInTheDocument();
  });

  it('点「取消」→ onClose', async () => {
    seedStore([], []);
    const onClose = vi.fn();
    render(<AddAgentDialog onClose={onClose} />);
    await screen.findByText('所有 agent 均已加入本工作空间');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
