// renderer/src/components/im/DefaultAgentPickerDialog.test.tsx
//
// v25 Task 13：默认会话 agent 一次性选择弹窗测试（spec §7「快速会话无默认 agent」）。
// ws 成员单选列表 → setDefaultAgent → onContinue 回调继续（供 T14 快速会话流程消费）。
//
// 2026-10-22 Task 13 重写：radio 行 → AgentPickerCard（整卡点选，aria-checked 表达
// 选中）+ 描述直出（def.description 两行合同）+ 能力徽标（getEffectiveCapabilities
// 批量拉取；record 缺 key 是合法态——降级 def 级徽标，绝不可显示零能力，Task 12 契约）。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - IPC 边界 window.api.agent.getEffectiveCapabilities 桩（inst-2 故意缺 key——降级契约）；
//   - 断言生产消费的字段（instanceId 原样透传给 setDefaultAgent 与 onContinue）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, EffectiveCapabilities, WorkspaceAgentMember } from '../../ipc/types';

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
  defaultTools: [
    { kind: 'builtin', ref: 'builtin:read' },
    { kind: 'builtin', ref: 'builtin:write' },
    { kind: 'builtin', ref: 'builtin:bash' },
  ],
  source: 'custom',
  description: '负责编码实现的智能体',
  iconEmoji: '🤖',
  defaultMcps: [{ kind: 'mcp', ref: 'mcp:github' }],
  defaultSkills: [{ kind: 'skill', ref: 'skill:review' }],
  workspaceId: null,
  modelProviderId: 'p1',
  modelName: 'gpt-4o',
};

const DEF_2: AgentDefinition = {
  ...DEF_1,
  id: 'def-2',
  name: '评审员',
  slug: 'reviewer',
  description: '',
  defaultTools: [{ kind: 'builtin', ref: 'builtin:read' }],
  defaultMcps: [],
  defaultSkills: [],
};

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

/** inst-1 生效桶固定；inst-2 故意缺 key——def 级降级契约（Task 12 交接 CRITICAL） */
const EFFECTIVE_BUCKETS: Record<string, EffectiveCapabilities> = {
  'inst-1': { tools: ['builtin:a', 'builtin:b'], mcps: [], skills: ['skill:x'], deniedTools: [] },
};

const loadMembers = vi.fn();
const loadDefinitions = vi.fn();
const setDefaultAgent = vi.fn();
const getEffectiveCapabilities = vi.fn();

beforeEach(() => {
  loadMembers.mockReset().mockResolvedValue(undefined);
  loadDefinitions.mockReset().mockResolvedValue(undefined);
  setDefaultAgent.mockReset().mockResolvedValue(undefined);
  getEffectiveCapabilities.mockReset().mockResolvedValue(EFFECTIVE_BUCKETS);

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    agent: { getEffectiveCapabilities },
  };

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
    loadDefinitions,
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
  it('挂载时按 workspaceId 加载成员与定义（描述/降级徽标依赖 definitions）', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(loadMembers).toHaveBeenCalledWith('ws-1');
      expect(loadDefinitions).toHaveBeenCalledWith('ws-1');
    });
  });

  it('无成员 → 显示引导去智能体页，不渲染选择列表与确认按钮', async () => {
    useAgentStore.setState({ members: [] });
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(await screen.findByText('当前工作空间暂无智能体成员')).toBeInTheDocument();
    expect(screen.getByText(/请先到「智能体」页添加智能体成员/)).toBeInTheDocument();
    expect(screen.queryByLabelText('编码助手')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设为默认并继续' })).not.toBeInTheDocument();
  });
});

describe('DefaultAgentPickerDialog — 描述与能力徽标（2026-10-22 Task 13）', () => {
  it('成员行显示描述：def.description 直出；空描述「暂无说明」占位', () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText('负责编码实现的智能体')).toBeInTheDocument();
    expect(screen.getByText('暂无说明')).toBeInTheDocument();
  });

  it('徽标来自 getEffectiveCapabilities 批量结果：inst-1 Wrench 2 / Sparkles 1，0 计数 MCP 不渲染', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(getEffectiveCapabilities).toHaveBeenCalledWith(['inst-1', 'inst-2']),
    );
    expect(await screen.findByTitle('内置工具')).toHaveTextContent(/^2$/);
    expect(screen.getByTitle('技能')).toHaveTextContent(/^1$/);
    expect(screen.queryByTitle('MCP 服务器')).not.toBeInTheDocument();
  });

  it('record 缺 key（inst-2）→ def 级降级徽标（默认能力 title + def 计数），绝显示不出零能力', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    // DEF_2.defaultTools 长度 1——降级不是空桶
    expect(await screen.findByTitle('默认能力：内置工具')).toHaveTextContent(/^1$/);
  });

  it('getEffectiveCapabilities 失败 → 静默降级 def 级徽标（弹窗不可用性不放大）', async () => {
    getEffectiveCapabilities.mockRejectedValue(new Error('IPC 不可用'));
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    // 两个成员都落到 def 级降级（DOM 序：inst-1 def 3 工具 / inst-2 def 1 工具）
    const badges = await screen.findAllByTitle('默认能力：内置工具');
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => b.textContent)).toEqual(['3', '1']);
  });
});

describe('DefaultAgentPickerDialog — 单选行为（卡片化回归锁）', () => {
  it('仅一名成员 → 自动预选（aria-checked=true），「设为默认并继续」直接可用', async () => {
    useAgentStore.setState({ members: [MEMBER_1] });
    const onContinue = vi.fn();
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={onContinue} onClose={() => {}} />,
    );

    const card = screen.getByLabelText('编码助手');
    await waitFor(() => expect(card).toHaveAttribute('aria-checked', 'true'));
    const submit = screen.getByRole('button', { name: '设为默认并继续' });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('inst-1'));
    expect(setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-1');
  });

  it('多名成员 → 不预选、按钮禁用（避免替用户做选择）', async () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );

    await waitFor(() => expect(screen.getByLabelText('编码助手')).toBeInTheDocument());
    expect(screen.getByLabelText('编码助手')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('评审员')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: '设为默认并继续' })).toBeDisabled();
  });

  it('点卡片选中且互斥（单选语义）→ 提交 setDefaultAgent(ws, instanceId) → onContinue', async () => {
    const onContinue = vi.fn();
    render(
      <DefaultAgentPickerDialog
        workspaceId="ws-1"
        onContinue={onContinue}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('评审员'));
    expect(screen.getByLabelText('评审员')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('编码助手')).toHaveAttribute('aria-checked', 'false');

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

  it('未选择成员时确认按钮禁用', () => {
    render(
      <DefaultAgentPickerDialog workspaceId="ws-1" onContinue={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '设为默认并继续' })).toBeDisabled();
  });
});
