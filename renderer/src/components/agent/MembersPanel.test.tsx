// renderer/src/components/agent/MembersPanel.test.tsx
//
// v25 Task 12：AgentsView Tab 1「Agent 成员」面板测试（spec §6.1）。
// 成员行 = icon emoji + 名称 + 模型 + ⭐默认会话标记 + 在线状态 + 行内操作
// （启动/停止、设为默认会话、编辑、移出工作空间）。
// 移出被 leader 守卫拦截时 alert blockedTeams 团队名（spec §7）。
//
// Mock 策略（momo-test-rules）：
//   - 子弹窗（MemberEditDialog）桩化，隔离 panel ↔ dialog 耦合，
//     聚焦按钮渲染与回调传递；
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩（不 mock store 模块）；
//   - 成员操作全部走 store action（startMember/stopMember/removeMember/setDefaultAgent），
//     断言生产消费的字段（instanceId / workspaceId）。
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentDefinition, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';
import { useProviderStore } from '../../stores/provider.store';

// ---- 子弹窗桩：占位渲染 + 暴露 onClose 触发点 ----
const editDialogMock = vi.fn();
vi.mock('./MemberEditDialog', () => ({
  MemberEditDialog: (props: {
    member: WorkspaceAgentMember;
    def: AgentDefinition;
    onClose: () => void;
  }) => {
    editDialogMock(props);
    return (
      <div data-testid="member-edit-dialog">
        <span>编辑成员：{props.def.name}</span>
        <button type="button" onClick={props.onClose}>close-edit-dialog</button>
      </div>
    );
  },
}));

// 延迟导入，确保 mock 已注册
const { MembersPanel } = await import('./MembersPanel');
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
  defaultAgentInstanceId: 'inst-1',
};

const DEF_1: AgentDefinition = {
  id: 'def-1',
  name: '编码助手',
  slug: 'coder',
  version: '1.0.0',
  runtime: 'declarative',
  systemPrompt: '',
  defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'p1',
  modelName: 'gpt-4o',
};

const DEF_2: AgentDefinition = {
  ...DEF_1,
  id: 'def-2',
  name: '评审员',
  slug: 'reviewer',
  iconEmoji: '🔍',
  modelProviderId: 'p2',
  modelName: 'claude-sonnet',
};

/** 默认会话 agent（inst-1，运行中） */
const MEMBER_DEFAULT: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

/** 普通成员（inst-2，已停止） */
const MEMBER_NORMAL: WorkspaceAgentMember = {
  ...MEMBER_DEFAULT,
  instanceId: 'inst-2',
  agentDefinitionId: 'def-2',
  agentUserId: '@reviewer:local',
  lastRunning: false,
};

// store action 桩
const loadMembersMock = vi.fn();
const startMemberMock = vi.fn();
const stopMemberMock = vi.fn();
const removeMemberMock = vi.fn();
const setDefaultAgentMock = vi.fn();

let confirmSpy: MockInstance<Parameters<typeof window.confirm>, ReturnType<typeof window.confirm>>;
let alertSpy: MockInstance<Parameters<typeof window.alert>, ReturnType<typeof window.alert>>;

beforeEach(() => {
  editDialogMock.mockReset();
  loadMembersMock.mockReset().mockResolvedValue(undefined);
  startMemberMock.mockReset().mockResolvedValue(undefined);
  stopMemberMock.mockReset().mockResolvedValue(undefined);
  removeMemberMock.mockReset().mockResolvedValue({ ok: true });
  setDefaultAgentMock.mockReset().mockResolvedValue(undefined);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
    setDefaultAgent: setDefaultAgentMock,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2],
    members: [MEMBER_DEFAULT, MEMBER_NORMAL],
    teams: [] as Team[],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadMembers: loadMembersMock,
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
    removeMember: removeMemberMock,
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: stopMemberMock,
    startMember: startMemberMock,
    reset: vi.fn(),
  });

  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  confirmSpy.mockRestore();
  alertSpy.mockRestore();
});

async function renderLoaded(): Promise<void> {
  render(<MembersPanel />);
  await waitFor(() => {
    expect(loadMembersMock).toHaveBeenCalledWith('ws-1');
  });
}

/** 定位某成员所在的行容器（名称 span 的父级），用于行内按钮作用域查询 */
function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).parentElement;
  if (!row) throw new Error(`未找到成员行：${name}`);
  return row;
}

describe('MembersPanel — 成员行渲染', () => {
  it('挂载时按当前 workspace 加载成员列表', async () => {
    await renderLoaded();
    expect(loadMembersMock).toHaveBeenCalledWith('ws-1');
  });

  it('成员行渲染 icon emoji、名称、模型与在线状态', async () => {
    await renderLoaded();
    // icon emoji + 名称
    expect(screen.getByText('编码助手')).toBeInTheDocument();
    expect(screen.getByText('评审员')).toBeInTheDocument();
    // 模型（次级文本）
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument();
    // 在线状态：inst-1 运行中（Play）/ inst-2 已停止（Pause）——v2.1 P3 图标 lucide 化
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('已停止')).toBeInTheDocument();
  });

  it('仅默认会话 agent 显示 Star 标记；非默认成员提供「设为默认」按钮', async () => {
    await renderLoaded();
    // Star 标记唯一（inst-1 是 defaultAgentInstanceId，title 语义不变）
    expect(screen.getAllByTitle('默认会话 agent')).toHaveLength(1);
    // 非默认成员才有「设为默认」
    expect(screen.getByText('设为默认')).toBeInTheDocument();
  });

  it('空态：无成员时显示空态提示与「+ 创建 Agent」入口', async () => {
    useAgentStore.setState({ members: [] });
    render(<MembersPanel />);
    await waitFor(() => {
      expect(loadMembersMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByText('本工作空间暂无 agent 成员')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ 创建 Agent' })).toBeInTheDocument();
  });
});

describe('MembersPanel — 创建 Agent 入口接线（Task 13）', () => {
  it('点「+ 创建 Agent」→ 渲染 CreateAgentDialog（agentView：含设默认勾选）', async () => {
    // 弹窗挂载即拉取 provider 列表——桩化 store action，不触达 ipc
    useProviderStore.setState({
      providers: [],
      loading: false,
      loadProviders: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      setDefault: vi.fn(),
      clear: vi.fn(),
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ 创建 Agent' }));
    expect(await screen.findByText('创建 Agent')).toBeInTheDocument();
    // source='agentView' 的可观察差异：设为默认勾选可见（library 入口无此勾选）
    expect(screen.getByLabelText('设为默认会话 agent')).toBeInTheDocument();
  });
});

describe('MembersPanel — 行内操作触发 store action', () => {
  it('运行中成员点「停止」→ stopMember(instanceId)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('停止'));
    expect(stopMemberMock).toHaveBeenCalledWith('inst-1');
  });

  it('已停止成员点「启动」→ startMember(member, workspaceId)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('启动'));
    expect(startMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-2' }),
      'ws-1',
    );
  });

  it('非默认成员点「设为默认」→ workspace.store.setDefaultAgent(wsId, instanceId)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('设为默认'));
    expect(setDefaultAgentMock).toHaveBeenCalledWith('ws-1', 'inst-2');
  });

  it('点「编辑」→ 渲染 MemberEditDialog（member + def 数据源为该行成员）', async () => {
    await renderLoaded();
    fireEvent.click(within(rowOf('编码助手')).getByText('编辑'));
    await waitFor(() => {
      expect(screen.getByTestId('member-edit-dialog')).toBeInTheDocument();
    });
    const props = editDialogMock.mock.calls[0]![0];
    expect(props.member.instanceId).toBe('inst-1');
    expect(props.member.agentDefinitionId).toBe('def-1');
    expect(props.def.id).toBe('def-1');
  });

  it('旧「更新密钥」「⚙ 调整能力」按钮已随弹窗合并移除', async () => {
    await renderLoaded();
    expect(screen.queryByText('更新密钥')).not.toBeInTheDocument();
    expect(screen.queryByText('⚙ 调整能力')).not.toBeInTheDocument();
  });

  it('关闭编辑弹窗 → loadMembers 刷新（setMemberDeltas 不内部刷新）', async () => {
    await renderLoaded();
    fireEvent.click(within(rowOf('编码助手')).getByText('编辑'));
    await waitFor(() => {
      expect(screen.getByTestId('member-edit-dialog')).toBeInTheDocument();
    });
    loadMembersMock.mockClear();
    fireEvent.click(screen.getByText('close-edit-dialog'));
    await waitFor(() => {
      expect(loadMembersMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByTestId('member-edit-dialog')).not.toBeInTheDocument();
  });
});

describe('MembersPanel — 移出工作空间（leader 守卫路径）', () => {
  it('确认后调用 removeMember(instanceId)', async () => {
    await renderLoaded();
    fireEvent.click(within(rowOf('评审员')).getByText('移出'));
    await waitFor(() => {
      expect(removeMemberMock).toHaveBeenCalledWith('inst-2');
    });
    expect(confirmSpy).toHaveBeenCalled();
  });

  it('confirm 取消 → 不调用 removeMember', async () => {
    confirmSpy.mockReturnValue(false);
    await renderLoaded();
    fireEvent.click(within(rowOf('评审员')).getByText('移出'));
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it('被 leader 守卫拦截（ok:false）→ alert blockedTeams 团队名', async () => {
    removeMemberMock.mockResolvedValue({ ok: false, blockedTeams: ['攻坚组', '值班组'] });
    await renderLoaded();
    fireEvent.click(within(rowOf('评审员')).getByText('移出'));
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    const message = alertSpy.mock.calls[0]![0] as string;
    expect(message).toContain('攻坚组');
    expect(message).toContain('值班组');
    expect(message).toContain('评审员');
  });
});
