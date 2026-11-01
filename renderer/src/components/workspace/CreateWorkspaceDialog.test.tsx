// renderer/src/components/workspace/CreateWorkspaceDialog.test.tsx
// 新建工作空间对话框：「选择目录」按钮触发 IPC 并回填路径；标题中文化。
//
// IPC 约定：通过 globalThis.window.api 提供桩（与 AddAgentDialog 测试一致）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as ToastMod from '../ui/Toast';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';

const showToastSpy = vi.spyOn(ToastMod, 'showToast');
import { useWorkspaceStore } from '../../stores/workspace.store';

const pickDirectory = vi.fn();
const createWs = vi.fn();
const getWorkspaceDirSettings = vi.fn();
const probePath = vi.fn();

const mockApi = {
  dialog: { pickDirectory },
  workspace: { create: createWs, probePath },
  hub: { getWorkspaceDirSettings },
};



beforeEach(() => {
  pickDirectory.mockReset();
  createWs.mockReset();
  // 默认桩：工作目录视图（默认根）——与主进程 store.view 契约一致
  getWorkspaceDirSettings.mockReset();
  getWorkspaceDirSettings.mockResolvedValue({
    rootDir: null,
    defaultRootDir: '/data/workspaces',
    effectiveRootDir: '/data/workspaces',
  });
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    loading: false,
    error: null,
    load: vi.fn(),
    create: async (input) => createWs(input), // D7：返回 createWs 结果（真 store.create 返回 Workspace——旧桩吞返回值）,
    select: vi.fn(),
    getActive: () => null,
  });
  // 沿用 AddAgentDialog 测试约定：只设置 api，不替换整个 window
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  // D7 默认桩：目录已存在（既有用例不触发确认弹层，行为不变）
  probePath.mockReset().mockImplementation(async (dir: string) => ({
    exists: true,
    resolvedPath: dir,
    hasGit: false,
  }));
});

describe('CreateWorkspaceDialog', () => {
  it('标题显示中文「新建工作空间」', () => {
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    expect(screen.getByText('新建工作空间')).toBeTruthy();
  });

  it('目录输入框 placeholder 提示可手输路径（D4 回归）', () => {
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    expect(screen.getByPlaceholderText('选择或输入目录路径')).toBeTruthy();
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
        '选择或输入目录路径',
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
      '选择或输入目录路径',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('提交时调用 store.create 传入所选路径', async () => {
    pickDirectory.mockResolvedValue('/tmp/proj');
    // D7 后组件读返回值（gitInitialized）——mock 保真：返回 Workspace 形状
    createWs.mockResolvedValue({ id: 'w-test', gitInitialized: true });
    const onClose = vi.fn();
    render(<CreateWorkspaceDialog onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '测试项目' },
    });
    fireEvent.click(screen.getByText('选择目录'));

    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        '选择或输入目录路径',
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

  it('工作目录预填：输入名称 → 目录框实时预填 <effectiveRoot>/<名称清洗>', async () => {
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '我的 项目!' },
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText('选择或输入目录路径') as HTMLInputElement;
      expect(input.value).toBe('/data/workspaces/我的-项目');
    });
    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '改个项目' },
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText('选择或输入目录路径') as HTMLInputElement;
      expect(input.value).toBe('/data/workspaces/改个项目');
    });
  });

  it('工作目录预填使用自定义根（effectiveRootDir 跟随配置）', async () => {
    getWorkspaceDirSettings.mockResolvedValue({
      rootDir: '/mnt/big',
      defaultRootDir: '/data/workspaces',
      effectiveRootDir: '/mnt/big',
    });
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: 'proj' },
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText('选择或输入目录路径') as HTMLInputElement;
      expect(input.value).toBe('/mnt/big/proj');
    });
  });

  it('用户手改目录框后停止跟随名称；选择器回填同样停止', async () => {
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    const nameInput = screen.getByPlaceholderText('我的项目');
    fireEvent.change(nameInput, { target: { value: '项目甲' } });
    const dirInput = () => screen.getByPlaceholderText('选择或输入目录路径') as HTMLInputElement;
    await waitFor(() => expect(dirInput().value).toBe('/data/workspaces/项目甲'));

    fireEvent.change(dirInput(), { target: { value: '/手选/位置' } });
    fireEvent.change(nameInput, { target: { value: '项目乙' } });
    expect(dirInput().value).toBe('/手选/位置'); // 不再跟随

    pickDirectory.mockResolvedValue('/选择器/位置');
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() => expect(dirInput().value).toBe('/选择器/位置'));
    fireEvent.change(nameInput, { target: { value: '项目丙' } });
    expect(dirInput().value).toBe('/选择器/位置'); // 选择器回填后同样冻结
  });

  it('设置读取失败不阻断表单（预填静默缺席，手选路径照常）', async () => {
    getWorkspaceDirSettings.mockRejectedValue(new Error('db busy'));
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '离线项目' },
    });
    const input = screen.getByPlaceholderText('选择或输入目录路径') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});

// === D7（验收报告 2026-10-31）：目录不存在确认弹层（预览合同 pkg3-workspace-path-confirm）===
describe('D7 目录不存在确认弹层', () => {
  async function fillAndSubmit(): Promise<void> {
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '星陨谷' } });
    fireEvent.change(screen.getByPlaceholderText('选择或输入目录路径'), { target: { value: '/tmp/typo-not-exist' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
  }

  it('分支①：probe 不存在 → 确认弹层（resolve 绝对路径 + git init 披露）→ 取消 → 零 create', async () => {
    probePath.mockResolvedValue({ exists: false, resolvedPath: '/Users/dev/qa-rpg-typo', hasGit: false });
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    await fillAndSubmit();
    const confirmDialog = await screen.findByRole('dialog', { name: '确认创建目录' });
    expect(confirmDialog).toBeTruthy();
    expect(screen.getByText('/Users/dev/qa-rpg-typo')).toBeTruthy();
    expect(screen.getByText(/git init/)).toBeTruthy();
    // 主对话框也有「取消」——within 作用域取确认层的
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认创建目录' })).not.toBeTruthy(),
    );
    expect(createWs).not.toHaveBeenCalled();
  });

  it('分支②：确认 → create；gitInitialized=false → toast 告知', async () => {
    showToastSpy.mockClear();
    probePath.mockResolvedValue({ exists: false, resolvedPath: '/x/y', hasGit: false });
    createWs.mockResolvedValue({ id: 'w1', gitInitialized: false });
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    await fillAndSubmit();
    fireEvent.click(await screen.findByRole('button', { name: /创建目录并初始化/ }));
    await waitFor(() => expect(createWs).toHaveBeenCalled());
    await waitFor(() => expect(showToastSpy).toHaveBeenCalledWith(expect.stringContaining('git 初始化失败')));
  });

  it('分支③：probe 已存在 → 无确认直建（现状不回归）', async () => {
    createWs.mockResolvedValue({ id: 'w2', gitInitialized: true });
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    await fillAndSubmit();
    await waitFor(() => expect(createWs).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: '确认创建目录' })).not.toBeTruthy();
  });

  it('错误友好化：EACCES → 无写入权限人话（剥 IPC 前缀）', async () => {
    createWs.mockRejectedValue(
      new Error("Error invoking remote method 'workspace:create': EACCES: permission denied, mkdir '/usr/x'"),
    );
    render(<CreateWorkspaceDialog onClose={() => {}} />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText(/无写入权限/)).toBeTruthy());
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeTruthy();
  });
});
