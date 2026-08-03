// renderer/src/components/files/FileTree.test.tsx
// FileTree 工具栏：新建按钮根据 selectedDir 拼路径 + activeView 切换触发刷新。
// store 已在 Task 1 测过；本测试聚焦工具栏与 store 的集成。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from './FileTree';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';
import type { DirEntry, Workspace } from '../../ipc/types';

const ROOT_ENTRIES: DirEntry[] = [
  { name: 'a.ts', isDirectory: false, size: 0 },
];

const mockApi = {
  file: {
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(ROOT_ENTRIES),
    read: vi.fn(),
    write: vi.fn(),
  },
};

// 完整字段匹配 Workspace 接口（types.d.ts）
const buildWorkspace = (id: string, name: string): Workspace => ({
  id,
  name,
  description: '',
  directoryPath: `/tmp/${name}`,
  matrixSpaceId: `!space:${id}`,
  teamRoomId: `!team:${id}`,
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ownerId: '@user:localhost',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
});

beforeEach(() => {
  // 仅设置 api，不替换整个 window（保留 jsdom Window 的其它属性与方法，避免破坏 react-dom）
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  localStorage.clear();
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
    selectedDir: '.',
    error: null,
    // 预置 workspaceId='ws-1' 使 FileTree 挂载时 initWorkspace('ws-1') 早返回，
    // 不会覆盖 beforeEach 之外用 setState 写入的 selectedDir（needed by tests 2/3）
    workspaceId: 'ws-1',
  });
  useWorkspaceStore.setState({
    workspaces: [buildWorkspace('ws-1', 'ws')],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });
  useUiStore.setState({ activeView: 'im' });
  mockApi.file.create.mockClear();
  mockApi.file.list.mockClear();
  mockApi.file.list.mockResolvedValue(ROOT_ENTRIES);
});

describe('FileTree 工具栏 selectedDir 集成', () => {
  it('selectedDir="." 时工具栏新建文件调 createPath 传裸文件名', async () => {
    render(<FileTree onSelectFile={() => {}} />);
    // 点新建文件按钮
    const newFileBtn = screen.getByTitle('新建文件');
    fireEvent.click(newFileBtn);
    // PromptDialog 输入
    const input = await screen.findByPlaceholderText(/可含子目录/);
    fireEvent.change(input, { target: { value: 'foo.ts' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'foo.ts', 'file');
    });
  });

  it('selectedDir="src" 时工具栏新建文件调 createPath 传 src/foo.ts', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    render(<FileTree onSelectFile={() => {}} />);
    const newFileBtn = screen.getByTitle('新建文件（到 src）');
    fireEvent.click(newFileBtn);
    const input = await screen.findByPlaceholderText(/可含子目录/);
    fireEvent.change(input, { target: { value: 'foo.ts' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'src/foo.ts', 'file');
    });
  });

  it('selectedDir 变化时工具栏 tooltip 更新', () => {
    useFileStore.setState({ selectedDir: 'src' });
    render(<FileTree onSelectFile={() => {}} />);
    expect(screen.getByTitle('新建文件（到 src）')).toBeInTheDocument();
    expect(screen.getByTitle('新建文件夹（到 src）')).toBeInTheDocument();
  });
});

describe('FileTree activeView 刷新触发', () => {
  it('从 im 切到 files 时触发 refreshAllCached', async () => {
    // 预置一个已缓存目录
    useFileStore.setState({ tree: new Map([['.', ROOT_ENTRIES]]) });
    useUiStore.setState({ activeView: 'im' });
    render(<FileTree onSelectFile={() => {}} />);
    expect(mockApi.file.list).not.toHaveBeenCalled();
    // 切到 files
    useUiStore.setState({ activeView: 'files' });
    await waitFor(() => {
      expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
    });
  });

  it('已在 files 视图时 activeView 不变不重复触发', async () => {
    useFileStore.setState({ tree: new Map([['.', ROOT_ENTRIES]]) });
    useUiStore.setState({ activeView: 'files' });
    render(<FileTree onSelectFile={() => {}} />);
    // 初次渲染触发一次
    await waitFor(() => {
      expect(mockApi.file.list).toHaveBeenCalledTimes(1);
    });
    // 同值 setState 不应再触发（useEffect 依赖未变）
    useUiStore.setState({ activeView: 'files' });
    expect(mockApi.file.list).toHaveBeenCalledTimes(1);
  });
});
