// renderer/src/components/layout/ViewSidebar.test.tsx
//
// 统一侧边栏测试（P2 Task 3）：
// - 按 activeView 分发内容：im→RoomList / files→FileTree / tasks→TaskSidebarPanel
// - agents / marketplace / settings → 渲染 null（主区全宽，无侧边栏）
// - 折叠态 48px 只显对应图标，内容隐藏；点击展开恢复 260px
//
// RoomList / FileTree / TaskSidebarPanel 用轻量桩替代——本文件聚焦分发与折叠逻辑，
// 子组件自身行为由各自测试覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewSidebar } from './ViewSidebar';
import { useUiStore } from '../../stores/ui.store';

vi.mock('../im/RoomList', () => ({
  RoomList: () => <div data-testid="room-list-stub" />,
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
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
  });

  it('im 视图渲染 RoomList 内容（展开 260px）', () => {
    render(<ViewSidebar />);
    expect(screen.getByTestId('room-list-stub')).toBeInTheDocument();
    const sidebar = screen.getByTestId('view-sidebar');
    expect(sidebar.style.width).toBe('260px');
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

  it('折叠态 48px 仅显示当前视图图标，内容隐藏；点击展开', () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<ViewSidebar />);
    // 内容隐藏
    expect(screen.queryByTestId('room-list-stub')).not.toBeInTheDocument();
    // 折叠轨：48px + 会话图标
    const rail = screen.getByTestId('view-sidebar');
    expect(rail.style.width).toBe('48px');
    expect(screen.getByLabelText('展开侧边栏')).toBeInTheDocument();
    expect(screen.getByText('💬')).toBeInTheDocument();

    // 点击折叠轨 → 展开，内容恢复
    fireEvent.click(screen.getByLabelText('展开侧边栏'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(screen.getByTestId('room-list-stub')).toBeInTheDocument();
    expect(screen.getByTestId('view-sidebar').style.width).toBe('260px');
  });

  it('折叠态图标跟随视图：files → 📁 / tasks → 📋', () => {
    useUiStore.setState({ activeView: 'files', sidebarCollapsed: true });
    const { rerender } = render(<ViewSidebar />);
    expect(screen.getByText('📁')).toBeInTheDocument();

    useUiStore.setState({ activeView: 'tasks' });
    rerender(<ViewSidebar />);
    expect(screen.getByText('📋')).toBeInTheDocument();
  });
});
