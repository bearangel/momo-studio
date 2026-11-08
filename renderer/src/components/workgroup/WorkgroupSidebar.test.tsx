// renderer/src/components/workgroup/WorkgroupSidebar.test.tsx
//
// 工作组侧栏测试（momo-hub M2.1 Task 3）——hub-group-store / hub-delegation-store
// 真实现 + ipc mock 打 window.api.hub.*（与 WorkgroupView.test 同范式）：
// - 组列表单选切换：默认选中第一组；点击另一组 → aria-current 迁移 + store 落定；
//   选中失效（组被移除）回落第一组
// - 成员负载映射：running+pending 均计入「在跑 N」（violet）；空闲在线 → 「空闲」；
//   本机/组长 → 「本机 · leader」文本注记（负载优先于注记）
// - 组行在线徽标：选中 success / 未选中 neutral，计数 hub presence 融合值
// - 创建工作组表单：入口展开 → 提交走 groupCreate（trim 入参）
// - 凭邀请码加入表单：入口展开 → 提交走 groupJoin（trim 入参）
// - 离线态（configured 但非 online）：「连接建立后可…」注记，无创建/加入入口
// - 无组空态：0 组 → 创建/加入引导直接展开（无折叠入口）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkgroupSidebar } from './WorkgroupSidebar';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubGroupInfo, HubStatus, HubTaskRecord, Workspace } from '../../ipc/types';

const api = {
  hub: {
    groupList: vi.fn(),
    groupCreate: vi.fn(),
    groupJoin: vi.fn(),
    groupInvite: vi.fn(),
    groupBind: vi.fn(),
    groupSetMirrorAccept: vi.fn(),
    onGroupChanged: vi.fn(() => () => undefined),
    taskList: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
  },
  workspace: { list: vi.fn().mockResolvedValue([]) },
};

const ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: 'mac-main',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
  lastErrorCode: null,
  hubProtoVer: null,
};

const OFFLINE: HubStatus = { ...ONLINE, state: 'disconnected' };

const SELF_ID = 'a3f9c2e1deadbeef';

const GROUP_DEV: HubGroupInfo = {
  groupId: 'g-dev',
  groupName: 'dev-team',
  leaderNodeId: SELF_ID,
  members: [
    { nodeId: SELF_ID, name: 'mac-main', online: true },
    { nodeId: '8f3a00000000c21e', name: 'office-mac', online: true },
    { nodeId: '2b77000000009af0', name: 'lab-node', online: true },
    { nodeId: '515100000000eeee', name: 'home-nas', online: false },
  ],
};

const GROUP_LAB: HubGroupInfo = {
  groupId: 'g-lab',
  groupName: 'lab-crew',
  leaderNodeId: '2b77000000009af0',
  members: [{ nodeId: '2b77000000009af0', name: 'lab-node', online: true }],
};

function task(partial: Partial<HubTaskRecord> & { taskId: string }): HubTaskRecord {
  return {
    workspaceName: 'dev-ws',
    targetNodeId: '8f3a00000000c21e',
    status: 'running',
    title: '任务',
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.hub.groupList.mockResolvedValue({ groups: [] });
  api.hub.taskList.mockResolvedValue({ tasks: [] });
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  useHubStore.setState({ status: ONLINE, nodes: [], loadError: null });
  useHubGroupStore.setState({
    groups: [],
    loading: false,
    error: null,
    inviteCodes: {},
    selectedGroupId: null,
  });
  useHubDelegationStore.setState({
    tasks: [],
    loading: false,
    error: null,
    streams: {},
    prompts: {},
    agentSlugs: {},
    sessionIds: {},
    reasons: {},
  });
});

describe('WorkgroupSidebar', () => {
  it('组列表单选切换：默认选中第一组，点击切换 aria-current 与 store 落定', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV, GROUP_LAB] });
    render(<WorkgroupSidebar />);
    expect(screen.getByRole('button', { name: /dev-team/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /lab-crew/ })).not.toHaveAttribute('aria-current');

    fireEvent.click(screen.getByRole('button', { name: /lab-crew/ }));
    expect(screen.getByRole('button', { name: /lab-crew/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /dev-team/ })).not.toHaveAttribute('aria-current');
    expect(useHubGroupStore.getState().selectedGroupId).toBe('g-lab');
    // 切组后成员区跟随选中组成员
    expect(screen.getByText('成员')).toBeInTheDocument();
    expect(within(screen.getByLabelText('成员列表')).getByText('lab-node')).toBeInTheDocument();
  });

  it('选中组被移除后回落第一组（不渲染幽灵选中）', () => {
    useHubGroupStore.setState({ groups: [GROUP_LAB], selectedGroupId: 'g-dev' });
    render(<WorkgroupSidebar />);
    expect(screen.getByRole('button', { name: /lab-crew/ })).toHaveAttribute('aria-current', 'true');
    expect(useHubGroupStore.getState().selectedGroupId).toBe('g-dev'); // store 未变，展示层回落
  });

  it('成员负载映射：running+pending 计入「在跑 N」；空闲在线「空闲」；本机·leader 注记；离线无徽标', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    useHubDelegationStore.setState({
      tasks: [
        task({ taskId: 't1', targetNodeId: '8f3a00000000c21e', status: 'running' }),
        task({ taskId: 't2', targetNodeId: '8f3a00000000c21e', status: 'pending' }),
        task({ taskId: 't3', targetNodeId: '2b77000000009af0', status: 'running' }),
      ],
    });
    render(<WorkgroupSidebar />);
    const members = screen.getByLabelText('成员列表');
    expect(within(members).getByText('在跑 2')).toBeInTheDocument(); // office-mac：running+pending 同计
    expect(within(members).queryAllByText('空闲').length).toBe(0); // 全员有任务/注记 → 无空闲徽标
    expect(within(members).getByText('本机 · leader')).toBeInTheDocument(); // mac-main：本机+组长
    const nas = within(members).getByText('home-nas').closest('[data-member]');
    expect(nas).not.toBeNull();
    expect(within(nas as HTMLElement).queryByText('空闲')).not.toBeInTheDocument(); // 离线成员无空闲徽标
  });

  it('组行在线徽标：选中组 success、未选中 neutral，计数在线成员', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV, GROUP_LAB] });
    render(<WorkgroupSidebar />);
    const devRow = screen.getByRole('button', { name: /dev-team/ });
    expect(within(devRow).getByText('3 在线')).toBeInTheDocument();
    expect(within(devRow).getByText('3 在线').className).toContain('text-status-success');
    const labRow = screen.getByRole('button', { name: /lab-crew/ });
    expect(within(labRow).getByText('1 在线')).toBeInTheDocument();
    expect(within(labRow).getByText('1 在线').className).toContain('text-secondary');
  });

  it('创建工作组：入口展开表单，提交走 groupCreate（trim 入参）', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    api.hub.groupCreate.mockResolvedValue({ groupId: 'g-new' });
    render(<WorkgroupSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '创建工作组' }));
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: ' 新编队 ' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(api.hub.groupCreate).toHaveBeenCalledWith({ groupName: '新编队' });
    });
  });

  it('凭邀请码加入：入口展开表单，提交走 groupJoin（trim 入参）', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    api.hub.groupJoin.mockResolvedValue({ groupId: 'g-x' });
    render(<WorkgroupSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '凭邀请码加入' }));
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: ' D3VX-824F ' } });
    fireEvent.click(screen.getByRole('button', { name: '入组' }));
    await waitFor(() => {
      expect(api.hub.groupJoin).toHaveBeenCalledWith({ inviteCode: 'D3VX-824F' });
    });
  });

  it('离线态（configured 但非 online）：呈现「连接建立后可…」注记，无创建/加入入口', () => {
    useHubStore.setState({ status: OFFLINE, nodes: [], loadError: null });
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<WorkgroupSidebar />);
    expect(screen.getByText('连接建立后可创建或加入工作组')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建工作组' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '凭邀请码加入' })).not.toBeInTheDocument();
  });

  it('无组空态：0 组 → 创建/加入引导直接展开，无折叠入口与成员区', () => {
    render(<WorkgroupSidebar />);
    expect(screen.getByText(/尚未加入任何工作组/)).toBeInTheDocument();
    expect(screen.getByLabelText('组名')).toBeInTheDocument();
    expect(screen.getByLabelText('邀请码')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建工作组' })).not.toBeInTheDocument();
    expect(screen.queryByText('成员')).not.toBeInTheDocument();
  });

  it('查看中态（S4 侧栏）：hub-view store 定向成员行 Eye 图标 + violet「查看中」徽标取代负载徽标', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    useHubDelegationStore.setState({
      tasks: [task({ taskId: 't1', targetNodeId: '8f3a00000000c21e', status: 'running' })],
    });
    useHubViewStore.setState({
      open: true, picking: false, targetNodeId: '8f3a00000000c21e', targetName: 'office-mac',
    });
    render(<WorkgroupSidebar />);
    const officeRow = screen.getByText('office-mac').closest('[data-member]') as HTMLElement;
    expect(within(officeRow).getByText('查看中')).toBeInTheDocument();
    expect(within(officeRow).queryByText('在跑 1')).not.toBeInTheDocument(); // 负载徽标让位
    expect(officeRow.className).toContain('bg-surface-active'); // 行高亮（S4 srow.on）
    // 其他成员不受影响（负载照常）
    const labRow = screen.getByText('lab-node').closest('[data-member]') as HTMLElement;
    expect(within(labRow).queryByText('查看中')).not.toBeInTheDocument();
  });

  it('picking 阶段不算查看中（open 但 picking=true → 成员行常态）', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    useHubViewStore.setState({
      open: true, picking: true, targetNodeId: '8f3a00000000c21e', targetName: 'office-mac',
    });
    render(<WorkgroupSidebar />);
    expect(screen.queryByText('查看中')).not.toBeInTheDocument();
  });

  it('退出查看（open=false）后成员行回到常态', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    useHubViewStore.setState({
      open: false, picking: false, targetNodeId: '8f3a00000000c21e', targetName: 'office-mac',
    });
    render(<WorkgroupSidebar />);
    expect(screen.queryByText('查看中')).not.toBeInTheDocument();
  });
});

// ── 1.10.0 平行模式：建组模式卡 + 版本门 + 两步式入组 ─────────────────────────

function ws(id: string, name: string): Workspace {
  return { id, name, description: '', directoryPath: '/tmp/x', gitInitialized: false, createdAt: '2026-01-01', ownerId: 'owner', iconEmoji: '', defaultAgentInstanceId: null };
}

const WORKSPACES = [ws('ws-dev', '研发空间'), ws('ws-pm', '需求池')];

const GROUP_PEER: HubGroupInfo = {
  groupId: 'g-peer',
  groupName: '产品三人组',
  leaderNodeId: 'other-node',
  mode: 'peer',
  members: [
    { nodeId: 'other-node', name: 'pm-seat', online: true },
    { nodeId: SELF_ID, name: 'mac-main', online: true },
  ],
};

describe('WorkgroupSidebar — 平行模式建组（1.10.0）', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: WORKSPACES, activeWorkspaceId: null, loading: false, error: null });
    api.hub.groupCreate.mockResolvedValue({ groupId: 'g-new' });
  });

  it('PM-1. hub 协议 1.9：平行模式卡禁用 + title 提示；主从可建', () => {
    useHubStore.setState({ status: { ...ONLINE, hubProtoVer: '1.9.0' }, nodes: [], loadError: null });
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<WorkgroupSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '创建工作组' }));
    const peerRadio = screen.getByRole('radio', { name: '平行模式' });
    expect(peerRadio).toBeDisabled();
    expect(
      within(screen.getByRole('radiogroup', { name: '工作组模式' })).getByTitle('hub 服务器协议过旧（需 1.10.0+）'),
    ).toBeInTheDocument();
  });

  it('PM-2. hub 协议 1.10：选平行必选组长绑定空间，未选不可提交', () => {
    useHubStore.setState({ status: { ...ONLINE, hubProtoVer: '1.10.0' }, nodes: [], loadError: null });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '小组' } });
    fireEvent.click(screen.getByRole('radio', { name: '平行模式' }));
    expect(screen.getByLabelText('组长绑定空间*')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
  });

  it('PM-3. 选平行+空间 → 提交带 mode 与 bindWorkspaceName', async () => {
    useHubStore.setState({ status: { ...ONLINE, hubProtoVer: '1.10.0' }, nodes: [], loadError: null });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '小组' } });
    fireEvent.click(screen.getByRole('radio', { name: '平行模式' }));
    fireEvent.change(screen.getByLabelText('组长绑定空间*'), { target: { value: 'ws-dev' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(api.hub.groupCreate).toHaveBeenCalledWith({ groupName: '小组', mode: 'peer', bindWorkspaceName: '研发空间' });
    });
  });

  it('PM-4. hubProtoVer 未知（null）：平行卡同样禁用（保守门）', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<WorkgroupSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '创建工作组' }));
    expect(screen.getByRole('radio', { name: '平行模式' })).toBeDisabled();
  });
});

describe('WorkgroupSidebar — 两步式入组（1.10.0）', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: WORKSPACES, activeWorkspaceId: null, loading: false, error: null });
    api.hub.groupBind.mockResolvedValue({ ok: true });
    api.hub.groupSetMirrorAccept.mockResolvedValue({ ok: true });
  });

  it('PJ-1. join 返回 peer 组 → 追加绑定承接空间弹窗；提交走 groupBind + groupSetMirrorAccept', async () => {
    api.hub.groupJoin.mockResolvedValue({ groupId: 'g-peer' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_PEER] });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'PEER-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: '入组' }));
    expect(await screen.findByRole('dialog', { name: /绑定承接空间/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('承接空间*'), { target: { value: 'ws-dev' } });
    fireEvent.click(screen.getByLabelText('接受本组镜像同步'));
    expect(screen.getByText('接受后组长的同步配置将覆盖此空间内容')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '绑定' }));
    await waitFor(() => {
      expect(api.hub.groupBind).toHaveBeenCalledWith({ groupId: 'g-peer', workspaceId: 'ws-dev' });
      expect(api.hub.groupSetMirrorAccept).toHaveBeenCalledWith({ groupId: 'g-peer', accepts: true });
    });
  });

  it('PJ-2. 不接受镜像 → 只 groupBind，不动开关', async () => {
    api.hub.groupJoin.mockResolvedValue({ groupId: 'g-peer' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_PEER] });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'PEER-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: '入组' }));
    await screen.findByRole('dialog', { name: /绑定承接空间/ });
    fireEvent.change(screen.getByLabelText('承接空间*'), { target: { value: 'ws-pm' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定' }));
    await waitFor(() => {
      expect(api.hub.groupBind).toHaveBeenCalledWith({ groupId: 'g-peer', workspaceId: 'ws-pm' });
    });
    expect(api.hub.groupSetMirrorAccept).not.toHaveBeenCalled();
  });

  it('PJ-3. 「稍后再绑」跳过 → 关闭弹窗，不调 groupBind（未绑定成员）', async () => {
    api.hub.groupJoin.mockResolvedValue({ groupId: 'g-peer' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_PEER] });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'PEER-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: '入组' }));
    await screen.findByRole('button', { name: '稍后再绑' });
    fireEvent.click(screen.getByRole('button', { name: '稍后再绑' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /绑定承接空间/ })).not.toBeInTheDocument();
    });
    expect(api.hub.groupBind).not.toHaveBeenCalled();
  });

  it('PJ-4. join 返回 lf 组 → 不弹绑定弹窗（两步式仅平行组）', async () => {
    api.hub.groupJoin.mockResolvedValue({ groupId: 'g-dev' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    render(<WorkgroupSidebar />);
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'LF-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: '入组' }));
    await waitFor(() => {
      expect(api.hub.groupJoin).toHaveBeenCalledWith({ inviteCode: 'LF-CODE' });
    });
    expect(screen.queryByRole('dialog', { name: /绑定承接空间/ })).not.toBeInTheDocument();
  });
});
