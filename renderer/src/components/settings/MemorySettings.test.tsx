// renderer/src/components/settings/MemorySettings.test.tsx
//
// 记忆管理页行为测试（v2.2 P1）：
//   - 列表渲染 + memory.list 入参（scope 随 tab 切换）
//   - 置顶切换调用 memory.update（pinned 取反）
//   - 编辑弹窗保存调用 memory.update（content 更新）
//   - 删除有二次确认，确认后调用 memory.delete
//   - 总开关关闭调用 settings.updateGlobal({ memoryEnabled: false })
//
// Mock 策略（momo-test-rules）：只桩 window.api IPC 边界（memory + settings 命名空间），
// 组件经 ipc client 代理消费；断言生产真实入参（filter 位省略即单参调用）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemorySettings } from './MemorySettings';

const listMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const getGlobalMock = vi.fn();
const updateGlobalMock = vi.fn();

// 桩 window.api（memory + settings 命名空间；组件经 ipc client 运行时读取）
const mockApi = {
  memory: {
    list: listMock,
    save: vi.fn(),
    update: updateMock,
    delete: deleteMock,
    search: vi.fn(),
  },
  settings: {
    getGlobal: getGlobalMock,
    updateGlobal: updateGlobalMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const wsEntry = {
  id: 'w1', scope: 'workspace' as const, workspaceId: 'ws1', sessionId: null,
  kind: 'rule' as const, pinned: true, content: 'pnpm 研发规范', tags: [], source: 'user' as const,
  sourceDetail: null, confidence: 1, useCount: 0, lastUsedAt: null, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  getGlobalMock.mockResolvedValue({ memoryEnabled: true });
  listMock.mockResolvedValue([wsEntry]);
});

describe('MemorySettings', () => {
  it('默认 workspace 层：列表渲染 + list 参数正确', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(listMock).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'ws1' });
  });

  it('切到全局层：list 参数切换', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '全局' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ kind: 'global' }));
  });

  it('置顶切换调用 update（pinned 取反）', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('w1', { pinned: false }));
  });

  it('编辑弹窗保存调用 update（content 更新）', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const input = await screen.findByLabelText('记忆内容');
    fireEvent.change(input, { target: { value: 'pnpm 研发规范 v2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('w1', { content: 'pnpm 研发规范 v2' }));
  });

  it('删除有确认，确认后调用 delete', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText(/确定删除这条记忆/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('w1'));
  });

  it('总开关关闭调用 updateGlobal memoryEnabled=false', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '记忆总开关' }));
    await waitFor(() => expect(updateGlobalMock).toHaveBeenCalledWith({ memoryEnabled: false }));
  });
});
