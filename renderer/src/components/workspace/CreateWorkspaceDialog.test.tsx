// renderer/src/components/workspace/CreateWorkspaceDialog.test.tsx
// 新建工作空间对话框：「选择目录」按钮触发 IPC 并回填路径；标题中文化。
//
// IPC 约定：通过 globalThis.window.api 提供桩（与 AddAgentDialog 测试一致）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';

const pickDirectory = vi.fn();
const createWs = vi.fn();

const mockApi = {
  dialog: { pickDirectory },
  workspace: { create: createWs },
};

beforeEach(() => {
  pickDirectory.mockReset();
  createWs.mockReset();
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    loading: false,
    error: null,
    load: vi.fn(),
    create: async (input) => {
      await createWs(input);
    },
    select: vi.fn(),
    getActive: () => null,
    setCoordinator: vi.fn(),
  });
  // 沿用 AddAgentDialog 测试约定：只设置 api，不替换整个 window
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('CreateWorkspaceDialog', () => {
  it('标题显示中文「新建工作空间」', () => {
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    expect(screen.getByText('新建工作空间')).toBeTruthy();
  });

  it('点击「选择目录」触发 dialog.pickDirectory 并回填路径', async () => {
    pickDirectory.mockResolvedValue('/home/user/projects/my-app');
    render(<CreateWorkspaceDialog onClose={() => {}} />);

    fireEvent.click(screen.getByText('选择目录'));

    await waitFor(() => {
      expect(pickDirectory).toHaveBeenCalledWith({ title: '选择工作空间目录' });
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        '点击右侧按钮选择目录',
      ) as HTMLInputElement;
      expect(input.value).toBe('/home/user/projects/my-app');
    });
  });

  it('用户取消选择目录时不回填', async () => {
    pickDirectory.mockResolvedValue(null);
    render(<CreateWorkspaceDialog onClose={() => {}} />);

    fireEvent.click(screen.getByText('选择目录'));

    await waitFor(() => {
      expect(pickDirectory).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(
      '点击右侧按钮选择目录',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('提交时调用 store.create 传入所选路径', async () => {
    pickDirectory.mockResolvedValue('/tmp/proj');
    createWs.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<CreateWorkspaceDialog onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '测试项目' },
    });
    fireEvent.click(screen.getByText('选择目录'));

    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        '点击右侧按钮选择目录',
      ) as HTMLInputElement;
      expect(input.value).toBe('/tmp/proj');
    });

    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createWs).toHaveBeenCalledWith({
        name: '测试项目',
        directoryPath: '/tmp/proj',
      });
      expect(onClose).toHaveBeenCalled();
    });
  });
});
