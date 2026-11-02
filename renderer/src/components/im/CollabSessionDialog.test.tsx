// renderer/src/components/im/CollabSessionDialog.test.tsx
//
// v25 Task 13：创建协作会话弹窗测试（spec §6.5）。
// 名称输入（可空=动态命名提示文案）+「选择成员 / 选择团队」页签。
// v2.1 P2 Task 15：👑 → lucide-react Crown；断言改 getByTitle('leader：…') + 内含 svg。
//
// 2026-10-22 Task 11（spec §5.3，预览 B rev2 批准交互）：
//   - agent 页签 radio 单选 → checkbox 多选卡；提交 payload 恒 members 形态
//     （单选亦然）；页签改名「单个 agent」→「选择成员」、「团队」→「选择团队」
//   - 主 agent 指定 = 已选卡底部 radio 行（>1 已选时）+ leader 名旁 Crown 徽标；
//     不变量：首个选中默认 leader、取消 leader 回落剩余首个、切页签清空
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - createCollabSession 桩仿真真实语义（失败写 store error 并返回 false）；
//   - 断言生产消费的字段（CollabTarget / title undefined 语义）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';

const { CollabSessionDialog } = await import('./CollabSessionDialog');
const { useUiStore } = await import('../../stores/ui.store');
const { useSessionStore } = await import('../../stores/session.store');
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

const MEMBER_1: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  // v2.2：后端 JOIN definitions 产出的展示字段（不再依赖 renderer defMap）
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
  iconEmoji: '',
  lastRunning: false,
};

const TEAM: Team = {
  id: 'team-1',
  workspaceId: 'ws-1',
  name: '攻坚组',
  iconEmoji: '🛠️',
  leaderInstanceId: 'inst-1',
  members: [MEMBER_1, MEMBER_2],
  createdAt: '',
};

const loadMembers = vi.fn();
const loadTeams = vi.fn();
const createCollabSession = vi.fn();

beforeEach(() => {
  loadMembers.mockReset().mockResolvedValue(undefined);
  loadTeams.mockReset().mockResolvedValue(undefined);
  createCollabSession.mockReset().mockResolvedValue(true);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2],
    members: [MEMBER_1, MEMBER_2],
    teams: [TEAM],
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
    loadTeams,
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: vi.fn(),
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });

  useSessionStore.setState({ error: null, createCollabSession });
});

describe('CollabSessionDialog — 渲染与数据加载', () => {
  it('挂载时加载当前 ws 成员与团队', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    await waitFor(() => {
      expect(loadMembers).toHaveBeenCalledWith('ws-1');
      expect(loadTeams).toHaveBeenCalledWith('ws-1');
    });
  });

  it('v2.2 回归锁：definitions 未加载（空数组）也显示 agentName——成员行不出现 agentUserId', () => {
    // 事故场景：用户启动后直达会话区开协作弹窗，agent.store 的 definitions 为空。
    // 修复前 memberLabel 落到 agentUserId（@coder:local 形式的 ID）；修复后
    // agentName 由 members 数据面（后端 JOIN）自带，与 definitions 加载时序解耦。
    useAgentStore.setState({ definitions: [] });
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.getByText('编码助手')).toBeInTheDocument();
    expect(screen.getByText('评审员')).toBeInTheDocument();
    expect(screen.queryByText('@coder:local')).not.toBeInTheDocument();
    expect(screen.queryByText('@reviewer:local')).not.toBeInTheDocument();
  });

  it('默认「选择成员」页签（Task 11 改名），成员行显示名称与在线/离线态', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.getByRole('button', { name: '选择成员' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择团队' })).toBeInTheDocument();
    // 旧页签名退役（改名回归锁）
    expect(screen.queryByRole('button', { name: '单个 agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '团队' })).not.toBeInTheDocument();
    expect(screen.getByText('编码助手')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
  });

  it('名称输入框带动态命名提示文案', () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.getByLabelText('会话名称')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('动态命名'),
    );
  });
});

describe('CollabSessionDialog — 校验', () => {
  it('未选目标提交 → 提示选择会话成员', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择会话成员')).toBeInTheDocument();
    expect(createCollabSession).not.toHaveBeenCalled();
  });
});

describe('CollabSessionDialog — 成员多选与主 agent（Task 11，预览 B rev2 批准交互）', () => {
  it('1. 勾选两个成员 → 引导文案 + 已选卡各出 radio 行 + 首个选中者默认 leader（名旁 Crown 徽标）', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    // 成员行为 checkbox 卡（aria-label = 成员名）
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByLabelText('评审员'));

    // 引导文案（已选 >1 时出现于卡片列表上方）
    expect(
      screen.getByText('已选 2 个成员——指定一名主 agent 负责接待与任务分派'),
    ).toBeInTheDocument();

    const radioA = screen.getByTestId('leader-radio-inst-1') as HTMLInputElement;
    const radioB = screen.getByTestId('leader-radio-inst-2') as HTMLInputElement;
    expect(radioA.name).toBe('collab-leader');
    expect(radioB.name).toBe('collab-leader');
    // 不变量：首个选中默认 leader
    expect(radioA.checked).toBe(true);
    expect(radioB.checked).toBe(false);

    // Crown 徽标：leader（inst-1）名旁出现、非 leader 无
    expect(screen.getByTestId('leader-badge-inst-1')).toBeInTheDocument();
    expect(screen.queryByTestId('leader-badge-inst-2')).not.toBeInTheDocument();
  });

  it('2. 点第二个成员 radio → 互斥切换 + Crown 徽标随迁', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByLabelText('评审员'));

    fireEvent.click(screen.getByTestId('leader-radio-inst-2'));

    expect((screen.getByTestId('leader-radio-inst-2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('leader-radio-inst-1') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('leader-badge-inst-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('leader-badge-inst-2')).toBeInTheDocument();
    // 徽标 title 职责说明（rev2：徽标非交互）
    expect(screen.getByTestId('leader-badge-inst-2')).toHaveAttribute(
      'title',
      '主 agent：负责接待用户输入与任务分派',
    );
  });

  it('3. 仅勾 1 个成员 → 无 radio 行、无 Crown 徽标、无引导文案', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('编码助手'));

    expect(screen.queryByTestId('leader-radio-inst-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('leader-badge-inst-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/指定一名主 agent 负责接待与任务分派/)).not.toBeInTheDocument();
  });

  it('4. 取消选中当前 leader → leader 回落到剩余首个（不变量，payload 证明非陈旧）', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByLabelText('评审员'));
    // leader 切到评审员后取消勾选——剩余仅编码助手，回落后 leader 必须是它
    fireEvent.click(screen.getByTestId('leader-radio-inst-2'));
    fireEvent.click(screen.getByLabelText('评审员'));

    // 剩余 1 个 → chrome 规则：无 radio / 无徽标 / 无引导
    expect(screen.queryByTestId('leader-radio-inst-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('leader-badge-inst-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/指定一名主 agent/)).not.toBeInTheDocument();

    // 提交证明回落：leaderInstanceId=inst-1（陈旧 inst-2 会被主进程「主 agent 必须是所选成员之一」拒绝）
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
        type: 'members',
        instanceIds: ['inst-1'],
        leaderInstanceId: 'inst-1',
      }),
    );
  });

  it('5. 提交 → createCollabSession 恒以 members 形态调用（instanceIds + leaderInstanceId）', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByLabelText('评审员'));

    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() =>
      expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
        type: 'members',
        instanceIds: ['inst-1', 'inst-2'],
        leaderInstanceId: 'inst-1',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('切页签清空勾选与 leader（回切后勾选态不残留）', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '选择团队' }));
    fireEvent.click(screen.getByRole('button', { name: '选择成员' }));

    expect((screen.getByLabelText('编码助手') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('leader-badge-inst-1')).not.toBeInTheDocument();
  });
});

describe('CollabSessionDialog — 单成员提交（members 形态收敛）', () => {
  it('名称留空 → title=undefined（动态命名），payload 为 members 形态（单选亦然）', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
      type: 'members',
      instanceIds: ['inst-1'],
      leaderInstanceId: 'inst-1',
    });
  });

  it('填写名称 → title=该名称', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: '评审会' } });
    fireEvent.click(screen.getByLabelText('评审员'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', '评审会', {
      type: 'members',
      instanceIds: ['inst-2'],
      leaderInstanceId: 'inst-2',
    });
  });
});

describe('CollabSessionDialog — 团队页签（行为不变回归锁）', () => {
  it('团队行显示 Crown leader 标记与成员数；选择团队提交 → team 目标', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '选择团队' }));
    // v2.1 P2 Task 15：👑 emoji → lucide-react Crown；断言改 getByTitle + 内含 svg
    const leader = screen.getByTitle('leader：编码助手');
    expect(leader).toBeInTheDocument();
    expect(leader.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('2 成员')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('攻坚组'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
      type: 'team',
      teamId: 'team-1',
    });
  });

  it('团队页签下不显示成员多选列表', () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择团队' }));
    expect(screen.queryByLabelText('编码助手')).not.toBeInTheDocument();
  });

  it('团队页签未选提交 → 提示选择会话目标（空选错误路径）', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择团队' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择会话目标')).toBeInTheDocument();
    expect(createCollabSession).not.toHaveBeenCalled();
  });
});

describe('CollabSessionDialog — 失败路径', () => {
  it('createCollabSession 返回 false → 显示 store 错误，不 onClose', async () => {
    // 仿真真实 action 语义：失败时写 store error 并返回 false
    createCollabSession.mockImplementation(async () => {
      useSessionStore.setState({ error: '目标成员不存在' });
      return false;
    });
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('目标成员不存在')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CollabSessionDialog - 已启用未加入本空间的 agent（2026-10-10 走查反馈）', () => {
  it('def 已启用但未加入本空间：分区显示「+ 加入」入口，点击调 addMember(workspaceId, defId)', () => {
    // 生产 addMember 为 async 且返回新成员行（agent.store）——mock 仿真真实签名
    // （P3 存量清偿：否则组件 .then() 链在 undefined 上产生 unhandled error 令 suite exit=1）
    const addMember = vi.fn(async () => MEMBER_2);
    useAgentStore.setState({
      definitions: [DEF_1, DEF_2],
      members: [MEMBER_1], // DEF_2 已启用但未加入
      addMember,
    });
    render(<CollabSessionDialog onClose={() => {}} />);
    // 未加入分区出现 DEF_2，且不是可选项（checkbox 不出现在该行）
    const joinBtn = screen.getByRole('button', { name: '加入 评审员' });
    expect(screen.getByText('已启用、未加入本工作空间（加入后可选）')).toBeInTheDocument();
    fireEvent.click(joinBtn);
    expect(addMember).toHaveBeenCalledWith('ws-1', 'def-2');
  });

  it('全部 def 均已加入：不渲染未加入分区', () => {
    useAgentStore.setState({
      definitions: [DEF_1, DEF_2],
      members: [MEMBER_1, MEMBER_2],
    });
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.queryByText('已启用、未加入本工作空间（加入后可选）')).not.toBeInTheDocument();
  });
});

describe('CollabSessionDialog - 加入 pending 态（2026-10-10）', () => {
  it('addMember 在途时按钮显示「加入中…」并禁用；完成后恢复并出现候选', async () => {
    let resolveAdd: (m: WorkspaceAgentMember) => void = () => {};
    const addMember = vi.fn(
      () => new Promise<WorkspaceAgentMember>((r) => { resolveAdd = r; }),
    );
    useAgentStore.setState({
      definitions: [DEF_1, DEF_2],
      members: [MEMBER_1],
      addMember,
    });
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '加入 评审员' }));
    expect(await screen.findByText('加入中…')).toBeInTheDocument();
    // 在途期间禁用（防重复点击）
    expect(screen.getByRole('button', { name: '加入 评审员' })).toBeDisabled();
    // IPC 返回 → store append → 候选出现（真实 store append 语义：仿真 onSuccess 链）
    resolveAdd(MEMBER_2);
    await waitFor(() => {
      useAgentStore.setState((s) => ({ members: [...s.members, MEMBER_2] }));
    });
    // Task 11：成员行为 checkbox（多选卡）
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '评审员' })).toBeInTheDocument());
    expect(screen.queryByText('加入中…')).toBeNull();
  });
});

// === D9（验收报告 2026-10-31）：团队创建回填 ===
describe('CollabSessionDialog — D9 团队创建回填', () => {
  beforeEach(() => {
    useUiStore.setState({ pendingCollabDraft: null, activeView: 'im' });
  });

  it('「去创建团队」→ 跳页前保留 title 草稿（不再裸丢）+ 辅助文案在场', async () => {
    // 空态前置：无团队才渲染「去创建团队」
    useAgentStore.setState({ teams: [], loading: false });
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '选择团队' }));
    fireEvent.change(screen.getByLabelText(/会话名称/), { target: { value: 'RPG 开发讨论' } });
    expect(screen.getByText(/已填写的会话名称将保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去创建团队' }));
    expect(useUiStore.getState().pendingCollabDraft).toEqual({ title: 'RPG 开发讨论' });
    expect(useUiStore.getState().activeView).toBe('agents');
    expect(onClose).toHaveBeenCalled();
  });

  it('initialTeamId → 直接落「按团队」tab 且新团队预选（自动重开形态）', async () => {
    render(
      <CollabSessionDialog initialTitle="RPG 开发讨论" initialTeamId="team-1" onClose={() => {}} />,
    );
    // 未点 tab 即预选：团队行已勾选 + 提交直达 team 目标
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(createCollabSession).toHaveBeenCalledWith('ws-1', 'RPG 开发讨论', {
        type: 'team',
        teamId: 'team-1',
      }),
    );
  });
});
