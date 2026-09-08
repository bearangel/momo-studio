// renderer/src/components/files/FileTree.test.tsx
// FileTree 工具栏：新建按钮根据 selectedDir 拼路径 + activeView 切换触发刷新。
// store 已在 Task 1 测过；本测试聚焦工具栏与 store 的集成。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
    searchNames: vi.fn().mockResolvedValue([]),
  },
};

// 完整字段匹配 Workspace 接口（types.d.ts）
const buildWorkspace = (id: string, name: string): Workspace => ({
  id,
  name,
  description: '',
  directoryPath: `/tmp/${name}`,
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ownerId: '@user:localhost',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
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
  mockApi.file.searchNames.mockClear();
  mockApi.file.searchNames.mockResolvedValue([]);
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

describe('FileTree 文件名搜索', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('输入关键词 → 防抖 200ms 后调 file.searchNames 并渲染结果（含父目录小字）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'src/found.ts', isDirectory: false }]);
    render(<FileTree onSelectFile={() => {}} />);
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'found' } });
    // 防抖窗口内不发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', 'found');
    expect(screen.getByText('found.ts')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('无结果 → 「无匹配文件」空态', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([]);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('无匹配文件')).toBeInTheDocument();
  });

  it('点击文件行 → onSelectFile(相对路径)；目录行不可点击', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'docs', isDirectory: true },
      { path: 'src/found.ts', isDirectory: false },
    ]);
    const onSelect = vi.fn();
    render(<FileTree onSelectFile={onSelect} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'found' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(screen.getByText('found.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/found.ts');
    expect(onSelect).not.toHaveBeenCalledWith('docs');
  });

  it('清除搜索 → 恢复树视图（搜索结果消失、不再发 IPC）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'search-hit.ts', isDirectory: false }]);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'hit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('search-hit.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('清除搜索'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('search-hit.ts')).not.toBeInTheDocument();
    expect(mockApi.file.searchNames).toHaveBeenCalledTimes(1);
  });

  it('搜索失败 → 错误文案（text-status-error 行）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockRejectedValue(new Error('boom'));
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'x' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('搜索失败：boom')).toBeInTheDocument();
  });

  it('旧响应不覆盖新结果（竞态守卫）', async () => {
    vi.useFakeTimers();
    let resolveStale!: (v: { path: string; isDirectory: boolean }[]) => void;
    const stalePromise = new Promise<{ path: string; isDirectory: boolean }[]>((res) => {
      resolveStale = res;
    });
    mockApi.file.searchNames
      .mockImplementationOnce(() => stalePromise)
      .mockImplementationOnce(() => Promise.resolve([{ path: 'fresh.ts', isDirectory: false }]));
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'q1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'q2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 旧响应后到：不得覆盖 q2 的结果
    resolveStale([{ path: 'stale.ts', isDirectory: false }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('stale.ts')).not.toBeInTheDocument();
    expect(screen.getByText('fresh.ts')).toBeInTheDocument();
  });

  it('结果达 200 条上限 → 显示截断提示', async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 200 }, (_, i) => ({
      path: `hit${i}.ts`,
      isDirectory: false,
    }));
    mockApi.file.searchNames.mockResolvedValue(many);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'hit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('已显示前 200 条匹配')).toBeInTheDocument();
  });

  it('切换 workspace 时清空搜索（spec §6）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'search-hit.ts', isDirectory: false }]);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'hit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('search-hit.ts')).toBeInTheDocument();
    // 切 workspace：真实 store setState 触发订阅重渲染
    useWorkspaceStore.setState({
      workspaces: [buildWorkspace('ws-2', 'ws-2')],
      activeWorkspaceId: 'ws-2',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('search-hit.ts')).not.toBeInTheDocument();
  });
});
