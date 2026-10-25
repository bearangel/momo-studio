// renderer/src/components/hub/DelegationPanel.test.tsx
//
// 委派面板行为测试（M2e T12——task-12-preview 批准稿交互要点逐项）：
// - 六态列表渲染（徽标 label + cancelled 降权）；行点击展开/收起
// - 展开详情：任务书 owner 气泡 + 进度流（批次分隔 / 工具摘要 chip / 实时尾 seq）
// - 取消两步确认（running 与 interrupted 可见；终态无取消）
// - failed 人话错误行（declined）+ 重新委派预填
// - interrupted 提示条（重连自动续跑）与冻结尾标
// - 「新建委派」入口 leader 门控（无 leader 组禁用）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DelegationPanel } from './DelegationPanel';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import type { HubDelegationStatus, HubTaskRecord } from '../../ipc/types';

const api = {
  hub: {
    taskList: vi.fn(),
    taskDelegate: vi.fn(),
    taskCancel: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
  },
};

function task(status: HubDelegationStatus, overrides?: Partial<HubTaskRecord>): HubTaskRecord {
  return {
    taskId: `tk-${status}`,
    workspaceName: 'product-dev',
    targetNodeId: 'node-b',
    status,
    title: `任务-${status}`,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.taskList.mockResolvedValue({ tasks: [] });
  useHubStore.setState({
    status: {
      configured: true, state: 'online', hubUrl: 'https://hub.example.com',
      nodeName: '办公室 MacBook', nodeId: 'node-a', lastError: null,
    },
    nodes: [], loadError: null,
  });
  useHubGroupStore.setState({
    groups: [{
      groupId: 'g1',
      groupName: '分布式研发组',
      leaderNodeId: 'node-a',
      members: [
        { nodeId: 'node-a', name: '办公室 MacBook', online: true },
        { nodeId: 'node-b', name: 'studio-mini', online: true },
        { nodeId: 'node-c', name: 'laptop-win', online: false },
      ],
    }],
    loading: false, error: null, inviteCodes: {},
  });
  useHubDelegationStore.setState({
    tasks: [], loading: false, error: null, expandedTaskId: null,
    streams: {}, prompts: {}, agentSlugs: {}, sessionIds: {}, reasons: {},
    wizardOpen: false, wizardStep: 1, wizardGroupId: null, wizardGroupName: null,
    wizardTargetNodeId: null, wizardWorkspaceId: null, wizardWorkspaceName: null,
    wizardAgentSlug: '', wizardTitle: '', wizardPrompt: '',
    wizardSubmitting: false, wizardSubmitError: null, wizardAcceptedTaskId: null,
  });
});

describe('委派列表（六态）', () => {
  it('六态徽标 label 逐一渲染；cancelled 行标题降权', async () => {
    api.hub.taskList.mockResolvedValue({
      tasks: (['pending', 'running', 'done', 'failed', 'interrupted', 'cancelled'] as HubDelegationStatus[]).map((s) => task(s)),
    });
    render(<DelegationPanel />);
    await waitFor(() => expect(screen.getByText('待执行')).toBeDefined());
    for (const label of ['执行中', '已完成', '失败', '已中断', '已取消']) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText('任务-cancelled').className).toContain('text-secondary');
    expect(screen.getByText('任务-running').className).toContain('text-primary');
  });

  it('空列表空态 + 计数徽标；刷新按钮重拉', async () => {
    render(<DelegationPanel />);
    await waitFor(() => expect(screen.getByText(/暂无委派任务/)).toBeDefined());
    fireEvent.click(screen.getByLabelText('刷新委派列表'));
    await waitFor(() => expect(api.hub.taskList).toHaveBeenCalledTimes(2));
  });

  it('行点击展开详情（taskId 短码 + 任务书 owner 气泡）；再击收起', async () => {
    api.hub.taskList.mockResolvedValue({ tasks: [task('running')] });
    useHubDelegationStore.setState({ prompts: { 'tk-running': '请重构登录模块并跑绿测试。' } });
    render(<DelegationPanel />);
    await waitFor(() => expect(screen.getByText('任务-running')).toBeDefined());
    fireEvent.click(screen.getByLabelText('展开任务 任务-running'));
    expect(screen.getByText('请重构登录模块并跑绿测试。')).toBeDefined();
    expect(screen.getByText(/tk-running/)).toBeDefined();
    expect(screen.getByText('studio-mini · product-dev', { exact: false }).textContent).toContain('studio-mini');
    fireEvent.click(screen.getByText('收起'));
    await waitFor(() => expect(screen.queryByText('请重构登录模块并跑绿测试。')).toBeNull());
  });
});

describe('展开详情 · 进度流', () => {
  function openWithEntries(): void {
    useHubDelegationStore.setState({
      tasks: [task('running', { taskId: 'tk-1' })],
      prompts: { 'tk-1': '任务书正文' },
      expandedTaskId: 'tk-1',
      streams: {
        'tk-1': [
          { count: 3, lastSeq: 142, excerpt: '已完成错误包装，正在补单测——', at: Date.now() },
          { count: 1, lastSeq: 150, excerpt: '调用工具 bash', at: Date.now() },
        ],
      },
    });
  }

  it('批次分隔（含拍数）+ 文本气泡 + 工具摘要 chip + 实时尾 seq', () => {
    openWithEntries();
    render(<DelegationPanel />);
    expect(screen.getByText(/500ms 批次合并/).textContent).toContain('1 events'); // 批次间分隔（第二批单拍）
    expect(screen.getByText('已完成错误包装，正在补单测——')).toBeDefined();
    expect(screen.getByText('bash', { exact: false })).toBeDefined(); // ToolCallChip 等宽工具名
    expect(screen.getByText('bash', { exact: false })).toBeDefined(); // ToolCallChip 等宽工具名
    expect(screen.getByText('150')).toBeDefined(); // 实时尾 seq（mono 节点）
    expect(screen.getByText('任务书正文')).toBeDefined(); // owner 气泡
  });

  it('interrupted：提示条（重连自动续跑）+ 冻结尾标 + 取消仍可见', () => {
    useHubDelegationStore.setState({
      tasks: [task('interrupted', { taskId: 'tk-1' })],
      expandedTaskId: 'tk-1',
      streams: { 'tk-1': [{ count: 2, lastSeq: 118, excerpt: '已抓取两个定价页', at: Date.now() }] },
    });
    render(<DelegationPanel />);
    expect(screen.getByText(/重连后自动续跑/)).toBeDefined();
    expect(screen.getByText(/已冻结于 seq/).textContent).toContain('118');
    expect(screen.getByText('取消任务')).toBeDefined();
  });
});

describe('取消两步确认', () => {
  it('running：首击进入确认（再击一次 + 收起确认）→ 再击发 taskCancel → 落 cancelled', async () => {
    api.hub.taskList.mockResolvedValue({ tasks: [task('running', { taskId: 'tk-1' })] });
    api.hub.taskCancel.mockResolvedValue({ ok: true });
    render(<DelegationPanel />);
    await waitFor(() => expect(screen.getByLabelText('展开任务 任务-running')).toBeDefined());
    fireEvent.click(screen.getByLabelText('展开任务 任务-running'));
    fireEvent.click(screen.getByText('取消任务'));
    expect(screen.getByText('再击一次 · 确认取消')).toBeDefined();
    expect(api.hub.taskCancel).not.toHaveBeenCalled();
    api.hub.taskList.mockResolvedValue({ tasks: [task('cancelled', { taskId: 'tk-1' })] }); // 重拉对账权威态
    fireEvent.click(screen.getByText('再击一次 · 确认取消'));
    await waitFor(() => expect(api.hub.taskCancel).toHaveBeenCalledWith({ taskId: 'tk-1' }));
    await waitFor(() => expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('cancelled'));
  });

  it('终态（done/cancelled/failed）无取消按钮', () => {
    useHubDelegationStore.setState({
      tasks: [task('done', { taskId: 'tk-d' }), task('cancelled', { taskId: 'tk-c' })],
      expandedTaskId: 'tk-d',
    });
    render(<DelegationPanel />);
    expect(screen.queryByText('取消任务')).toBeNull();
  });
});

describe('failed 人话错误行与重新委派', () => {
  it('declined 附因人话 + 回执码；重新委派打开向导预填同任务书', async () => {
    useHubDelegationStore.setState({
      tasks: [task('failed', { taskId: 'tk-f' })],
      expandedTaskId: 'tk-f',
      prompts: { 'tk-f': '旧任务书内容' },
      agentSlugs: { 'tk-f': 'coder' },
      reasons: { 'tk-f': 'declined:并发已达上限（2）' },
    });
    const { DelegationWizard } = await import('./DelegationWizard');
    render(<><DelegationPanel /><DelegationWizard /></>);
    expect(screen.getByText('目标节点拒绝受理，任务没有开始')).toBeDefined();
    expect(screen.getByText('并发已达上限（2）')).toBeDefined();
    expect(screen.getByText(/declined:并发已达上限/)).toBeDefined();

    fireEvent.click(screen.getByText('重新委派'));
    const st = useHubDelegationStore.getState();
    expect(st.wizardOpen).toBe(true);
    expect(st.wizardTargetNodeId).toBe('node-b');
    expect(st.wizardWorkspaceName).toBe('product-dev');
    expect(st.wizardTitle).toBe('任务-failed');
    expect(st.wizardPrompt).toBe('旧任务书内容');
    expect(st.wizardAgentSlug).toBe('coder');
    // 向导 S1 已可见（三步首步标题）
    expect(screen.getByText('委派任务到节点')).toBeDefined();
  });
});

describe('新建委派入口门控', () => {
  it('本机为 leader 的组存在 → 按钮可用并绑定该组', async () => {
    api.hub.taskList.mockResolvedValue({ tasks: [] });
    render(<DelegationPanel />);
    const btn = screen.getByText('新建委派');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(useHubDelegationStore.getState().wizardGroupId).toBe('g1');
  });

  it('无 leader 组 → 按钮禁用（leader-only）', () => {
    useHubGroupStore.setState({
      groups: [{
        groupId: 'g1', groupName: '组', leaderNodeId: 'node-b',
        members: [{ nodeId: 'node-a', name: '本机', online: true }],
      }],
      loading: false, error: null, inviteCodes: {},
    });
    render(<DelegationPanel />);
    expect((screen.getByText('新建委派') as HTMLButtonElement).disabled).toBe(true);
  });
});
