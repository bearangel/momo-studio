// renderer/src/components/layout/ViewSidebar.test.tsx
//
// 统一侧边栏测试（P2 Task 3 / v2.2 Task 3）：
// - 按 activeView 分发内容：im→RoomList / files→FileTree / tasks→TaskSidebarPanel
// - agents / marketplace / settings → 渲染 null（主区全宽，无侧边栏）
// - 收起态 = 完全消失（return null，不再渲染 48px 图标轨）
// - 宽度按视图独立从 ui.store.sidebarWidths 透传到 Sidebar
//
// RoomList / FileTree / TaskSidebarPanel 用轻量桩替代——本文件聚焦分发与折叠逻辑，
// 子组件自身行为由各自测试覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ViewSidebar } from './ViewSidebar';
import { useUiStore } from '../../stores/ui.store';

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
      sidebarCollapsed: false,
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
    useUiStore.setState({ sidebarCollapsed: true });
    const { container } = render(<ViewSidebar />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('room-list-stub')).not.toBeInTheDocument();
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
