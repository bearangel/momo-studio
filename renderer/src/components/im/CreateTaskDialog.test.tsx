// renderer/src/components/im/CreateTaskDialog.test.tsx
//
// CreateTaskDialog 行为测试（B 子系统 B7）：
//   1. open=false 时不渲染任何 DOM
//   2. open=true 时渲染表单核心字段（标题 / 描述 / 优先级）
//   3. preset 字段预填到表单（标题 / 描述）
//   4. 标题为空时禁用创建按钮
//   5. 提交成功后调 onCreated(taskId) + onClose
//
// Mock 策略：mock ../../ipc/client，让 ipc.task.create 返回 { id: 'T-100' }，
// ipc.agent.listAssignments 返回空数组（指派 select 渲染空）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateTaskDialog } from './CreateTaskDialog';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
const { mockTaskCreate, mockListAssignments } = vi.hoisted(() => ({
  mockTaskCreate: vi.fn(),
  mockListAssignments: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    task: { create: mockTaskCreate },
    agent: { listAssignments: mockListAssignments },
  },
}));

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    mockTaskCreate.mockReset();
    mockListAssignments.mockReset();
    // 默认：创建成功返回 { id: 'T-100' }；指派列表空
    mockTaskCreate.mockResolvedValue({ id: 'T-100' });
    mockListAssignments.mockResolvedValue([]);
  });

  it('open=false 时不渲染', () => {
    const { container } = render(
      <CreateTaskDialog open={false} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('open=true 时渲染表单（标题/描述/优先级）', () => {
    render(
      <CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />,
    );
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
    render(
      <CreateTaskDialog open={true} onClose={() => {}} onCreated={() => {}} workspaceId="ws1" />,
    );
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
});
