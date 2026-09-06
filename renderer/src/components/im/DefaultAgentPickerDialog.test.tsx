// renderer/src/components/im/DefaultAgentPickerDialog.test.tsx
//
// v25 Task 13：默认会话 agent 一次性选择弹窗测试（spec §7「快速会话无默认 agent」）。
// ws 成员单选列表 → setDefaultAgent → onContinue 回调继续（供 T14 快速会话流程消费）。
// 组件就绪 + 测试归本任务；会话入口接线归 T14。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - 断言生产消费的字段（instanceId 原样透传给 setDefaultAgent 与 onContinue）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

const { DefaultAgentPickerDialog } = await import('./DefaultAgentPickerDialog');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');

const DEF_1: AgentDefinition = {
  id: 'def-1',
  name: '编码助手',
  slug: 'coder',
  version: '1.0.0',
  runtime: 'declarative',
  systemPrompt: '',
  defaultTools: [],
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'p1',
  modelName: 'gpt-4o',
};

const DEF_2: AgentDefinition = { ...DEF_1, id: 'def-2', name: '评审员', slug: 'reviewer' };

const MEMBER_1: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  agentName: '编码助手',
  iconEmoji: '🤖',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

const MEMBER_2: WorkspaceAgentMember = {
  ...MEMBER_1,
  instanceId: 'inst-2',
  agentDefinitionId: 'def-2',
  agentUserId: '@reviewer:local',
  agentName: '评审员',
  lastRunning: false,
};

const loadMembers = vi.fn();
const setDefaultAgent = vi.fn();

beforeEach(() => {
  loadMembers.mockReset().mockResolvedValue(undefined);
  setDefaultAgent.mockReset().mockResolvedValue(undefined);

  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    loading: false,
    error: null,
    setDefaultAgent,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2],
    members: [MEMBER_1, MEMBER_2],
    teams: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadMembers,
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
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
});

describe('DefaultAgentPickerDialog — 渲染与数据加载', () => {
  it('挂载时按 workspaceId 加载成员列表', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(loadMembers).toHaveBeenCalledWith('ws-1'));
  });

  it('渲染 ws 成员单选列表', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByLabelText('编码助手')).toBeInTheDocument();
    expect(screen.getByLabelText('评审员')).toBeInTheDocument();
  });

  it('无成员 → 显示引导去 Agent 管理，不渲染选择列表与确认按钮', async () => {
    useAgentStore.setState({ members: [] });
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(await screen.findByText('当前工作空间暂无 agent 成员')).toBeInTheDocument();
    expect(screen.getByText(/请先到 Agent 管理/)).toBeInTheDocument();
    expect(screen.queryByLabelText('编码助手')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设为默认并继续' })).not.toBeInTheDocument();
  });
});

describe('DefaultAgentPickerDialog — 提交路径', () => {
  it('未选择成员时确认按钮禁用', () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '设为默认并继续' })).toBeDisabled();
  });

  it('选择成员 → setDefaultAgent(ws, instanceId) → onContinue(instanceId)', async () => {
    const onContinue = vi.fn();
    render(
      <DefaultAgentPickerDialog
        workspaceId="ws-1"
        onContinue={onContinue}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('评审员'));
    fireEvent.click(screen.getByRole('button', { name: '设为默认并继续' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('inst-2'));
    expect(setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-2');
  });

  it('setDefaultAgent 失败 → 显示错误，不触发 onContinue', async () => {
    setDefaultAgent.mockRejectedValue(new Error('写库失败'));
    const onContinue = vi.fn();
    render(
      <DefaultAgentPickerDialog
        workspaceId="ws-1"
        onContinue={onContinue}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '设为默认并继续' }));
    expect(await screen.findByText('写库失败')).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
