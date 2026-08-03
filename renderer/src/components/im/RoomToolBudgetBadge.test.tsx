// renderer/src/components/im/RoomToolBudgetBadge.test.tsx
//
// RoomToolBudgetBadge 行为测试：
//   - 徽标显示有效工具上限（继承全局 → 显示全局默认值）
//   - 房间级覆盖时显示房间值
//   - 特殊值显示：-1 → ∞，0 → 禁用
//   - 点击徽标打开 popup，包含 4 个选项
//   - 保存调用 ipc.settings.updateRoom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoomToolBudgetBadge } from './RoomToolBudgetBadge';

const getRoomMock = vi.fn();
const updateRoomMock = vi.fn();
const getGlobalMock = vi.fn();

const mockApi = {
  settings: {
    getRoom: getRoomMock,
    updateRoom: updateRoomMock,
    getGlobal: getGlobalMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

describe('RoomToolBudgetBadge', () => {
  beforeEach(() => {
    getRoomMock.mockReset();
    updateRoomMock.mockReset();
    getGlobalMock.mockReset();
    getGlobalMock.mockResolvedValue({ maxToolCalls: 10 });
  });

  it('继承全局时显示全局默认值 (10次)', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: null });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => {
      expect(screen.getByText('10次')).toBeInTheDocument();
    });
  });

  it('房间级覆盖 (20) 时显示 20次', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: 20 });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => {
      expect(screen.getByText('20次')).toBeInTheDocument();
    });
  });

  it('有效值 -1 显示 ∞', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: -1 });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => {
      expect(screen.getByText('∞')).toBeInTheDocument();
    });
  });

  it('有效值 0 显示 禁用', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: 0 });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => {
      expect(screen.getByText('禁用')).toBeInTheDocument();
    });
  });

  it('点击徽标打开 popup，含 4 个选项', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: null });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => expect(screen.getByText('10次')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('工具调用上限'));
    expect(screen.getByText(/继承全局/)).toBeInTheDocument();
    expect(screen.getByText('禁用工具 (0)')).toBeInTheDocument();
    expect(screen.getByText('无限制 (∞)')).toBeInTheDocument();
    expect(screen.getByText('自定义：')).toBeInTheDocument();
  });

  it('选择"禁用工具"并保存，调用 updateRoom({ maxToolCalls: 0 })', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: null });
    updateRoomMock.mockResolvedValue({ maxToolCalls: 0 });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => expect(screen.getByText('10次')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('工具调用上限'));
    fireEvent.click(screen.getByText('禁用工具 (0)'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      expect(updateRoomMock).toHaveBeenCalledWith('!room:server', { maxToolCalls: 0 });
    });
  });

  it('选择"继承全局"并保存，调用 updateRoom({ maxToolCalls: null })', async () => {
    // 房间当前为 20（覆盖），切回继承全局
    getRoomMock.mockResolvedValue({ maxToolCalls: 20 });
    updateRoomMock.mockResolvedValue({ maxToolCalls: null });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => expect(screen.getByText('20次')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('工具调用上限'));
    // popup 打开后，初始 draftChoice 应为 custom（因 roomValue=20）
    fireEvent.click(screen.getByText(/继承全局/));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      expect(updateRoomMock).toHaveBeenCalledWith('!room:server', { maxToolCalls: null });
    });
  });

  it('点击 backdrop 关闭 popup（不保存）', async () => {
    getRoomMock.mockResolvedValue({ maxToolCalls: null });
    render(<RoomToolBudgetBadge roomId="!room:server" />);
    await waitFor(() => expect(screen.getByText('10次')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('工具调用上限'));
    expect(screen.getByText('无限制 (∞)')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('badge-backdrop'));
    expect(screen.queryByText('无限制 (∞)')).not.toBeInTheDocument();
    expect(updateRoomMock).not.toHaveBeenCalled();
  });
});
