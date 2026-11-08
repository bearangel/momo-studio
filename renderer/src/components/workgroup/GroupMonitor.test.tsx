// renderer/src/components/workgroup/GroupMonitor.test.tsx
//
// 编队监控台主区测试（momo-hub M2.1 Task 3）——真 store + window.api.hub.* mock：
// - 组头：组名 + 邀请码 Badge + CopyButton（本机已生成码时）；无码不设独立按钮——
//   组菜单「重新生成邀请码」是唯一入口（成员级语义，M2.1 T5 收口）；镜像工作空间入口仅 leader 可见，
//   点击挂既有 MirrorWizard（portal 弹层）
// - 节点卡：选中组全部成员渲染（本机节点也在场，leader/本机徽标）；在跑行按
//   targetNodeId 过滤（running+pending 两态）；底部 callout 引导回看板
// - 无组空态：0 组 → 引导去侧栏创建/加入
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GroupMonitor } from './GroupMonitor';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useUnifiedMirrorStore } from '../../stores/unified-mirror.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubGroupInfo, HubStatus, HubTaskRecord, Workspace } from '../../ipc/types';

const onOpenView = vi.fn();

const api = {
  hub: {
    groupList: vi.fn(),
    groupInvite: vi.fn(),
    groupTransfer: vi.fn(),
    groupLeave: vi.fn(),
    groupBind: vi.fn(),
    groupSetMirrorAccept: vi.fn(),
    snapshotBuildUpload: vi.fn(),
    mirrorWorkspace: vi.fn(),
    onGroupChanged: vi.fn(() => () => undefined),
    taskList: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
    onMirrorResult: vi.fn(() => () => undefined),
  },
  // ipc 代理命名空间缓存按首次访问拷贝——全部键必须先于首个用例存在
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
    streams: {},
    prompts: {},
    agentSlugs: {},
    sessionIds: {},
    reasons: {},
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

  it('无码时组头不设独立按钮——组菜单「重新生成邀请码」是唯一入口，点击走 groupInvite', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    api.hub.groupInvite.mockResolvedValue({ inviteCode: 'D3VX-824F' });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.queryByRole('button', { name: '生成邀请码' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' }));
    fireEvent.click(screen.getByRole('button', { name: '重新生成邀请码' }));
    await waitFor(() => {
      expect(api.hub.groupInvite).toHaveBeenCalledWith({ groupId: 'g-dev' });
    });
    expect(await screen.findByText('邀请码 D3VX-824F')).toBeInTheDocument();
  });

  it('镜像入口仅 leader：本机 leader 点击挂起既有 MirrorWizard 弹层', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    fireEvent.click(screen.getByRole('button', { name: '同步配置' }));
    expect(await screen.findByRole('dialog', { name: '镜像工作空间向导' })).toBeInTheDocument();
  });

  it('非 leader（本机是普通成员）：无镜像入口（邀请码为成员级能力，菜单入口不设限）', () => {
    useHubGroupStore.setState({ groups: [GROUP_OTHER_LEADER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.queryByRole('button', { name: '同步配置' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 other-team' }));
    expect(screen.getByRole('button', { name: '重新生成邀请码' })).toBeInTheDocument();
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

describe('GroupMonitor 组操作菜单（M2.1 Task 5 自 settings/GroupPanel 收口——RM-M21-8）', () => {
  it('leader：菜单含 重新生成邀请码/转移组长/退出工作组；重新生成走 groupInvite 且组头徽标更新', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV], inviteCodes: { 'g-dev': 'D3VX-824F' } });
    api.hub.groupInvite.mockResolvedValue({ inviteCode: 'N3W9-77QA' });
    render(<GroupMonitor onOpenView={onOpenView} />);

    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' }));
    fireEvent.click(screen.getByRole('button', { name: '重新生成邀请码' }));
    await waitFor(() =>
      expect(api.hub.groupInvite).toHaveBeenCalledWith({ groupId: 'g-dev' }),
    );
    // store.inviteCodes 覆盖 → 组头 Badge 更新为新码
    expect(await screen.findByText('邀请码 N3W9-77QA')).toBeInTheDocument();
  });

  it('转移组长：展开可选成员子列表（排除本机），点击成员调 groupTransfer', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);

    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' }));
    fireEvent.click(screen.getByRole('button', { name: '转移组长' }));
    // 本机自身不在可转移列表（现任组长即本机）
    expect(screen.queryByRole('button', { name: '转移给 mac-main' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '转移给 office-mac' }));
    await waitFor(() =>
      expect(api.hub.groupTransfer).toHaveBeenCalledWith({
        groupId: 'g-dev',
        toNodeId: '8f3a00000000c21e',
      }),
    );
  });

  it('退组两步确认（GroupPanel「再次点击确认」范式迁移）：首击臂确认不调 leave；再击才调', async () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);

    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' }));
    fireEvent.click(screen.getByRole('button', { name: '退出工作组' }));
    expect(api.hub.groupLeave).not.toHaveBeenCalled();
    // P2-10：臂态明示「再次点击确认」+ 剩余秒倒计时
    expect(screen.getByRole('button', { name: /再次点击确认退出 · \ds/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /再次点击确认退出/ }));
    await waitFor(() =>
      expect(api.hub.groupLeave).toHaveBeenCalledWith({ groupId: 'g-dev' }),
    );
  });

  it('P2-10 退组臂态：3s 到期回落回普通项；菜单关闭即复位（不残留臂态）', async () => {
    vi.useFakeTimers();
    try {
      useHubGroupStore.setState({ groups: [GROUP_DEV] });
      render(<GroupMonitor onOpenView={onOpenView} />);

      fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' }));
      fireEvent.click(screen.getByRole('button', { name: '退出工作组' }));
      expect(screen.getByRole('button', { name: /再次点击确认退出 · 3s/ })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      // 回落：菜单项回普通「退出工作组」，且全程未调 leave
      expect(screen.getByRole('button', { name: '退出工作组' })).toBeInTheDocument();
      expect(api.hub.groupLeave).not.toHaveBeenCalled();

      // 菜单关闭复位：再 arm → 关菜单 → 重开 → 非臂态
      fireEvent.click(screen.getByRole('button', { name: '退出工作组' }));
      fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' })); // open 时再点 = close
      fireEvent.click(screen.getByRole('button', { name: '组操作菜单 dev-team' })); // 重开
      expect(screen.getByRole('button', { name: '退出工作组' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /再次点击确认退出/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('非 leader：重新生成邀请码可见且可触发（成员级语义）+ 退出工作组；转移组长仍 leader-only', async () => {
    useHubGroupStore.setState({ groups: [GROUP_OTHER_LEADER] });
    api.hub.groupInvite.mockResolvedValue({ inviteCode: 'OTH5-11BC' });
    render(<GroupMonitor onOpenView={onOpenView} />);

    fireEvent.click(screen.getByRole('button', { name: '组操作菜单 other-team' }));
    expect(screen.queryByRole('button', { name: '转移组长' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出工作组' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新生成邀请码' }));
    await waitFor(() =>
      expect(api.hub.groupInvite).toHaveBeenCalledWith({ groupId: 'g-other' }),
    );
    expect(await screen.findByText('邀请码 OTH5-11BC')).toBeInTheDocument();
  });
});

// ── 1.10.0 平行组监控台：查看退场 / 绑定态行 / 统一镜像 / 换绑与开关 ───────────

function ws(id: string, name: string): Workspace {
  return { id, name, description: '', directoryPath: '/tmp/x', gitInitialized: false, createdAt: '2026-01-01', ownerId: 'owner', iconEmoji: '', defaultAgentInstanceId: null };
}

/** peer 组夹具：本机=组长已绑定；office-mac 可收镜像；lab-node 未开镜像；home-nas 离线 */
const GROUP_PEER: HubGroupInfo = {
  groupId: 'g-peer',
  groupName: '产品三人组',
  leaderNodeId: SELF_ID,
  mode: 'peer',
  members: [
    { nodeId: SELF_ID, name: 'mac-main', online: true, bound: true, boundWorkspaceName: '研发空间', acceptsMirror: false },
    { nodeId: '8f3a00000000c21e', name: 'office-mac', online: true, bound: true, boundWorkspaceName: '测试空间', acceptsMirror: true },
    { nodeId: '2b77000000009af0', name: 'lab-node', online: true, bound: true, boundWorkspaceName: '需求池', acceptsMirror: false },
    { nodeId: '515100000000eeee', name: 'home-nas', online: false, bound: true, boundWorkspaceName: '备份区', acceptsMirror: true },
  ],
};

describe('GroupMonitor — 平行组（1.10.0）', () => {
  beforeEach(() => {
    // 配置顶层 api 既有 fn（重赋值会脱离 ipc 代理的命名空间缓存包裹）
    api.hub.snapshotBuildUpload.mockReset().mockResolvedValue({
      snapshotId: 'snap-1', checksum: '9c4f21e0'.padEnd(64, '0'), version: '3',
      sizeBytes: 2400 * 1024, excludedPlugins: [],
      summary: { members: 2, embeddedMembers: 0, teams: 1, mcp: 1, skills: 2, skillResources: 2, skillEmbedded: 0, plugins: 1, providers: 1, modelBinding: false, resources: 4 },
    });
    api.hub.mirrorWorkspace.mockReset().mockResolvedValue({ accepted: true, mirrorId: 'm-1' });
    api.hub.groupBind.mockReset().mockResolvedValue({ ok: true });
    api.hub.groupSetMirrorAccept.mockReset().mockResolvedValue({ ok: true });
    api.workspace.list.mockReset().mockResolvedValue([]);
    useWorkspaceStore.setState({ workspaces: [ws('ws-dev', '研发空间')], activeWorkspaceId: null, loading: false, error: null });
    useUnifiedMirrorStore.setState({
      open: false, groupId: null, groupName: null, sourceWorkspaceId: null, sourceWorkspaceName: null,
      buildStatus: 'idle', buildError: null, snapshot: null, rows: [], launched: false, launching: false,
    });
  });

  it('PR-1. peer 组：查看按钮全组退场；节点卡 mono 行带绑定态；平行模式徽标在场', () => {
    useHubGroupStore.setState({ groups: [GROUP_PEER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.getByText('平行模式')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看' })).not.toBeInTheDocument();
    expect(screen.getByText(/已绑定 · 研发空间/)).toBeInTheDocument();
    expect(screen.getByText(/已绑定 · 测试空间/)).toBeInTheDocument();
  });

  it('PR-2. lf 组零变化：查看按钮在场，无绑定态行与统一镜像', () => {
    useHubGroupStore.setState({ groups: [GROUP_DEV] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.getAllByRole('button', { name: '查看' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '同步配置' })).toBeInTheDocument(); // lf 组长同名入口（开 lf 向导）
    expect(screen.queryByText(/已绑定 ·/)).not.toBeInTheDocument();
  });

  it('PR-3. 组长未绑定 → 统一镜像禁用 + title 提示先绑定', () => {
    const unbound: HubGroupInfo = {
      ...GROUP_PEER,
      members: GROUP_PEER.members.map((m) => (m.nodeId === SELF_ID ? { ...m, bound: false, boundWorkspaceName: undefined } : m)),
    };
    useHubGroupStore.setState({ groups: [unbound] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    const btn = screen.getByRole('button', { name: /同步配置/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', '请先绑定自己的承接空间');
  });

  it('PR-4. 统一镜像：打开对话框即构建快照；不达标成员逐行可见；发起仅对就绪成员逐一派发', async () => {
    useHubGroupStore.setState({ groups: [GROUP_PEER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    fireEvent.click(screen.getByRole('button', { name: /同步配置/ }));
    const dlg = await screen.findByRole('dialog', { name: '同步配置' });
    await waitFor(() => {
      expect(api.hub.snapshotBuildUpload).toHaveBeenCalledWith({ workspaceId: 'ws-dev' });
    });
    // 隐形过滤根治：lab-node（未接受）与 home-nas（离线）原因在对话框里可见
    expect(await within(dlg).findByText(/未接受镜像/)).toBeInTheDocument();
    expect(within(dlg).getAllByText(/离线/).length).toBeGreaterThan(0);
    fireEvent.click(within(dlg).getByRole('button', { name: /向 1 个成员发起镜像/ }));
    await waitFor(() => {
      // office-mac 唯一合格（lab-node 未接受、home-nas 离线、组长自己排除）
      expect(api.hub.mirrorWorkspace).toHaveBeenCalledTimes(1);
      expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith({
        groupId: 'g-peer',
        targetNodeId: '8f3a00000000c21e',
        workspaceName: '研发空间',
        snapshotId: 'snap-1',
      });
    });
  });

  it('PR-5. 组长换绑 → BindingDialog 提交走 groupBind；组长不见「接受」勾选与监控台开关（2026-11-08 修正）', async () => {
    // bind 动作后 store refresh——groupList 须回传同组，否则组清空进空态
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_PEER] });
    useHubGroupStore.setState({ groups: [GROUP_PEER] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    // 组长视角：监控台开关退场（组长是镜像源，接受语义不适用）
    expect(screen.queryByRole('switch', { name: '接受本组镜像' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '换绑' }));
    const bindDlg = await screen.findByRole('dialog', { name: /绑定承接空间/ });
    // 换绑弹窗同样无「接受本组镜像同步」勾选
    expect(within(bindDlg).queryByRole('checkbox', { name: /接受本组镜像同步/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('承接空间*'), { target: { value: 'ws-dev' } });
    fireEvent.click(within(bindDlg).getByRole('button', { name: '绑定' }));
    await waitFor(() => {
      expect(api.hub.groupBind).toHaveBeenCalledWith({ groupId: 'g-peer', workspaceId: 'ws-dev' });
    });
  });

  it('PR-6. 非组长 peer 成员：无统一镜像按钮；换绑与开关在场（自己成员行）', () => {
    const notLeader: HubGroupInfo = { ...GROUP_PEER, leaderNodeId: '8f3a00000000c21e' };
    useHubGroupStore.setState({ groups: [notLeader] });
    render(<GroupMonitor onOpenView={onOpenView} />);
    expect(screen.queryByRole('button', { name: /同步配置/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /绑定空间|换绑/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '接受本组镜像' })).toBeInTheDocument();
  });
});
