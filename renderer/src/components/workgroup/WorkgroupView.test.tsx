// renderer/src/components/workgroup/WorkgroupView.test.tsx
//
// 工作组视图测试（momo-hub M2.1 Task 2 骨架 + Task 3 监控台接线 + Task 4 查看态）：
// - D2 治愈断言：无工作空间上下文也渲染未接入空态（工作组是节点级能力）
// - 未接入（!configured）：空态文案 + 「接入 hub」打开就地表单；提交走 ipc mock
//   （window.api.hub.enroll，trim 后入参）；成功翻监控台（无组空态引导）
// - enroll 失败：错误原文展示（ipc 代理剥包装前缀纪律）
// - 已接入（configured）：直接监控台占位，无接入表单；configured&&!online 仍渲染
//   空态但不 init 拉取（对齐 GroupPanel——离线拉取只产生 store.error 红行噪音）
// - 「什么是工作组？」非死入口：点击切换帮助文案
// - T4 查看链路：节点卡「查看」→ ViewPickerDialog（S3b）→ 选中空间后主区整体切
//   RemoteViewPane（S4 四页签）→「退出查看」回监控态；非组长节点卡查看禁用
//   （M2 leader-only 迁移语义）
// - M4.2 组过滤接线：选中组（effectiveSelectedGroup——手选缺省回落第一组，与
//   监控台同推导）传入委派 store → taskList 带 groupId；无组不携带（全组聚合
//   现状）；组切换即时重拉
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkgroupView } from './WorkgroupView';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubGroupInfo, HubStatus } from '../../ipc/types';

const api = {
  hub: {
    getStatus: vi.fn(),
    configure: vi.fn(),
    enroll: vi.fn(),
    forget: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    onNodePresence: vi.fn(() => () => undefined),
    // T3 起已接入态渲染监控台：组/委派 store 由视图 init（真实现 + 空载 mock）
    groupList: vi.fn(),
    onGroupChanged: vi.fn(() => () => undefined),
    taskList: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
    // T4 查看链路：hub-view.store init/openPanel 消费 view.* 通道面
    viewWorkspace: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewTasks: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn(),
    // M3.2 远端清单 + 文件树
    viewWorkspaces: vi.fn(),
    viewFiles: vi.fn(),
    onViewAppended: vi.fn(() => () => undefined),
  },
  workspace: {
    list: vi.fn(),
    switch: vi.fn(async () => undefined),
  },
};

const UNENROLLED: HubStatus = {
  configured: false,
  state: 'disconnected',
  hubUrl: null,
  nodeName: null,
  nodeId: null,
  lastError: null,
  lastErrorCode: null,
  hubProtoVer: null,
};

const ENROLLED_ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: '办公室 MacBook',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
  lastErrorCode: null,
  hubProtoVer: null,
};

const ENROLLED_OFFLINE: HubStatus = {
  configured: true,
  state: 'disconnected',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: '办公室 MacBook',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
  lastErrorCode: null,
  hubProtoVer: null,
};

const SELF_ID = 'a3f9c2e1deadbeef';

/** 本机 leader 的组（T4 查看链路用） */
const GROUP_DEV: HubGroupInfo = {
  groupId: 'g-dev',
  groupName: 'dev-team',
  leaderNodeId: SELF_ID,
  members: [
    { nodeId: SELF_ID, name: 'mac-main', online: true },
    { nodeId: '8f3a00000000c21e', name: 'office-mac', online: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.hub.groupList.mockResolvedValue({ groups: [] });
  api.hub.taskList.mockResolvedValue({ tasks: [] });
  api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
  api.hub.viewWorkspace.mockResolvedValue({
    overview: { name: 'lab', description: '', sessionCount: 0 },
    agentMembers: [], teams: [], mcpEnabled: [], skills: [], pluginsEnabled: [],
    resourcesSummary: { agent: 0, mcp: 0, skill: 0, plugin: 0 },
  });
  api.hub.viewSessions.mockResolvedValue({ sessions: [] });
  api.hub.viewTasks.mockResolvedValue({ tasks: [] });
  api.hub.viewWorkspaces.mockResolvedValue({ workspaces: [] });
  api.hub.viewFiles.mockResolvedValue({ entries: [], truncated: false });
  api.workspace.list.mockResolvedValue([
    { id: 'ws-1', name: 'product-dev' },
    { id: 'ws-2', name: 'lab' },
  ]);
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  useHubStore.setState({ status: null, nodes: [], loadError: null });
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
    waiting: {},
    groupNames: {},
    groupIdFilter: null,
  });
  useHubViewStore.setState({
    open: false, picking: false,
    pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
    targetNodeId: null, targetName: null,
    workspaceId: null, workspaceName: null, groupId: null, tab: 'overview',
    overview: null, sessions: [], tasks: [],
    files: { dirs: {}, preview: null, loadingDir: null, loadingFile: null, error: null },
    loading: false, error: null, replay: null,
  });
  // D2 断言前提：不准备任何工作空间（getActive() 为空）
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, loading: false, error: null });
});

describe('WorkgroupView', () => {
  it('未接入且无工作空间：渲染空态（D2 治愈——不依赖工作空间存在）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    expect(await screen.findByText('尚未接入工作组网络')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接入 hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '什么是工作组？' })).toBeInTheDocument();
  });

  it('点击「接入 hub」打开就地表单（三字段 + 提交按钮）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));
    expect(screen.getByLabelText('hub 地址')).toBeInTheDocument();
    expect(screen.getByLabelText('节点名')).toBeInTheDocument();
    expect(screen.getByLabelText('加入凭证')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接入' })).toBeInTheDocument();
  });

  it('提交走 ipc mock（trim 后入参），成功后翻监控台（无组空态引导）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    api.hub.enroll.mockResolvedValue(ENROLLED_ONLINE);
    api.hub.groupList.mockResolvedValue({ groups: [] });
    api.hub.taskList.mockResolvedValue({ tasks: [] });
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));

    fireEvent.change(screen.getByLabelText('hub 地址'), {
      target: { value: ' https://hub.example.com:8787 ' },
    });
    fireEvent.change(screen.getByLabelText('节点名'), { target: { value: ' 办公室 MacBook ' } });
    fireEvent.change(screen.getByLabelText('加入凭证'), { target: { value: ' join-7f3k-q2x9 ' } });
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    await waitFor(() => {
      expect(api.hub.enroll).toHaveBeenCalledWith({
        hubUrl: 'https://hub.example.com:8787',
        enrollmentToken: 'join-7f3k-q2x9',
        nodeName: '办公室 MacBook',
      });
    });
    expect(await screen.findByText('尚未加入任何工作组')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接入 hub' })).not.toBeInTheDocument();
  });

  it('enroll 失败：错误原文展示（role=alert），不翻占位', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    api.hub.enroll.mockRejectedValue(new Error('加入凭证无效'));
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));
    fireEvent.change(screen.getByLabelText('hub 地址'), {
      target: { value: 'https://hub.example.com:8787' },
    });
    fireEvent.change(screen.getByLabelText('节点名'), { target: { value: '办公室 MacBook' } });
    fireEvent.change(screen.getByLabelText('加入凭证'), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('加入凭证无效');
    expect(screen.queryByText('监控台建设中')).not.toBeInTheDocument();
  });

  it('已接入（configured）：直接渲染监控台组合，无接入表单', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    api.hub.groupList.mockResolvedValue({ groups: [] });
    api.hub.taskList.mockResolvedValue({ tasks: [] });
    render(<WorkgroupView />);
    expect(await screen.findByText('尚未加入任何工作组')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接入 hub' })).not.toBeInTheDocument();
  });

  // T3 评审收口：init 门控对齐 GroupPanel 的 online 语义——configured&&!online
  // 时仍渲染空态但不订阅不拉取（离线拉取只会把连接错误落进 store.error 红行噪音）
  it('已接入但离线：渲染空态且不调用组列表拉取', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_OFFLINE);
    render(<WorkgroupView />);
    expect(await screen.findByText('尚未加入任何工作组')).toBeInTheDocument();
    await waitFor(() => {
      expect(api.hub.getStatus).toHaveBeenCalled();
    });
    expect(api.hub.groupList).not.toHaveBeenCalled();
    expect(api.hub.taskList).not.toHaveBeenCalled();
    expect(api.hub.onGroupChanged).not.toHaveBeenCalled();
  });

  // T2 评审收口：getStatus 快照失败时 hub.store 置 loadError 且 status 保持 null
  // ——此前视图停在「加载中…」死端。回归锁：错误行（role=alert）+「重试」可点，
  // 点击走 store.refresh()（清 loadError + 复用订阅重拉快照）。
  it('getStatus 失败：渲染错误行（role=alert）+ 重试可点并重拉快照', async () => {
    api.hub.getStatus.mockRejectedValue(new Error('ipc failed'));
    render(<WorkgroupView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('状态读取失败');
    expect(screen.queryByText('尚未接入工作组网络')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(api.hub.getStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('「什么是工作组？」非死入口：点击切换帮助文案', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    await screen.findByText('尚未接入工作组网络');
    expect(screen.queryByText(/跨设备节点编队/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '什么是工作组？' }));
    expect(screen.getByText(/跨设备节点编队/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '什么是工作组？' }));
    expect(screen.queryByText(/跨设备节点编队/)).not.toBeInTheDocument();
  });
});

describe('WorkgroupView 查看链路（T4：S3b 选择器 + S4 全宽查看态）', () => {
  it('M4.2 组过滤接线：组落地 → taskList 带选中组 groupId（缺省回落第一组，与监控台同推导）；手选切换即时重拉', async () => {
    const GROUP_OPS: HubGroupInfo = {
      groupId: 'g-ops',
      groupName: 'ops-team',
      leaderNodeId: SELF_ID,
      members: [{ nodeId: SELF_ID, name: 'mac-main', online: true }],
    };
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    api.hub.taskList.mockResolvedValue({ tasks: [] });
    render(<WorkgroupView />);
    // 组清单落地 → 生效选中组 = 第一组（手选缺省回落）→ 委派过滤生效
    await waitFor(() => expect(api.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-dev' }));
    expect(useHubDelegationStore.getState().groupIdFilter).toBe('g-dev');

    // 手选另一组 → 过滤切换即时重拉（铁律 5：当前上下文，非配置默认值）
    useHubGroupStore.setState({ groups: [GROUP_DEV, GROUP_OPS], selectedGroupId: 'g-ops' });
    await waitFor(() => expect(api.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-ops' }));
    expect(useHubDelegationStore.getState().groupIdFilter).toBe('g-ops');
  });

  it('M4.2 组过滤接线：无组 → taskList 无参调用（全组聚合现状零变化）', async () => {
    render(<WorkgroupView />);
    await waitFor(() => expect(api.hub.taskList).toHaveBeenCalled());
    expect(api.hub.taskList).toHaveBeenLastCalledWith(undefined);
    expect(useHubDelegationStore.getState().groupIdFilter).toBeNull();
  });

  it('节点卡「查看」→ 选择器弹窗 → 选中空间后主区整体切 RemoteViewPane →「退出查看」回监控态', async () => {
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    fireEvent.click(within(officeCard).getByRole('button', { name: '查看' }));

    // S3b 选择器：拉本机空间清单渲染行；选择前不拉远端
    const row = await screen.findByRole('button', { name: '选择工作空间 lab' });
    expect(api.hub.viewWorkspace).not.toHaveBeenCalled();

    fireEvent.click(row);
    // S4 全宽查看态：主区整体替换（监控台节点卡消失）
    const pane = await screen.findByLabelText('查看 office-mac 的工作空间 lab');
    expect(within(pane).getByRole('tab', { name: '概览' })).toBeInTheDocument();
    expect(screen.queryByLabelText('节点 office-mac')).not.toBeInTheDocument();

    // 退出查看回监控态
    fireEvent.click(screen.getByRole('button', { name: '退出查看' }));
    expect(await screen.findByLabelText('节点 office-mac')).toBeInTheDocument();
    expect(screen.queryByLabelText('查看 office-mac 的工作空间 lab')).not.toBeInTheDocument();
  });

  it('单空间直达：节点卡「查看」后跳过选择器直接进全宽查看态', async () => {
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    api.workspace.list.mockResolvedValue([{ id: 'ws-1', name: 'product-dev' }]);
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    fireEvent.click(within(officeCard).getByRole('button', { name: '查看' }));
    expect(await screen.findByLabelText('查看 office-mac 的工作空间 product-dev')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('非组长（本机普通成员）：节点卡「查看」禁用（M2 leader-only 迁移语义）', async () => {
    api.hub.groupList.mockResolvedValue({
      groups: [{ ...GROUP_DEV, leaderNodeId: '8f3a00000000c21e' }],
    });
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    expect(within(officeCard).getByRole('button', { name: '查看' })).toBeDisabled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M3.2 查看入口门控（hubSupportsMinor 4 三态：1.4 远端清单 / 1.3·null 本机回落）
// ────────────────────────────────────────────────────────────────────────────

describe('WorkgroupView 查看入口数据源门控（M3.2）', () => {
  it('hub 1.4：节点卡「查看」→ openRemotePick（viewWorkspaces 带选中组 groupId，不读本机清单）', async () => {
    api.hub.getStatus.mockResolvedValue({ ...ENROLLED_ONLINE, hubProtoVer: '1.4.0' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    api.hub.viewWorkspaces.mockResolvedValue({
      workspaces: [
        { id: 'rws-1', name: 'remote-lab', description: '' },
        { id: 'rws-2', name: 'remote-docs', description: '' },
      ],
    });
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    fireEvent.click(within(officeCard).getByRole('button', { name: '查看' }));

    // 带选中组（GROUP_DEV）groupId；本机 workspace.list 不参与
    await waitFor(() =>
      expect(api.hub.viewWorkspaces).toHaveBeenCalledWith({ targetNodeId: '8f3a00000000c21e', groupId: 'g-dev' }),
    );
    expect(api.workspace.list).not.toHaveBeenCalled();
    // 远端行渲染（选择器数据源 = pickerWorkspaces）
    expect(await screen.findByRole('button', { name: '选择工作空间 remote-lab' })).toBeInTheDocument();
  });

  it('hub 1.3：回落本机清单（不调 viewWorkspaces；选择器行为与 M2 一致）', async () => {
    api.hub.getStatus.mockResolvedValue({ ...ENROLLED_ONLINE, hubProtoVer: '1.3.0' });
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    fireEvent.click(within(officeCard).getByRole('button', { name: '查看' }));
    expect(await screen.findByRole('button', { name: '选择工作空间 lab' })).toBeInTheDocument();
    expect(api.hub.viewWorkspaces).not.toHaveBeenCalled();
  });

  it('hub 版本未协商（null）：同回落本机清单（未连接/未知即不可用）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE); // hubProtoVer: null
    api.hub.groupList.mockResolvedValue({ groups: [GROUP_DEV] });
    render(<WorkgroupView />);
    const officeCard = await screen.findByLabelText('节点 office-mac');
    fireEvent.click(within(officeCard).getByRole('button', { name: '查看' }));
    expect(await screen.findByRole('button', { name: '选择工作空间 product-dev' })).toBeInTheDocument();
    expect(api.hub.viewWorkspaces).not.toHaveBeenCalled();
  });
});
