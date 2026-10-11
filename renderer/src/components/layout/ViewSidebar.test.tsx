// renderer/src/components/layout/ViewSidebar.test.tsx
//
// 统一侧边栏测试（P2 Task 3 / v2.2 Task 3）：
// - 按 activeView 分发内容：im→RoomList / files→FileTree / tasks→TaskSidebarPanel
// - agents / marketplace / settings → 渲染 null（主区全宽，无侧边栏）
// - 收起态 = 完全消失（return null，不再渲染 48px 图标轨）且按视图独立（v2.2 优化）
// - 宽度按视图独立从 ui.store.sidebarWidths 透传到 Sidebar
//
// RoomList / FileTree / TaskSidebarPanel 用轻量桩替代——本文件聚焦分发与折叠逻辑，
// 子组件自身行为由各自测试覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ViewSidebar } from './ViewSidebar';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import type { Workspace } from '../../ipc/types';

vi.mock('../im/RoomList', () => ({
  RoomList: () => <div data-testid="room-list-stub" />,
}));
vi.mock('../im/SessionSidebarHeader', () => ({
  SessionSidebarHeader: () => <div data-testid="session-entry-stub" />,
}));
vi.mock('../files/FileTree', () => ({
  FileTree: ({ onSelectFile }: { onSelectFile: (p: string) => void }) => (
    <div data-testid="file-tree-stub" onClick={() => onSelectFile('a.ts')} />
  ),
}));
vi.mock('../task-board/TaskSidebarPanel', () => ({
  TaskSidebarPanel: () => <div data-testid="task-sidebar-stub" />,
}));

describe('ViewSidebar', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeView: 'im',
      sidebarCollapsed: { im: false, files: false, tasks: false },
      sidebarWidths: { im: 260, files: 260, tasks: 260 },
    });
  });

  it('im 视图渲染 RoomList 内容（展开 260px）', () => {
    render(<ViewSidebar />);
    expect(screen.getByTestId('room-list-stub')).toBeInTheDocument();
    const sidebar = screen.getByTestId('view-sidebar');
    expect(sidebar.style.width).toBe('260px');
  });

  it('im 视图会话区头部渲染双按钮入口（SessionSidebarHeader，T14 spec §6.2）', () => {
    render(<ViewSidebar />);
    expect(screen.getByTestId('session-entry-stub')).toBeInTheDocument();
  });

  it('files 视图渲染 FileTree；onSelectFile 由内部接 editor.store + ipc', () => {
    useUiStore.setState({ activeView: 'files' });
    render(<ViewSidebar />);
    expect(screen.getByTestId('file-tree-stub')).toBeInTheDocument();
  });

  it('tasks 视图渲染 TaskSidebarPanel', () => {
    useUiStore.setState({ activeView: 'tasks' });
    render(<ViewSidebar />);
    expect(screen.getByTestId('task-sidebar-stub')).toBeInTheDocument();
  });

  it.each(['agents', 'marketplace', 'settings'] as const)(
    '%s 视图无侧边栏（渲染 null）',
    (view) => {
      useUiStore.setState({ activeView: view });
      const { container } = render(<ViewSidebar />);
      expect(container.firstChild).toBeNull();
    },
  );

  it('收起时完全消失（不再渲染 48px 图标轨），内容不渲染', () => {
    useUiStore.setState({ sidebarCollapsed: { im: true, files: false, tasks: false } });
    const { container } = render(<ViewSidebar />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('room-list-stub')).not.toBeInTheDocument();
  });

  it('收起状态按视图独立：im 收起时 files 视图仍展开', () => {
    useUiStore.setState({ sidebarCollapsed: { im: true, files: false, tasks: false } });
    const im = render(<ViewSidebar />);
    expect(im.container.firstChild).toBeNull();

    cleanup();
    useUiStore.setState({ activeView: 'files' });
    const files = render(<ViewSidebar />);
    expect(files.getByTestId('file-tree-stub')).toBeInTheDocument();
  });

  it('宽度从 store 透传到 Sidebar（视图独立宽度）', () => {
    useUiStore.setState({ sidebarWidths: { im: 320, files: 260, tasks: 260 } });
    render(<ViewSidebar />);
    expect(screen.getByTestId('view-sidebar').style.width).toBe('320px');

    // 切到 files 视图：宽度独立（先卸载前一次 render，screen 单匹配）
    cleanup();
    useUiStore.setState({ activeView: 'files' });
    render(<ViewSidebar />);
    expect(screen.getByTestId('view-sidebar').style.width).toBe('260px');
  });
});

describe('ViewSidebar handleSelectFile（readForEditor 分流，功能优化 2026-10-11）', () => {
  // FileTree 桩点击 → onSelectFile('a.ts')（文件顶部 vi.mock 已定义）
  const fileApi = {
    readForEditor: vi.fn(),
    openWithDefaultApp: vi.fn(),
  };

  const buildWorkspace = (id: string): Workspace => ({
    id,
    name: 'ws',
    description: '',
    directoryPath: '/tmp/ws',
    gitInitialized: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: '@user:localhost',
    iconEmoji: '📁',
    defaultAgentInstanceId: null,
  });

  beforeEach(() => {
    (globalThis as unknown as { window: { api: unknown } }).window.api = { file: fileApi };
    fileApi.readForEditor.mockReset();
    fileApi.openWithDefaultApp.mockReset();
    fileApi.openWithDefaultApp.mockResolvedValue({ ok: true });
    useUiStore.setState({
      activeView: 'files',
      sidebarCollapsed: { im: false, files: false, tasks: false },
      sidebarWidths: { im: 260, files: 260, tasks: 260 },
    });
    useWorkspaceStore.setState({
      workspaces: [buildWorkspace('ws-1')],
      activeWorkspaceId: 'ws-1',
      loading: false,
      error: null,
    });
    useEditorStore.setState({ tabs: [], activeTab: null });
  });

  it('文本文件 → readForEditor 返回内容，打开编辑器 tab', async () => {
    fileApi.readForEditor.mockResolvedValue({ kind: 'text', content: 'hello' });
    render(<ViewSidebar />);
    fireEvent.click(screen.getByTestId('file-tree-stub'));
    await waitFor(() => {
      expect(useEditorStore.getState().tabs).toEqual([
        { filePath: 'a.ts', content: 'hello', dirty: false },
      ]);
      expect(useEditorStore.getState().activeTab).toBe('a.ts');
    });
    expect(fileApi.openWithDefaultApp).not.toHaveBeenCalled();
  });

  it('二进制文件 → 不开编辑器 tab，自动转系统默认应用打开', async () => {
    fileApi.readForEditor.mockResolvedValue({ kind: 'binary' });
    render(<ViewSidebar />);
    fireEvent.click(screen.getByTestId('file-tree-stub'));
    await waitFor(() => {
      expect(fileApi.openWithDefaultApp).toHaveBeenCalledWith('ws-1', 'a.ts');
    });
    expect(useEditorStore.getState().tabs).toEqual([]);
  });

  it('外部打开失败 → alert 剥净 IPC 包装后的单层中文文案（D1 回归锁）', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    fileApi.readForEditor.mockResolvedValue({ kind: 'binary' });
    // 真机实测形态（qa-reports/2026-10-11-file-area-real-acceptance cmd#128）：
    // Electron 给 ipcMain.handle 的 throw 包两层前缀后 reject
    fileApi.openWithDefaultApp.mockRejectedValue(
      new Error(
        "Error invoking remote method 'file:openWithDefaultApp': Error: 外部应用打开失败: Failed to open path",
      ),
    );
    render(<ViewSidebar />);
    fireEvent.click(screen.getByTestId('file-tree-stub'));
    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith('外部应用打开失败: Failed to open path');
    });
    alertMock.mockRestore();
  });
});
