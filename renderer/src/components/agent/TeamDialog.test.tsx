// renderer/src/components/agent/TeamDialog.test.tsx
//
// v25 Task 13：创建/编辑团队弹窗测试（spec §6.4）。
// 图标+名称*；成员多选（当前 ws members checkbox，≥2 校验）；
// leader 从已勾选中单选（未勾选时禁用）；编辑模式同表单回填。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - 断言生产消费的字段（memberInstanceIds / leaderInstanceId / 调用顺序）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentDefinition, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';

const { TeamDialog } = await import('./TeamDialog');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');

const WS: Workspace = {
  id: 'ws-1',
  name: '测试工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

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
const DEF_3: AgentDefinition = { ...DEF_1, id: 'def-3', name: '测试员', slug: 'tester' };

const MEMBER_1: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

const MEMBER_2: WorkspaceAgentMember = {
  ...MEMBER_1,
  instanceId: 'inst-2',
  agentDefinitionId: 'def-2',
  agentUserId: '@reviewer:local',
  lastRunning: false,
};

const MEMBER_3: WorkspaceAgentMember = {
  ...MEMBER_1,
  instanceId: 'inst-3',
  agentDefinitionId: 'def-3',
  agentUserId: '@tester:local',
};

const EXISTING_TEAM: Team = {
  id: 'team-1',
  workspaceId: 'ws-1',
  name: '攻坚组',
  iconEmoji: '🛠️',
  leaderInstanceId: 'inst-1',
  members: [MEMBER_1, MEMBER_2],
  createdAt: '',
};

const loadMembers = vi.fn();
const createTeam = vi.fn();
const renameTeam = vi.fn();
const setLeader = vi.fn();
const addTeamMember = vi.fn();
const removeTeamMember = vi.fn();

beforeEach(() => {
  loadMembers.mockReset().mockResolvedValue(undefined);
  createTeam.mockReset().mockResolvedValue(EXISTING_TEAM);
  renameTeam.mockReset().mockResolvedValue(undefined);
  setLeader.mockReset().mockResolvedValue(undefined);
  addTeamMember.mockReset().mockResolvedValue(undefined);
  removeTeamMember.mockReset().mockResolvedValue(undefined);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2, DEF_3],
    members: [MEMBER_1, MEMBER_2, MEMBER_3],
    teams: [EXISTING_TEAM],
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
    createTeam,
    renameTeam,
    deleteTeam: vi.fn(),
    setLeader,
    addTeamMember,
    removeTeamMember,
    reset: vi.fn(),
  });
});

// 同一成员名在成员 checkbox 与 leader radio 两处出现，须按 fieldset 收窄查询防歧义
const memberGroup = (): HTMLElement =>
  screen.getByRole('group', { name: '成员（当前工作空间，至少 2 名）' });
const leaderGroup = (): HTMLElement => screen.getByRole('group', { name: '团队 leader' });

function clickMember(name: string): void {
  fireEvent.click(within(memberGroup()).getByLabelText(name));
}

function leaderRadio(name: string): HTMLInputElement {
  return within(leaderGroup()).getByLabelText(`设为 leader：${name}`) as HTMLInputElement;
}

/** 勾选两个成员并选 leader（提交前的完整合法形态） */
function selectTwoMembers(leaderLabel: string): void {
  clickMember('编码助手');
  clickMember('评审员');
  fireEvent.click(leaderRadio(leaderLabel));
}

describe('TeamDialog — 创建模式校验', () => {
  it('挂载时加载当前 ws 成员列表', async () => {
    render(<TeamDialog onClose={() => {}} />);
    await waitFor(() => expect(loadMembers).toHaveBeenCalledWith('ws-1'));
  });

  it('名称为空提交 → 显示错误不调 createTeam', async () => {
    render(<TeamDialog onClose={() => {}} />);
    selectTwoMembers('编码助手');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('团队名称不能为空')).toBeInTheDocument();
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('成员勾选不足 2 人 → 提示至少 2 名成员', async () => {
    render(<TeamDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '攻坚组' } });
    clickMember('编码助手');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('至少选择 2 名团队成员')).toBeInTheDocument();
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('勾选 ≥2 成员但未选 leader → 提示选择 leader', async () => {
    render(<TeamDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '攻坚组' } });
    clickMember('编码助手');
    clickMember('评审员');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择团队 leader')).toBeInTheDocument();
    expect(createTeam).not.toHaveBeenCalled();
  });
});

describe('TeamDialog — leader 联动', () => {
  it('未勾选的成员其 leader 单选禁用；勾选后启用', async () => {
    render(<TeamDialog onClose={() => {}} />);
    expect(leaderRadio('编码助手')).toBeDisabled();
    clickMember('编码助手');
    expect(leaderRadio('编码助手')).toBeEnabled();
  });

  it('取消勾选已选为 leader 的成员 → leader 选择被清空', async () => {
    render(<TeamDialog onClose={() => {}} />);
    clickMember('编码助手');
    clickMember('评审员');
    fireEvent.click(leaderRadio('编码助手'));
    // 取消勾选编码助手 → leader 复位 + 该 radio 回到禁用
    clickMember('编码助手');
    expect((leaderRadio('编码助手') as HTMLInputElement).checked).toBe(false);
    expect(leaderRadio('编码助手')).toBeDisabled();
  });
});

describe('TeamDialog — 创建提交', () => {
  it('合法表单 → createTeam 携带生产消费字段 + onClose', async () => {
    const onClose = vi.fn();
    render(<TeamDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '攻坚组' } });
    selectTwoMembers('评审员');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createTeam).toHaveBeenCalledWith('ws-1', {
      name: '攻坚组',
      iconEmoji: '👥',
      memberInstanceIds: ['inst-1', 'inst-2'],
      leaderInstanceId: 'inst-2',
    });
  });

  it('createTeam 失败 → 显示错误不 onClose', async () => {
    createTeam.mockRejectedValue(new Error('团队成员数至少 2'));
    const onClose = vi.fn();
    render(<TeamDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '攻坚组' } });
    selectTwoMembers('编码助手');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('团队成员数至少 2')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TeamDialog — 编辑模式', () => {
  it('回填现有团队：名称/图标/成员勾选/leader 单选', () => {
    render(<TeamDialog editing={EXISTING_TEAM} onClose={() => {}} />);
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('攻坚组');
    expect((screen.getByLabelText('图标') as HTMLInputElement).value).toBe('🛠️');
    expect((within(memberGroup()).getByLabelText('编码助手') as HTMLInputElement).checked).toBe(true);
    expect((within(memberGroup()).getByLabelText('评审员') as HTMLInputElement).checked).toBe(true);
    expect((within(memberGroup()).getByLabelText('测试员') as HTMLInputElement).checked).toBe(false);
    expect((leaderRadio('编码助手') as HTMLInputElement).checked).toBe(true);
  });

  it('变更提交：改名 → 加成员 → 换 leader → 移除旧 leader，顺序保证约束', async () => {
    const onClose = vi.fn();
    render(<TeamDialog editing={EXISTING_TEAM} onClose={onClose} />);
    // 改名
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '铁三角' } });
    // 加成员 inst-3，移除 inst-1（原 leader），leader 换成 inst-2
    clickMember('测试员');
    clickMember('编码助手');
    fireEvent.click(leaderRadio('评审员'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(renameTeam).toHaveBeenCalledWith('team-1', '铁三角', '🛠️');
    expect(addTeamMember).toHaveBeenCalledWith('team-1', 'inst-3');
    expect(setLeader).toHaveBeenCalledWith('team-1', 'inst-2');
    expect(removeTeamMember).toHaveBeenCalledWith('team-1', 'inst-1');
    // 顺序：加成员 → 换 leader → 移除成员（先转移 leader 才能移除原 leader）
    const addCall = addTeamMember.mock.invocationCallOrder[0]!;
    const leaderCall = setLeader.mock.invocationCallOrder[0]!;
    const removeCall = removeTeamMember.mock.invocationCallOrder[0]!;
    expect(addCall).toBeLessThan(leaderCall);
    expect(leaderCall).toBeLessThan(removeCall);
  });

  it('无变更提交 → 不触发任何写操作，直接 onClose', async () => {
    const onClose = vi.fn();
    render(<TeamDialog editing={EXISTING_TEAM} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(renameTeam).not.toHaveBeenCalled();
    expect(addTeamMember).not.toHaveBeenCalled();
    expect(setLeader).not.toHaveBeenCalled();
    expect(removeTeamMember).not.toHaveBeenCalled();
  });
});

describe('TeamDialog — 编辑 diff 基准 = 提交时 store 现状（部分失败重试）', () => {
  it('首次 setLeader 失败 → store 已含新增成员 → 重试不重复 add，增量正确', async () => {
    setLeader.mockRejectedValueOnce(new Error('换 leader 失败'));
    const onClose = vi.fn();
    render(<TeamDialog editing={EXISTING_TEAM} onClose={onClose} />);
    // 加成员 inst-3 + leader 换成 inst-2
    clickMember('测试员');
    fireEvent.click(leaderRadio('评审员'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 首次：addTeamMember 成功、setLeader 失败 → 错误展示、弹窗不关
    expect(await screen.findByText('换 leader 失败')).toBeInTheDocument();
    expect(addTeamMember).toHaveBeenCalledTimes(1);
    expect(addTeamMember).toHaveBeenCalledWith('team-1', 'inst-3');
    expect(onClose).not.toHaveBeenCalled();

    // 模拟 store 刷新：teams 已含 inst-3（leader 仍 inst-1，setLeader 未成功）
    useAgentStore.setState({
      teams: [{ ...EXISTING_TEAM, members: [MEMBER_1, MEMBER_2, MEMBER_3] }],
    });

    // 重试：基准已是现状 → 不再 addTeamMember（否则命中后端 dup throw 死循环），仅补 setLeader
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(addTeamMember).toHaveBeenCalledTimes(1);
    expect(setLeader).toHaveBeenCalledTimes(2);
    expect(setLeader).toHaveBeenLastCalledWith('team-1', 'inst-2');
    expect(removeTeamMember).not.toHaveBeenCalled();
  });

  it('store 中找不到该团队 → 降级 editing 快照为基准并提示刷新', async () => {
    useAgentStore.setState({ teams: [] });
    const onClose = vi.fn();
    render(<TeamDialog editing={EXISTING_TEAM} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '铁三角' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 提示在提交过程中即显示（成功后弹窗关闭卸载，晚查会落空）
    expect(await screen.findByText(/团队状态已过期/)).toBeInTheDocument();
    // 降级路径仍按 editing 基准提交（后端守卫团队不存在时抛错兜底）
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(renameTeam).toHaveBeenCalledWith('team-1', '铁三角', '🛠️');
  });
});
