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
//   9. M2.1 T8：单/批量 seg；批量 N 行→N 任务（空行跳过）统一路由；**本机批量走
//      单 IPC task.createBatch（M3.3 替换逐行循环，store 真实实现承接）**；group/node
//      走 hub.submitRoutedTask 逐行（hub 无批量通道）；routing≠local 隐藏本地委派字段
//  10. M3.3 `::` 依赖语法：parseTaskLine 纯函数（无依赖行零变化锁）+ 批量/单任务
//      提交链 dependsOn 透传 + 整批 rejection / per-item 失败展示
//
// Mock 策略：mock ../../ipc/client（IPC 进程边界，业务逻辑 serializeRecurrence /
// task.store 走真实实现），agent.listMembers / team.list / session.list / task.create /
// task.createBatch / hub.routingPrecheck / hub.submitRoutedTask 均为 vi.fn()，
// 返回形状与 types.d.ts 契约对齐。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateTaskDialog, parseTaskLine, TEAM_DELEGATION_REQUIRED_MINOR } from './CreateTaskDialog';
import { useGroupStore } from '../../stores/group.store';
import { useTaskStore } from '../../stores/task.store';
import type { GroupRow, RoutingPrecheckResult, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
const {
  mockTaskCreate, mockTaskCreateBatch, mockListAssignments, mockTeamList, mockSessionList, mockTaskGroupList,
  mockRoutingPrecheck, mockSubmitRoutedTask, mockGetDelegationSettings, mockWorkspaceList, showToastMock,
} = vi.hoisted(() => ({
  mockTaskCreate: vi.fn(),
  mockTaskCreateBatch: vi.fn(),
  mockListAssignments: vi.fn(),
  mockTeamList: vi.fn(),
  mockSessionList: vi.fn(),
  mockTaskGroupList: vi.fn(),
  mockRoutingPrecheck: vi.fn(),
  mockSubmitRoutedTask: vi.fn(),
  mockGetDelegationSettings: vi.fn().mockResolvedValue({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 }),
  mockWorkspaceList: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    task: { create: mockTaskCreate, createBatch: mockTaskCreateBatch },
    agent: { listMembers: mockListAssignments },
    team: { list: mockTeamList },
    session: { list: mockSessionList },
    taskGroup: { list: mockTaskGroupList },
    workspace: { list: mockWorkspaceList },
    hub: {
      routingPrecheck: mockRoutingPrecheck,
      submitRoutedTask: mockSubmitRoutedTask,
      getDelegationSettings: mockGetDelegationSettings,
    },
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
    mockTaskCreateBatch.mockReset().mockResolvedValue({ results: [{ ok: true, task: { id: 'T-100' } }] });
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue([]);
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null });
    // store 真实实现承接批量（M3.3）：tasks 跨用例残留会污染 append 断言
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null, currentWorkspaceId: null, pendingMoveCount: 0, dragging: false });
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

  it('T8-3. 批量 local（未传 workspaceName）：N 行→单次 task.createBatch（M3.3），空行跳过，items 保输入序', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockTaskCreateBatch.mockResolvedValue({
      results: [
        { ok: true, task: { id: 'T-101' } },
        { ok: true, task: { id: 'T-102' } },
        { ok: true, task: { id: 'T-103' } },
      ],
    });
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '升级 electron 到 44.x\n\n修复暗黑对比度\n补齐单测' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 3 个任务' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 单 IPC 批量（替换逐行循环）：一次调用携带 3 项，行序保持用户输入序
    expect(mockTaskCreateBatch).toHaveBeenCalledTimes(1);
    expect(mockTaskCreateBatch).toHaveBeenCalledWith({
      items: [
        { workspaceId: 'ws1', title: '升级 electron 到 44.x' },
        { workspaceId: 'ws1', title: '修复暗黑对比度' },
        { workspaceId: 'ws1', title: '补齐单测' },
      ],
    });
    expect(mockSubmitRoutedTask).not.toHaveBeenCalled();
    // onCreated 只回调一次（末次成功任务 id），不逐任务开详情抽屉
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('T-103');
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
      permissionTier: 'confirm',
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
        permissionTier: 'confirm',
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
    // M3.3：全失败经 per-item union 表达（不再是逐行 IPC rejection）
    mockTaskCreateBatch.mockResolvedValue({
      results: [
        { ok: false, index: 0, error: '数据库已锁' },
        { ok: false, index: 1, error: '数据库已锁' },
      ],
    });
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '甲行\n乙行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 2 个任务' }));
    await waitFor(() => expect(mockTaskCreateBatch).toHaveBeenCalledTimes(1));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/2 个任务创建失败/)).toBeInTheDocument();
    // per-line 错误展示沿用现有 UI：原始行 + 主进程人话错误
    expect(screen.getByText(/「甲行」数据库已锁/)).toBeInTheDocument();
    expect(screen.getByText(/「乙行」数据库已锁/)).toBeInTheDocument();
  });

  // M2.1 T10：权限档位三选——外派模式档位行 + 提交链随载荷
  it('T10-1. 选组内调度 + 档位「只读」→ submitRoutedTask 载荷带 permissionTier:"readonly"', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '组内调度' });
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    // 外派模式 → 档位行在场（默认执行端确认）；切「只读」
    fireEvent.click(screen.getByRole('radio', { name: '只读' }));
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '只读巡检' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalled());
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '只读巡检',
        routing: { mode: 'group', groupId: 'g1' },
        permissionTier: 'readonly',
      }),
    );
  });

  it('T10-2. 批量 + 档位「沙箱全权」→ 逐行载荷统一带 permissionTier:"sandbox"', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '批量' });
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    await screen.findByRole('radio', { name: '组内调度' });
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '沙箱全权' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), { target: { value: '行甲\n行乙' } });
    fireEvent.click(screen.getByRole('button', { name: '创建 2 个任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(2));
    expect(mockSubmitRoutedTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: '行甲', permissionTier: 'sandbox' }),
    );
    expect(mockSubmitRoutedTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: '行乙', permissionTier: 'sandbox' }),
    );
  });

  it('T10-3. 本机模式无档位行（local 提交不涉权限档位）；local→外派切换档位行进场', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    await screen.findByRole('radio', { name: '本机执行' });
    expect(screen.queryByRole('radiogroup', { name: '权限策略' })).not.toBeInTheDocument();
    // 切外派 → 档位行进场且默认 confirm
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    expect(screen.getByRole('radio', { name: '执行端确认' })).toHaveAttribute('aria-checked', 'true');
    // 回本机 → 档位行退场（值保留但不随 local 提交透传）
    fireEvent.click(screen.getByRole('radio', { name: '本机执行' }));
    expect(screen.queryByRole('radiogroup', { name: '权限策略' })).not.toBeInTheDocument();
  });
});

// ═══ M2.2 P2-2：批量超限预检提示行（不拦提交——declined 语义保持 UC4 口径）═══
describe('CreateTaskDialog — 批量并发预检（M2.2 P2-2）', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockTaskCreateBatch.mockReset().mockResolvedValue({ results: [{ ok: true, task: { id: 'T-100' } }] });
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    mockGetDelegationSettings.mockReset().mockResolvedValue({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null });
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null, currentWorkspaceId: null, pendingMoveCount: 0, dragging: false });
  });

  it('P2-2a. 批量行数 > 目标并发上限（外派路由）→ 提示行在场且可提交（不拦提交）', async () => {
    const onCreated = vi.fn();
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '任务A\n任务B\n任务C' },
    });

    const hint = screen.getByTestId('batch-concurrency-hint');
    expect(hint.textContent).toContain('3');
    expect(hint.textContent).toContain('2');
    expect(hint.textContent).toContain('declined');

    const submit = screen.getByRole('button', { name: '创建 3 个任务' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(3));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('P2-2b. 未超限（行数 ≤ 上限）→ 无提示行', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '任务A\n任务B' },
    });
    expect(screen.queryByTestId('batch-concurrency-hint')).not.toBeInTheDocument();
  });

  it('P2-2c. 本机路由不预检并发（local 行落看板排队，无 declined 面）+ 设置拉取失败静默降级', async () => {
    mockGetDelegationSettings.mockReset().mockRejectedValue(new Error('ipc down'));
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '任务A\n任务B\n任务C' },
    });
    // 本机执行（缺省路由）→ 即使行数超上限也无提示
    expect(screen.queryByTestId('batch-concurrency-hint')).not.toBeInTheDocument();
    // 设置读取失败不阻塞弹窗（缺省上限 2，切换外派路由后提示仍按缺省口径在场）
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    await waitFor(() =>
      expect(screen.getByTestId('batch-concurrency-hint').textContent).toContain('2'),
    );
  });
});

// ═══ M3.3 `::` 依赖行语法：解析纯函数（无依赖行零变化锁）+ 批量/单任务提交链 ═══
describe('parseTaskLine 纯函数（M3.3 §2.2 行语法）', () => {
  it('无 `::` 后缀 → 整行 trim 为标题、dependsOn 空（零变化）', () => {
    expect(parseTaskLine('普通任务标题')).toEqual({ title: '普通任务标题', dependsOn: [] });
    expect(parseTaskLine('  带空白行  ')).toEqual({ title: '带空白行', dependsOn: [] });
  });

  it('标题含单个冒号（时间/URL）→ 不误切（零变化）', () => {
    expect(parseTaskLine('09:00 站会')).toEqual({ title: '09:00 站会', dependsOn: [] });
    expect(parseTaskLine('https://example.com')).toEqual({ title: 'https://example.com', dependsOn: [] });
  });

  it('`标题 :: T-1,T-2` → 拆标题 + 依赖列表', () => {
    expect(parseTaskLine('联调后端 :: T-1,T-2')).toEqual({ title: '联调后端', dependsOn: ['T-1', 'T-2'] });
  });

  it('分隔符两侧空格可省略；依赖列表空白容忍 + 尾逗号容忍', () => {
    expect(parseTaskLine('联调后端::T-1')).toEqual({ title: '联调后端', dependsOn: ['T-1'] });
    expect(parseTaskLine('联调后端 :: T-1, T-2 ,')).toEqual({ title: '联调后端', dependsOn: ['T-1', 'T-2'] });
  });

  it('标题内含 `::`（C++ 风格）→ 取末次分隔符，标题保完整', () => {
    expect(parseTaskLine('迁移 std::vector 用法 :: T-9')).toEqual({
      title: '迁移 std::vector 用法',
      dependsOn: ['T-9'],
    });
  });

  it('后缀非 T-id 形状 / 后缀为空 / 标题段为空 → 整行按无依赖处理（零变化）', () => {
    expect(parseTaskLine('备注 :: 张三负责')).toEqual({ title: '备注 :: 张三负责', dependsOn: [] });
    expect(parseTaskLine('备注 ::')).toEqual({ title: '备注 ::', dependsOn: [] });
    expect(parseTaskLine(':: T-1')).toEqual({ title: ':: T-1', dependsOn: [] });
  });
});

describe('CreateTaskDialog — `::` 依赖提交链（M3.3）', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockTaskCreateBatch.mockReset();
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue([]);
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    showToastMock.mockReset();
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null });
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null, currentWorkspaceId: null, pendingMoveCount: 0, dragging: false });
  });

  it('批量带依赖行 → 单次 createBatch：依赖行带 dependsOn，无依赖行不带该键（payload 零变化）', async () => {
    mockTaskCreateBatch.mockResolvedValue({
      results: [
        { ok: true, task: { id: 'T-1' } },
        { ok: true, task: { id: 'T-2' } },
        { ok: true, task: { id: 'T-3' } },
      ],
    });
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '采购物料\n组装零件 :: T-1\n质检出货 :: T-1,T-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 3 个任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreateBatch).toHaveBeenCalledWith({
      items: [
        { workspaceId: 'ws1', title: '采购物料' },
        { workspaceId: 'ws1', title: '组装零件', dependsOn: ['T-1'] },
        { workspaceId: 'ws1', title: '质检出货', dependsOn: ['T-1', 'T-2'] },
      ],
    });
  });

  it('批量部分失败（per-item）→ 成功行照常关窗回调 + 失败摘要 toast 含原始行文本', async () => {
    mockTaskCreateBatch.mockResolvedValue({
      results: [
        { ok: true, task: { id: 'T-1' } },
        { ok: false, index: 1, error: '依赖任务 T-999 不存在' },
        { ok: true, task: { id: 'T-3' } },
      ],
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '采购物料\n坏依赖行 :: T-999\n质检出货 :: T-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 3 个任务' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 部分成功：回调末次成功行；失败摘要沿用 toast（原始行含 :: 后缀原样展示）
    expect(onCreated).toHaveBeenCalledWith('T-3');
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('1 个任务创建失败'));
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('「坏依赖行 :: T-999」依赖任务 T-999 不存在'));
    // store 真实实现：仅 ok 行 append
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['T-1', 'T-3']);
  });

  it('整批 rejection（超 50 上限）→ 弹窗内错误呈现、不关窗不回调（错误路径）', async () => {
    mockTaskCreateBatch.mockRejectedValue(new Error('批量创建一次最多 50 条（收到 51 条）'));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateTaskDialog open onClose={onClose} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('radio', { name: '批量' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: Array.from({ length: 51 }, (_, i) => `行${i + 1}`).join('\n') },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 51 个任务' }));
    expect(await screen.findByText(/批量创建一次最多 50 条/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toHaveLength(0);
  });

  it('单任务标题带 `::` 后缀 → create 携带拆分标题 + dependsOn', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '部署上线 :: T-7,T-8' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: '部署上线', dependsOn: ['T-7', 'T-8'] }),
    );
  });

  it('单任务标题无后缀 → create payload 不含 dependsOn 键（零变化锁）', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '普通单任务' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const call = mockTaskCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.title).toBe('普通单任务');
    expect('dependsOn' in call).toBe(false);
  });

  // M3.3 锁死断言按 M4.3 语义升级（spec 2026-10-29 §2.3.2）：外派路径解析 `::`
  // （建链后 blocked 派生，dispatch 受主进程闸管制）——断言改动两处：
  //   ① 用例名「不解析」→「解析」；② title 期望 '远端行 :: T-1' → '远端行'
  //   + 新增 dependsOn 期望 ['T-1']（本地路径断言零变化——上方 local 用例不动）
  it('外派路径解析 `::`：批量 remote 行拆标题 + dependsOn 逐行提交（M4.3 语义升级）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '远端行 :: T-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 1 个任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: '远端行', dependsOn: ['T-1'] }),
    );
    expect(mockTaskCreateBatch).not.toHaveBeenCalled();
  });

  it('外派批量行无 `::` 后缀 → submitRoutedTask payload 不含 dependsOn 键（零变化锁）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/批量任务书/), {
      target: { value: '普通远端行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建 1 个任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    const call = mockSubmitRoutedTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.title).toBe('普通远端行');
    expect('dependsOn' in call).toBe(false);
  });

  it('外派单任务标题带 `::` 后缀 → submitRoutedTask 携带拆分标题 + dependsOn（M4.3）', async () => {
    const onCreated = vi.fn();
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '外派部署 :: T-7,T-8' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: '外派部署', dependsOn: ['T-7', 'T-8'] }),
    );
    expect(mockTaskCreate).not.toHaveBeenCalled();
  });

  it('外派单任务提交被拒（派发闸 blocked）→ rejection 不上抛，toast 人话回显（M4.3）', async () => {
    const onCreated = vi.fn();
    mockSubmitRoutedTask.mockReset().mockRejectedValueOnce(
      new Error('任务存在未完成依赖（T-7），依赖完成前不可派发'),
    ).mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '外派受阻 :: T-7' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(1));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringContaining('任务存在未完成依赖（T-7），依赖完成前不可派发'),
    );
    // 弹窗不关（行已建链保留待处理，用户可改行重试或去待派发卡重试）
    expect(onCreated).not.toHaveBeenCalled();
  });
});

// ═══ M5.3 X3：外派「执行方式」——团队协作 + 预检（spec §5.4/§5.5，预览定值清单为合同）═══
// Mock 口径：workspace.list / agent.listMembers 仿真真实 IPC 形状（Team / Workspace /
// WorkspaceAgentMember 全字段），listMembers 按 wsId 分流当前 ws 与镜像 ws。

// 常量机械锁（对齐 electron/tests/hub/protocol-pin.test.ts 做法）：renderer 双写的
// 协议门槛 minor 必须与协议包单源一致——漂移即红（黄字预检与提交闸口径不漂移的前提）
it('TEAM_DELEGATION_REQUIRED_MINOR 双写锚定协议包单源（momo-hub-protocol v0.5.0 = 9）', () => {
  expect(TEAM_DELEGATION_REQUIRED_MINOR).toBe(9);
});

function mkMember(instanceId: string, agentName: string, workspaceId = 'ws1'): WorkspaceAgentMember {
  return {
    instanceId,
    workspaceId,
    agentDefinitionId: `def-${agentName}`,
    agentUserId: `user-${agentName}`,
    agentName,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function mkTeam(): Team {
  return {
    id: 'team-t1',
    workspaceId: 'ws1',
    name: '研发突击队',
    iconEmoji: '',
    leaderInstanceId: 'inst-coder',
    members: [
      mkMember('inst-coder', 'coder'),
      mkMember('inst-tester', 'tester'),
      mkMember('inst-docs', 'docs-writer'),
    ],
    createdAt: '2026-10-30T00:00:00.000Z',
  };
}

function mkWorkspace(partial: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    description: '',
    directoryPath: '/tmp/mirror',
    gitInitialized: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ownerId: 'owner',
    iconEmoji: '',
    defaultAgentInstanceId: null,
    ...partial,
  };
}

describe('CreateTaskDialog — 外派团队执行（M5.3 X3）', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset().mockResolvedValue({ id: 'T-100' });
    mockTaskCreateBatch.mockReset().mockResolvedValue({ results: [{ ok: true, task: { id: 'T-100' } }] });
    mockListAssignments.mockReset().mockResolvedValue([]);
    mockTeamList.mockReset().mockResolvedValue([mkTeam()]);
    mockSessionList.mockReset().mockResolvedValue([]);
    mockTaskGroupList.mockReset().mockResolvedValue([]);
    mockRoutingPrecheck.mockReset().mockResolvedValue(precheckFixture());
    mockSubmitRoutedTask.mockReset().mockResolvedValue({ task: { id: 'T-rem' }, dispatched: true, nodeId: 'node-a' });
    // 默认无本地镜像（覆盖未知态）；用例按需覆写
    mockWorkspaceList.mockReset().mockResolvedValue([]);
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null });
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null, currentWorkspaceId: null, pendingMoveCount: 0, dragging: false });
  });

  /** 进入外派单任务 + 团队协作 + 选中夹具团队（组内调度口径） */
  async function openTeamGroupDialog(): Promise<void> {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    fireEvent.change(await screen.findByLabelText('团队'), { target: { value: 'team-t1' } });
  }

  /** 进入外派单任务 + 指定节点（node-a）+ 团队协作 + 选中夹具团队 */
  async function openTeamNodeDialog(): Promise<void> {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '指定节点' }));
    fireEvent.change(await screen.findByLabelText('目标成员'), { target: { value: 'node-a' } });
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    fireEvent.change(await screen.findByLabelText('团队'), { target: { value: 'team-t1' } });
  }

  it('X3-1. 外派默认单 agent：执行方式 seg 在场（单 agent 选中）+ hint；无团队下拉无预检注', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    expect(screen.getByRole('radiogroup', { name: '执行方式' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '单 agent' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '团队协作' })).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByText('任务落到目标节点后由单个 agent 处理（默认 agent，或按 agent 指定）'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('团队')).not.toBeInTheDocument();
    expect(screen.queryByText(/镜像/)).not.toBeInTheDocument();
  });

  it('X3-2a. 切团队协作：团队下拉在场 + leader chip 文案（leader 名经 leaderInstanceId 匹配）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    const sel = await screen.findByLabelText('团队');
    expect((sel as HTMLSelectElement).value).toBe('');
    await screen.findByRole('option', { name: '研发突击队' });
    fireEvent.change(sel, { target: { value: 'team-t1' } });
    expect(await screen.findByText('leader：coder · 提交时展开为成员名单快照')).toBeInTheDocument();
  });

  it('X3-2b. 团队列表为空 → option 暂无团队话术 + 标题已填仍不可提交', async () => {
    mockTeamList.mockResolvedValue([]);
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    const sel = (await screen.findByLabelText('团队')) as HTMLSelectElement;
    expect(sel.selectedOptions[0]?.textContent).toBe('暂无团队（≥2 成员的团队才可协作）');
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '想协作' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled();
  });

  it('X3-3a. 指定节点 × 镜像全覆盖 → 绿字 N 名成员；不拦提交', async () => {
    mockWorkspaceList.mockResolvedValue([mkWorkspace({ id: 'mirror-ws', name: 'dev-ws' })]);
    // 真实 IPC 恒返回 Promise（裸数组 .then 即崩——保真度口径）
    mockListAssignments.mockImplementation((wsId: string) =>
      Promise.resolve(
        wsId === 'mirror-ws'
          ? [
              mkMember('inst-coder', 'coder', 'mirror-ws'),
              mkMember('inst-tester', 'tester', 'mirror-ws'),
              mkMember('inst-docs', 'docs-writer', 'mirror-ws'),
            ]
          : [],
      ),
    );
    await openTeamNodeDialog();
    expect(await screen.findByText('✓ 3 名成员在目标节点镜像中全部可解析')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '团队外派' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled();
  });

  it('X3-3b. 指定节点 × 镜像缺 2 名成员 → 黄字含名单（不拦提交）', async () => {
    mockWorkspaceList.mockResolvedValue([mkWorkspace({ id: 'mirror-ws', name: 'dev-ws' })]);
    mockListAssignments.mockImplementation((wsId: string) =>
      Promise.resolve(wsId === 'mirror-ws' ? [mkMember('inst-coder', 'coder', 'mirror-ws')] : []),
    );
    await openTeamNodeDialog();
    expect(
      await screen.findByText(
        '目标节点镜像缺 2 名成员：tester、docs-writer——若对方本地也无这些 agent，任务将被拒收（保留待处理可重试）',
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '缺员外派' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled();
  });

  it('X3-3c. 指定节点 × 本地无同名镜像 → 黄字含空间名（覆盖未知态）', async () => {
    await openTeamNodeDialog();
    expect(
      await screen.findByText('本地无 dev-ws 镜像，无法预检成员覆盖——目标节点若未镜像将被拒收'),
    ).toBeInTheDocument();
  });

  it('X3-4a. 组内调度 × 落后节点 → 黄字含节点名与协议版本', async () => {
    mockRoutingPrecheck.mockResolvedValue(
      precheckFixture({
        nodeCaps: [
          { nodeId: 'node-a', name: 'office-mac', protoVer: '1.9.0' },
          { nodeId: 'node-b', name: 'lab-node', protoVer: '1.8.0' },
        ],
      }),
    );
    await openTeamGroupDialog();
    expect(
      await screen.findByText(
        '组内 1 个节点版本过旧（lab-node·协议 1.8.0），团队任务不会派给它；全员落后时提交将被拒',
      ),
    ).toBeInTheDocument();
  });

  it('X3-4b. nodeCaps 整体缺席（旧 hub/离线）→ 兜底黄字', async () => {
    await openTeamGroupDialog();
    expect(await screen.findByText('无法获取组内节点版本，若含旧节点任务将被拒')).toBeInTheDocument();
  });

  it('X3-4c. 组内全员达标 → 无黄字；绿字仅指定节点口径（组内不出绿字）', async () => {
    mockRoutingPrecheck.mockResolvedValue(
      precheckFixture({
        nodeCaps: [
          { nodeId: 'node-a', name: 'office-mac', protoVer: '1.9.0' },
          { nodeId: 'node-b', name: 'lab-node', protoVer: '1.9.1' },
        ],
      }),
    );
    await openTeamGroupDialog();
    // chip 在场 = 团队已选（预检计算已跑）后断言无注
    await screen.findByText('leader：coder · 提交时展开为成员名单快照');
    expect(screen.queryByText(/版本过旧/)).not.toBeInTheDocument();
    expect(screen.queryByText(/全部可解析/)).not.toBeInTheDocument();
  });

  it('X3-5a. 团队协作 + 已选团队 → submitRoutedTask 载荷带 teamId（routing/档位不变）', async () => {
    const onCreated = vi.fn();
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    fireEvent.change(await screen.findByLabelText('团队'), { target: { value: 'team-t1' } });
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '突击任务' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    expect(mockSubmitRoutedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '突击任务',
        teamId: 'team-t1',
        routing: { mode: 'group', groupId: 'g1' },
        permissionTier: 'confirm',
      }),
    );
    expect(onCreated).toHaveBeenCalledWith('T-rem');
  });

  it('X3-5b. 单 agent 默认 → submitRoutedTask payload 不含 teamId 键（零变化回归）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '单干任务' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    const call = mockSubmitRoutedTask.mock.calls[0]![0] as Record<string, unknown>;
    expect('teamId' in call).toBe(false);
  });

  it('X3-5c. 团队协作未选团队 → 按钮禁用，选中后恢复（targetMissing 口径并入）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '等选团队' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled();
    fireEvent.change(await screen.findByLabelText('团队'), { target: { value: 'team-t1' } });
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled();
  });

  it('X3-5d. 团队态切回单 agent → 团队下拉/预检区消失 + payload 不带 teamId', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    fireEvent.click(screen.getByRole('radio', { name: '团队协作' }));
    fireEvent.change(await screen.findByLabelText('团队'), { target: { value: 'team-t1' } });
    await screen.findByText('leader：coder · 提交时展开为成员名单快照');
    fireEvent.click(screen.getByRole('radio', { name: '单 agent' }));
    expect(screen.queryByLabelText('团队')).not.toBeInTheDocument();
    expect(screen.queryByText(/leader：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/版本过旧/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标题\*/), { target: { value: '切回单干' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mockSubmitRoutedTask).toHaveBeenCalledTimes(1));
    const call = mockSubmitRoutedTask.mock.calls[0]![0] as Record<string, unknown>;
    expect('teamId' in call).toBe(false);
  });

  it('X3-6. routing 指定↔组内切换 → 预检实时重算（覆盖绿字 ↔ 落后黄字）', async () => {
    mockRoutingPrecheck.mockResolvedValue(
      precheckFixture({
        nodeCaps: [
          { nodeId: 'node-a', name: 'office-mac', protoVer: '1.9.0' },
          { nodeId: 'node-b', name: 'lab-node', protoVer: '1.8.0' },
        ],
      }),
    );
    mockWorkspaceList.mockResolvedValue([mkWorkspace({ id: 'mirror-ws', name: 'dev-ws' })]);
    mockListAssignments.mockImplementation((wsId: string) =>
      Promise.resolve(
        wsId === 'mirror-ws'
          ? [
              mkMember('inst-coder', 'coder', 'mirror-ws'),
              mkMember('inst-tester', 'tester', 'mirror-ws'),
              mkMember('inst-docs', 'docs-writer', 'mirror-ws'),
            ]
          : [],
      ),
    );
    await openTeamNodeDialog();
    expect(await screen.findByText('✓ 3 名成员在目标节点镜像中全部可解析')).toBeInTheDocument();
    // 切组内调度：同一团队态换版本口径预检（绿字退场，落后黄字进场）
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    expect(
      await screen.findByText(
        '组内 1 个节点版本过旧（lab-node·协议 1.8.0），团队任务不会派给它；全员落后时提交将被拒',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/全部可解析/)).not.toBeInTheDocument();
  });

  it('X3-7. 批量模式不渲染执行方式区（现状不变）', async () => {
    render(
      <CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" workspaceName="dev-ws" />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: '批量' }));
    fireEvent.click(await screen.findByRole('radio', { name: '组内调度' }));
    expect(screen.queryByRole('radiogroup', { name: '执行方式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '单 agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '团队协作' })).not.toBeInTheDocument();
  });
});
