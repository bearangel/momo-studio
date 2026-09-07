// renderer/src/components/im/CreateTaskDialog.test.tsx
//
// CreateTaskDialog 行为测试（B 子系统 B7 + v29 目标三选/循环预设）：
//   1. open=false 时不渲染任何 DOM
//   2. open=true 时渲染表单核心字段（标题 / 描述 / 优先级）
//   3. preset 字段预填到表单（标题 / 描述）
//   4. 标题为空时禁用创建按钮
//   5. 提交成功后调 onCreated(taskId) + onClose（none 默认路径回归锁）
//   6. 选团队目标 → create 携带 targetTeamId（v29）
//   7. 选循环每天 09:00 → create 携带 recurrenceRule=daily@09:00（v29）
//   8. 团队目标未选时禁用创建按钮，选中后恢复（v29 校验路径）
//
// Mock 策略：mock ../../ipc/client（IPC 进程边界，业务逻辑 serializeRecurrence
// 走真实实现），agent.listMembers / team.list / session.list / task.create
// 均为 vi.fn()，返回形状与 types.d.ts 契约对齐。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateTaskDialog } from './CreateTaskDialog';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
const { mockTaskCreate, mockListAssignments, mockTeamList, mockSessionList } = vi.hoisted(() => ({
  mockTaskCreate: vi.fn(),
  mockListAssignments: vi.fn(),
  mockTeamList: vi.fn(),
  mockSessionList: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    task: { create: mockTaskCreate },
    agent: { listMembers: mockListAssignments },
    team: { list: mockTeamList },
    session: { list: mockSessionList },
  },
}));

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset();
    mockListAssignments.mockReset();
    mockTeamList.mockReset();
    mockSessionList.mockReset();
    // 默认：创建成功返回 { id: 'T-100' }；指派/团队/会话列表
    // （形状与 Team / SessionSummary 契约的字段子集对齐，map 只消费 id/name/title）
    mockTaskCreate.mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockResolvedValue([]);
    mockTeamList.mockResolvedValue([{ id: 'team1', name: '写码组', members: [] }]);
    mockSessionList.mockResolvedValue([{ id: 'sess1', title: '既有会话' }]);
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
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
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
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRule: 'daily@09:00' }),
    );
  });

  it('团队目标未选时禁用创建按钮，选中后恢复', async () => {
    render(<CreateTaskDialog open onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '等团队' } });
    // none 默认路径：标题已填 → 按钮可用
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
    // 切到团队但未选具体团队 → 禁用
    fireEvent.change(screen.getByLabelText('委派目标类型'), { target: { value: 'team' } });
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    // 选中团队后恢复可用
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'team1' } });
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });
});
