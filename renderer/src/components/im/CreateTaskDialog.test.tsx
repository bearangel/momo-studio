// renderer/src/components/im/CreateTaskDialog.test.tsx
//
// CreateTaskDialog 行为测试（B 子系统 B7 + v29 目标三选/循环预设 + M2.1 T8 单/批量与执行位置）：
//   1. open=false 时不渲染任何 DOM
//   2. open=true 时渲染表单核心字段（标题 / 描述 / 优先级）
//   3. preset 字段预填到表单（标题 / 描述）
//   4. 标题为空时禁用创建按钮
//   5. 提交成功后调 onCreated(taskId) + onClose（none 默认路径回归锁）
//   6. 选团队目标 → create 携带 targetTeamId（v29）
//   7. 选循环每天 09:00 → create 携带 recurrenceRule=daily@09:00（v29）
//   8. 团队目标未选时禁用创建按钮，选中后恢复（v29 校验路径）
//   9. M2.1 T8：单/批量 seg；批量 N 行→N 任务（空行跳过）统一路由；local 走既有
//      task.create；group/node 走 hub.submitRoutedTask；routing≠local 隐藏本地委派字段
//
// Mock 策略：mock ../../ipc/client（IPC 进程边界，业务逻辑 serializeRecurrence
// 走真实实现），agent.listMembers / team.list / session.list / task.create /
// hub.routingPrecheck / hub.submitRoutedTask 均为 vi.fn()，返回形状与 types.d.ts 契约对齐。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateTaskDialog } from './CreateTaskDialog';
import { useGroupStore } from '../../stores/group.store';
import type { GroupRow, RoutingPrecheckResult } from '../../ipc/types';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
const {
  mockTaskCreate, mockListAssignments, mockTeamList, mockSessionList, mockTaskGroupList,
  mockRoutingPrecheck, mockSubmitRoutedTask, showToastMock,
} = vi.hoisted(() => ({
  mockTaskCreate: vi.fn(),
  mockListAssignments: vi.fn(),
  mockTeamList: vi.fn(),
  mockSessionList: vi.fn(),
  mockTaskGroupList: vi.fn(),
  mockRoutingPrecheck: vi.fn(),
  mockSubmitRoutedTask: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    task: { create: mockTaskCreate },
    agent: { listMembers: mockListAssignments },
    team: { list: mockTeamList },
    session: { list: mockSessionList },
    taskGroup: { list: mockTaskGroupList },
    hub: { routingPrecheck: mockRoutingPrecheck, submitRoutedTask: mockSubmitRoutedTask },
  },
}));

vi.mock('../ui/Toast', () => ({ showToast: showToastMock }));

/** T8 预检夹具：已镜像 + 单组 g1（node-a/node-b 在线已镜像） */
function precheckFixture(overrides: Partial<RoutingPrecheckResult> = {}): RoutingPrecheckResult {
  return {
    mirrored: true,
    groups: [
      {
        groupId: 'g1',
        groupName: 'dev-team',
        onlineCount: 2,
        mirroredCount: 2,
        members: [
          { nodeId: 'node-a', name: 'office-mac', online: true, mirrored: true },
          { nodeId: 'node-b', name: 'lab-node', online: true, mirrored: true },
        ],
      },
    ],
    ...overrides,
  };
}

describe('CreateTaskDialog 截止时间退役（2026-09-30 §4.4）', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue([]);
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: 'ws1', selectedGroupId: null });
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
  });

  it('不含截止时间字段；提交 payload 无 deadlineAt', async () => {
    render(<CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    expect(screen.queryByLabelText('截止时间')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '无截止任务' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockTaskCreate).toHaveBeenCalled());
    const call = mockTaskCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('deadlineAt' in call).toBe(false);
  });
});

describe('CreateTaskDialog 分组默认值（看板选中分组透传，2026-09-30）', () => {
  const groups: GroupRow[] = [
    { id: 'G-001', workspaceId: 'ws1', name: '需求组', color: null, position: 1024, archivedAt: null, createdAt: 1, updatedAt: 1 },
    { id: 'G-002', workspaceId: 'ws1', name: '缺陷组', color: null, position: 2048, archivedAt: null, createdAt: 2, updatedAt: 2 },
  ];

  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue(groups);
    // currentWorkspaceId 对齐 ws1：防 effect 里 loadGroups 因 ws 切换判定同步清空
    // groups（受控 select 无匹配 option → value 显示 ''，同步断言误判）
    useGroupStore.setState({ groups, loading: false, error: null, currentWorkspaceId: 'ws1', selectedGroupId: null });
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
  });

  it('defaultGroupId 传入 → 打开即默认选中该分组', () => {
    render(
      <CreateTaskDialog
        open={true}
        onClose={() => {}}
        onCreated={() => {}}
        workspaceId="ws1"
        defaultGroupId="G-002"
      />,
    );
    const sel = screen.getByLabelText('分组') as HTMLSelectElement;
    expect(sel.value).toBe('G-002');
    expect(sel.selectedOptions[0]?.textContent).toBe('缺陷组');
  });

  it('未传 defaultGroupId → 默认「不分组」', () => {
    render(<CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    const sel = screen.getByLabelText('分组') as HTMLSelectElement;
    expect(sel.value).toBe('');
    expect(sel.selectedOptions[0]?.textContent).toBe('不分组');
  });

  it('默认分组随表单提交落库（create 携带 groupId）', async () => {
    render(
      <CreateTaskDialog
        open={true}
        onClose={() => {}}
        onCreated={() => {}}
        workspaceId="ws1"
        defaultGroupId="G-001"
      />,
    );
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '组内新任务' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => {
      expect(mockTaskCreate).toHaveBeenCalledWith(
        expect.objectContaining({ title: '组内新任务', groupId: 'G-001' }),
      );
    });
  });
});

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset();
    mockListAssignments.mockReset();
    mockTeamList.mockReset();
    mockSessionList.mockReset();
    mockTaskGroupList.mockReset();
    // 默认：创建成功返回 { id: 'T-100' }；指派/团队/会话列表
    // （形状与 Team / SessionSummary 契约的字段子集对齐，map 只消费 id/name/title）
    mockTaskCreate.mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockResolvedValue([]);
    mockTeamList.mockResolvedValue([{ id: 'team1', name: '写码组', members: [] }]);
    mockSessionList.mockResolvedValue([{ id: 'sess1', title: '既有会话' }]);
    mockTaskGroupList.mockResolvedValue([]);
    useGroupStore.setState({
      groups: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      selectedGroupId: null,
    });
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
  });

  it('open=false 时不渲染', () => {
    const { container } = render(
      <CreateTaskDialog open={false} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('open=true 时渲染表单（标题/描述/优先级）', () => {
    render(<CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    expect(screen.getByLabelText(/标题/)).toBeInTheDocument();
    expect(screen.getByLabelText(/描述/)).toBeInTheDocument();
    expect(screen.getByText(/优先级/)).toBeInTheDocument();
  });

  it('preset 预填字段', () => {
    render(
      <CreateTaskDialog
        open={true}
        onClose={() => {}}
        onCreated={() => {}}
        workspaceId="ws1"
        preset={{ title: 'T1', description: 'desc' }}
      />,
    );
    expect((screen.getByLabelText(/标题/) as HTMLInputElement).value).toBe('T1');
    expect((screen.getByLabelText(/描述/) as HTMLTextAreaElement).value).toBe('desc');
  });

  it('preset.assigneeAgentId 预填 → 目标类型初值 agent 且提交透传', async () => {
    mockListAssignments.mockResolvedValueOnce([{ instanceId: 'inst-1', agentName: 'Coder' }]);
    const onCreated = vi.fn();
    render(
      <CreateTaskDialog
        open
        onClose={() => {}}
        onCreated={onCreated}
        workspaceId="ws1"
        preset={{ assigneeAgentId: 'inst-1' }}
      />,
    );
    // 目标类型自动进 agent 分支（v29 预填语义，不回归旧指派体验）
    expect((screen.getByLabelText('委派目标类型') as HTMLSelectElement).value).toBe('agent');
    // 成员列表异步加载后委派目标预选 inst-1
    const targetSelect = (await screen.findByLabelText('委派目标')) as HTMLSelectElement;
    await waitFor(() => expect(targetSelect.value).toBe('inst-1'));
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '预填活' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // 互斥三列：agent 目标透传 assigneeAgentId，team/session 保持 null
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeAgentId: 'inst-1', targetTeamId: null, targetSessionId: null }),
    );
  });

  it('标题为空时禁用创建按钮', () => {
    render(<CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    expect(screen.getByRole('button', { name: /创建/ })).toBeDisabled();
  });

  it('提交后调 onCreated + onClose', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateTaskDialog
        open={true}
        onClose={onClose}
        onCreated={onCreated}
        workspaceId="ws1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: 'New Task' } });
    fireEvent.click(screen.getByRole('button', { name: /创建/ }));
    // 等待 IPC resolve + 回调链触发
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('T-100');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('选团队目标 → create 携带 targetTeamId', async () => {
    mockTaskCreate.mockResolvedValueOnce({ id: 'T-001' });
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '团队活' } });
    fireEvent.change(screen.getByLabelText('委派目标类型'), { target: { value: 'team' } });
    // 团队列表经 effect 异步加载，findBy 等待选项就绪后再选
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'team1' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('T-001'));
    // 断言生产消费的字段：targetTeamId 透传 + 三列互斥（session 为 null）
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ targetTeamId: 'team1', targetSessionId: null }),
    );
  });

  it('选循环每天 09:00 → create 携带 recurrenceRule=daily@09:00', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '日报' } });
    fireEvent.change(screen.getByLabelText('循环规则'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('运行时间'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRule: 'daily@09:00' }),
    );
  });

  // M-e 回归锁：间隔下限 1——负数/零不能穿透序列化（every:-5m 会打穿 electron
  // 侧 nextRun 的 \d+ 解析，循环任务静默失效）。min 属性是第一道防线（浏览器
  // 约束校验拦截提交），handleSubmit 的 Math.max 钳制是第二道（程序化提交路径）
  it('固定间隔输入负数 → 序列化前钳到下限 1（recurrenceRule=every:1m）', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '轮询' } });
    fireEvent.change(screen.getByLabelText('循环规则'), { target: { value: 'every' } });
    // 第一道防线：Input 带 min=1（jsdom 据此拦截按钮点击提交，故下文直发 submit）
    expect(screen.getByLabelText('间隔数值')).toHaveAttribute('min', '1');
    fireEvent.change(screen.getByLabelText('间隔数值'), { target: { value: '-5' } });
    // 第二道防线：绕过按钮（约束校验拦截层）直发 submit 事件，锁 handleSubmit 钳制
    // （Dialog 经 portal 渲染到 body，container 内无 form，从 document 取）
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRule: 'every:1m' }),
    );
  });

  it('固定间隔输入合法值 → 原样透传（every:30m 不受下限影响）', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '轮询' } });
    fireEvent.change(screen.getByLabelText('循环规则'), { target: { value: 'every' } });
    fireEvent.change(screen.getByLabelText('间隔数值'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRule: 'every:30m' }),
    );
  });

  it('团队目标未选时禁用创建按钮，选中后恢复', async () => {
    render(<CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '等团队' } });
    // none 默认路径：标题已填 → 按钮可用
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled();
    // 切到团队但未选具体团队 → 禁用
    fireEvent.change(screen.getByLabelText('委派目标类型'), { target: { value: 'team' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled();
    // 选中团队后恢复可用
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'team1' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled();
  });

  // UX 修复：新建任务可选分组落组——选项=不分组(默认)+活跃组（group.store），
  // 选中随 create 透传 groupId；主进程三重校验（存在/同 ws/未归档）
  describe('分组选择（UX 修复）', () => {
    function mkGroup(partial: Partial<GroupRow> & Pick<GroupRow, 'id' | 'name'>): GroupRow {
      return {
        workspaceId: 'ws1',
        color: null,
        position: 1024,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
        ...partial,
      };
    }

    it('分组下拉列「不分组」+ 活跃组名；默认不分组提交不带 groupId', async () => {
      mockTaskGroupList.mockResolvedValue([mkGroup({ id: 'g-1', name: '需求组' })]);
      render(<CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);

      const groupSelect = (await screen.findByLabelText('分组')) as HTMLSelectElement;
      expect(groupSelect.value).toBe('');
      expect(screen.getByRole('option', { name: '不分组' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: '需求组' })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '无组' } });
      fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
      await waitFor(() => expect(mockTaskCreate).toHaveBeenCalled());
      const input = mockTaskCreate.mock.calls[0]![0] as { groupId?: string };
      expect(input.groupId).toBeUndefined();
    });

    it('选组后提交 → create 调用参数含该组 groupId', async () => {
      mockTaskGroupList.mockResolvedValue([mkGroup({ id: 'g-1', name: '需求组' })]);
      const onCreated = vi.fn();
      render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);

      fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '落组' } });
      fireEvent.change(await screen.findByLabelText('分组'), { target: { value: 'g-1' } });
      fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockTaskCreate).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 'g-1' }),
      );
    });
  });
});

// M2.1 T8：单/批量模式切换 + 执行位置三选提交链。
// 提交分流契约：local → 既有 ipc.task.create（零变化回归）；group/node →
// ipc.hub.submitRoutedTask（三模式统一落点在主进程，renderer 不重复调度）。
describe('CreateTaskDialog — 单/批量与执行位置（M2.1 T8）', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue([]);
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null });
  });

  it('T8-1. 默认单任务：seg 在场且单任务选中；标题/描述在场，无批量 textarea', () => {
    render(<CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    expect(screen.getByRole('radio', { name: '单任务' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '批量' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText(/标题/)).toBeInTheDocument();
    expect(screen.getByLabelText(/描述/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/批量任务书/)).not.toBeInTheDocument();
    // 未传 workspaceName → 不渲染执行位置区（弹窗行为与 T8 前完全一致）
    expect(screen.queryByText('执行位置')).not.toBeInTheDocument();
    expect(mockRoutingPrecheck).not.toHaveBeenCalled();
  });

  it('T8-2. 切批量 → 标题/描述退场，批量任务书 textarea 在场；提交钮文案随行数', () => {
    render(<CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    expect(screen.queryByLabelText(/标题/)).not.toBeInTheDocument();
    const area = screen.getByLabelText(/批量任务书/) as HTMLTextAreaElement;
    expect(area).toBeInTheDocument();
    // 空内容 → 按钮禁用
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled();
    fireEvent.change(area, { target: { value: '任务一\n\n任务二\n任务三' } });
    expect(screen.getByRole('button', { name: '创建 3 个任务' })).toBeEnabled();
  });

  it('T8-3. 批量 local（未传 workspaceName）：N 行→N 次 task.create，空行跳过', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '升级 electron 到 44.x\n\n修复暗黑对比度\n补齐单测' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 3 个任务' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledTimes(3);
    expect(mockTaskCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: '升级 electron 到 44.x' }));
    expect(mockTaskCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: '修复暗黑对比度' }));
    expect(mockTaskCreate).toHaveBeenNthCalledWith(3, expect.objectContaining({ title: '补齐单测' }));
    expect(mockSubmitRoutedTask).not.toHaveBeenCalled();
    // onCreated 只回调一次（末任务 id），不逐任务开详情抽屉
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('T-100');
  });

  it('T8-4. 传 workspaceName → 预检拉取 + 执行位置区渲染；local 提交仍走 task.create（routing 不透传）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    expect(mockRoutingPrecheck).toHaveBeenCalledWith({ workspaceName: 'dev-ws' });
    const localRadio = await screen.findByRole('radio', { name: '本机执行' });
    expect(localRadio).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '本机活' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockTaskCreate).toHaveBeenCalled());
    const call = mockTaskCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect('routing' in call).toBe(false);
    expect(mockSubmitRoutedTask).not.toHaveBeenCalled();
  });

  it('T8-5. 选组内调度 → 提交走 hub.submitRoutedTask（title/description/routing 透传）；本地委派字段退场', async () => {
    const onCreated = vi.fn();
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '组内调度' });
    // 外派模式：本地委派目标/优先级/循环/计划开始退场（S2 单任务合同只留 标题/任务书/执行位置）
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    expect(screen.queryByLabelText('委派目标类型')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('优先级')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('循环规则')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('计划开始')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '排查断连' } });
    fireEvent.change(screen.getByLabelText(/描述/), { target: { value: '分析 gateway 日志' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalled());
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      workspaceName: 'dev-ws',
      title: '排查断连',
      description: '分析 gateway 日志',
      routing: { mode: 'group', groupId: 'g1' },
    });
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith('T-rem');
  });

  it('T8-6. 批量 + 组内调度：N 行统一路由依次提交（每次重跑调度），onCreated 单次回调', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '批量' });
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    await screen.findByRole('radio', { name: '组内调度' });
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '任务A\n任务B\n\n任务C' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 3 个任务' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(3);
    for (const [i, title] of ['任务A', '任务B', '任务C'].entries()) {
      expect(mockSubmitRoutedTask).toHaveBeenNthCalledWith(i + 1, {
        workspaceId: 'ws1',
        workspaceName: 'dev-ws',
        title,
        routing: { mode: 'group', groupId: 'g1' },
      });
    }
    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('T8-7. 批量指定节点：统一锁定目标成员提交', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '批量' });
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    await screen.findByRole('radio', { name: '指定节点' });
    fireEvent.click(screen.getByRole('radio', { name: '指定节点' }));
    const member = await screen.findByLabelText('目标成员');
    fireEvent.change(member, { target: { value: 'node-b' } });
    fireEvent.change(screen.getByLabelText(/批量任务书/), { target: { value: '只发一条' } });
    fireEvent.click(screen.getByRole('button', { name: '创建 1 个任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalled());
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '只发一条',
        routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-b' },
      }),
    );
  });

  it('T8-8. 预检失败（IPC rejection）→ 守门仅本机，提交不受阻', async () => {
    mockRoutingPrecheck.mockRejectedValue(new Error('ipc broken'));
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '本机执行' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('radio', { name: '组内调度' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '降级本机' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockTaskCreate).toHaveBeenCalled());
  });

  // M2.1 T9（T8 Low-1 顺修）：批量提交 per-line catch——单行失败不中断余行
  it('T9-1. 批量 2 行第 1 行拒 → 第 2 行仍提交成功；失败摘要 toast；onCreated 收成功行', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockSubmitRoutedTask
      .mockRejectedValueOnce(new Error('工作组不存在或已退出，无法外派任务'))
      .mockResolvedValueOnce({ task: { id: 'T-ok' }, dispatched: true, nodeId: 'node-a' });
    render(
      <CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '批量' });
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    await screen.findByRole('radio', { name: '组内调度' });
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '会失败的一行\n正常的一行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 2 个任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('T-ok'));
    expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('1 个任务创建失败'));
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('会失败的一行'));
  });

  it('T9-2. 批量全失败 → 不关窗 + 弹窗内错误行呈现失败摘要（可改后重试）', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockTaskCreate.mockReset().mockRejectedValue(new Error('数据库已锁'));
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '甲行\n乙行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 2 个任务' }));
    await waitFor(() => expect(mockTaskCreate).toHaveBeenCalledTimes(2));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/2 个任务创建失败/)).toBeInTheDocument();
    expect(screen.getByText(/数据库已锁/)).toBeInTheDocument();
  });
});
