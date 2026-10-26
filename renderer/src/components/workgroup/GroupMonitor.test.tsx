// renderer/src/components/workgroup/GroupMonitor.test.tsx
//
// 编队监控台主区测试（momo-hub M2.1 Task 3）——真 store + window.api.hub.* mock：
// - 组头：组名 + 邀请码 Badge + CopyButton（本机已生成码时）；无码 →「生成邀请码」
//   走 groupInvite；镜像工作空间入口仅 leader 可见，点击挂既有 MirrorWizard（portal 弹层）
// - 节点卡：选中组全部成员渲染（本机节点也在场，leader/本机徽标）；在跑行按
//   targetNodeId 过滤（running+pending 两态）；底部 callout 引导回看板
// - 无组空态：0 组 → 引导去侧栏创建/加入
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GroupMonitor } from './GroupMonitor';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubGroupInfo, HubStatus, HubTaskRecord } from '../../ipc/types';

const onOpenView = vi.fn();

const api = {
  hub: {
    groupList: vi.fn(),
    groupInvite: vi.fn(),
    onGroupChanged: vi.fn(() => () => undefined),
    taskList: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
    onMirrorResult: vi.fn(() => () => undefined),
  },
};

const ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: 'mac-main',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
};

const SELF_ID = 'a3f9c2e1deadbeef';

const GROUP_DEV: HubGroupInfo = {
  groupId: 'g-dev',
  groupName: 'dev-team',
  leaderNodeId: SELF_ID,
  members: [
    { nodeId: SELF_ID, name: 'mac-main', online: true },
    { nodeId: '8f3a00000000c21e', name: 'office-mac', online: true },
    { nodeId: '2b77000000009af0', name: 'lab-node', online: true },
  ],
};

/** leader 是别人的组（本机是普通成员） */
const GROUP_OTHER_LEADER: HubGroupInfo = {
  ...GROUP_DEV,
  groupId: 'g-other',
  groupName: 'other-team',
  leaderNodeId: '8f3a00000000c21e',
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
    expandedTaskId: null,
    streams: {},
    prompts: {},
    agentSlugs: {},
    sessionIds: {},
    reasons: {},
    wizardOpen: false,
  });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, loading: false, error: null });
});

describe('GroupMonitor', () => {
  it('组头：组名 + 已生成邀请码 Badge 与 CopyButton', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV], inviteCodes: { 'g-dev': 'D3VX-824F' } });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.getByRole('heading', { name: 'dev-team' })).toBeInTheDocument();
    expect(screen.getByText('邀请码 D3VX-824F')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制邀请码' })).toBeInTheDocument();
  });

  it('无码时组头呈现「生成邀请码」按钮，点击走 groupInvite', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    api.hub.groupInvite.mockResolvedValue({ inviteCode: 'D3VX-824F' });
    render(<GroupMonitor onOpenView={onOpenView} />);
    fireEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
    await waitFor(() => {
      expect(api.hub.groupInvite).toHaveBeenCalledWith({ groupId: 'g-dev' });
    });
    expect(await screen.findByText('邀请码 D3VX-824F')).toBeInTheDocument();
  });

  it('镜像入口仅 leader：本机 leader 点击挂起既有 MirrorWizard 弹层', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    fireEvent.click(screen.getByRole('button', { name: '镜像工作空间…' }));
    expect(await screen.findByRole('dialog', { name: '镜像工作空间向导' })).toBeInTheDocument();
  });

  it('非 leader（本机是普通成员）：无镜像入口（邀请码入口不设限，与 GroupPanel 迁移语义一致）', () => {
    useHubGroupStore.setState({ groups: [GROUP_OTHER_LEADER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.queryByRole('button', { name: '镜像工作空间…' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成邀请码' })).toBeInTheDocument();
  });

  it('节点卡列表：本机节点也在场；在跑行按 targetNodeId 过滤（running+pending 两态）；空闲卡无行', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    useHubDelegationStore.setState({
      tasks: [
        task({ taskId: 't1', status: 'running', title: '批量重命名 legacy API 端点' }),
        task({ taskId: 't2', status: 'pending', title: '为支付回调写集成测试' }),
        task({ taskId: 't3', targetNodeId: '2b77000000009af0', status: 'done', title: '已完成的任务' }),
      ],
    });
    render(<GroupMonitor onOpenView={onOpenView} />);
    // 本机节点卡 + leader/本机徽标
    const selfCard = screen.getByLabelText('节点 mac-main');
    expect(within(selfCard).getByText('leader')).toBeInTheDocument();
    expect(within(selfCard).getByText('本机')).toBeInTheDocument();
    // office-mac：两行在跑（执行中 + 等待节点确认），无空闲徽标
    const officeCard = screen.getByLabelText('节点 office-mac');
    expect(within(officeCard).getByText('批量重命名 legacy API 端点')).toBeInTheDocument();
    expect(within(officeCard).getByText('为支付回调写集成测试')).toBeInTheDocument();
    expect(within(officeCard).getAllByText('执行中').length).toBeGreaterThan(0);
    expect(within(officeCard).getByText('等待节点确认')).toBeInTheDocument();
    expect(within(officeCard).queryByText('空闲')).not.toBeInTheDocument();
    // lab-node：终态任务不进行 → 空闲徽标在位
    const labCard = screen.getByLabelText('节点 lab-node');
    expect(within(labCard).queryByText('已完成的任务')).not.toBeInTheDocument();
    expect(within(labCard).getByText('空闲')).toBeInTheDocument();
  });

  it('底部 callout 引导回看板（无创建任务入口的话术锚点）', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.getByText(/执行位置选「组内调度」即自动派发/)).toBeInTheDocument();
    expect(screen.getByText(/进入成员工作空间只读视图/)).toBeInTheDocument();
  });

  it('查看入口门控（M2 迁移语义——仅组长×在线×非本机）+ 点击回调 onOpenView(nodeId, nodeName)', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    const { rerender } = render(<GroupMonitor onOpenView={onOpenView} />);
    // 本机节点卡：查看禁用（本机空间无需远程查看）
    expect(within(screen.getByLabelText('节点 mac-main')).getByRole('button', { name: '查看' })).toBeDisabled();
    // 在线成员：可点，回调携带 (nodeId, nodeName)
    fireEvent.click(within(screen.getByLabelText('节点 office-mac')).getByRole('button', { name: '查看' }));
    expect(onOpenView).toHaveBeenCalledWith('8f3a00000000c21e', 'office-mac');
    // 成员离线：禁用
    useHubGroupStore.setState({
      groups: [{ ...GROUP_DEV, members: GROUP_DEV.members.map((m) => ({ ...m, online: false })) }],
    });
    rerender(<GroupMonitor onOpenView={onOpenView} />);
    expect(within(screen.getByLabelText('节点 office-mac')).getByRole('button', { name: '查看' })).toBeDisabled();
  });

  it('非组长（本机普通成员）：全部节点卡查看禁用（hub view.* leader-only 的 UI 前置门控）', () => {
    useHubGroupStore.setState({ groups: [GROUP_OTHER_LEADER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(within(screen.getByLabelText('节点 office-mac')).getByRole('button', { name: '查看' })).toBeDisabled();
    expect(within(screen.getByLabelText('节点 lab-node')).getByRole('button', { name: '查看' })).toBeDisabled();
  });

  it('无组空态：引导去侧栏创建/加入', () => {
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.getByText('尚未加入任何工作组')).toBeInTheDocument();
    expect(screen.getByText(/在左侧创建工作组，或凭邀请码加入/)).toBeInTheDocument();
  });
});
