// renderer/src/components/im/ConflictDialog.test.tsx
//
// ConflictDialog 行为测试（B 子系统 B9）：
//   1. open=false 时不渲染
//   2. open=true 时渲染 4 个选项按钮（排队/抢占/分流/取消）+ 任务 id 文案
//   3. 点击"排队"按钮 → 调 ipc.task.resolveConflict({strategy:'queue'}) + onResolved('queue') + onClose
//   4. 勾选"本会话记住" → 提交时额外调 ipc.settings.updateSession 写 conflictStrategy
//   5. 点击 backdrop（遮罩）关闭弹窗
//
// Mock 策略：mock ../../ipc/client，让 ipc.task.resolveConflict / ipc.settings.updateSession
// 都是 vi.fn() 以断言调用参数。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConflictDialog } from './ConflictDialog';

const { mockResolveConflict, mockUpdateRoom } = vi.hoisted(() => ({
  mockResolveConflict: vi.fn(),
  mockUpdateRoom: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    task: { resolveConflict: mockResolveConflict },
    settings: { updateSession: mockUpdateRoom },
  },
}));

describe('ConflictDialog', () => {
  beforeEach(() => {
    mockResolveConflict.mockReset();
    mockUpdateRoom.mockReset();
    mockResolveConflict.mockResolvedValue(undefined);
    mockUpdateRoom.mockResolvedValue(undefined);
  });

  it('open=false 时不渲染', () => {
    const { container } = render(
      <ConflictDialog
        open={false}
        newTaskId="T-002"
        currentTaskId="T-001"
        currentRoomId="!room:home"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('open=true 时渲染 4 个选项 + 任务 id 文案', () => {
    render(
      <ConflictDialog
        open={true}
        newTaskId="T-002"
        currentTaskId="T-001"
        currentRoomId="!room:home"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.getAllByText(/#T-001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#T-002/).length).toBeGreaterThan(0);
    // 4 个选项按钮（按 accessible name 匹配——文案含中文关键词）
    expect(screen.getByRole('button', { name: /排队/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /抢占/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /分流/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument();
  });

  it('点击"排队"按钮 → 调 resolveConflict({strategy:"queue"}) + onResolved + onClose', async () => {
    const onResolved = vi.fn();
    const onClose = vi.fn();
    render(
      <ConflictDialog
        open={true}
        newTaskId="T-002"
        currentTaskId="T-001"
        currentRoomId="!room:home"
        onClose={onClose}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /排队/ }));
    await waitFor(() => {
      expect(mockResolveConflict).toHaveBeenCalledWith({
        newTaskId: 'T-002',
        currentTaskId: 'T-001',
        currentRoomId: '!room:home',
        strategy: 'queue',
      });
      expect(onResolved).toHaveBeenCalledWith('queue');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('勾选"本会话记住" → 提交时额外调 ipc.settings.updateSession', async () => {
    render(
      <ConflictDialog
        open={true}
        newTaskId="T-002"
        currentTaskId="T-001"
        currentRoomId="!room:home"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    // 勾选"本会话记住"复选框
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    // 提交"抢占"
    fireEvent.click(screen.getByRole('button', { name: /抢占/ }));
    await waitFor(() => {
      // settings.updateSession 应被调用，patch 包含 conflictStrategy: 'preempt'
      expect(mockUpdateRoom).toHaveBeenCalledWith('!room:home', { conflictStrategy: 'preempt' });
      expect(mockResolveConflict).toHaveBeenCalled();
    });
  });

  it('点击 backdrop（蒙层）→ 触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <ConflictDialog
        open={true}
        newTaskId="T-002"
        currentTaskId="T-001"
        currentRoomId="!room:home"
        onClose={onClose}
        onResolved={() => {}}
      />,
    );
    // Dialog 用 portal 渲染，遮罩是 role=dialog 元素的前一个兄弟节点
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.previousElementSibling;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });
});
