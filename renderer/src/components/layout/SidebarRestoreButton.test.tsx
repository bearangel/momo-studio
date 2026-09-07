// renderer/src/components/layout/SidebarRestoreButton.test.tsx
//
// 恢复按钮（方案 A 顶行内联停靠）测试：仅「当前视图自己收起 + 侧边栏视图」渲染，
// 点击仅恢复该视图（v2.2 优化：收起状态按视图独立）。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarRestoreButton } from './SidebarRestoreButton';
import { useUiStore } from '../../stores/ui.store';

type SidebarView = 'im' | 'files' | 'tasks';

/** 仅指定视图收起的状态片段（其余视图保持展开，验证独立性） */
const collapsedFor = (v: SidebarView): { sidebarCollapsed: Record<SidebarView, boolean> } => ({
  sidebarCollapsed: { im: v === 'im', files: v === 'files', tasks: v === 'tasks' },
});

const ALL_FALSE = { im: false, files: false, tasks: false };

describe('SidebarRestoreButton', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: ALL_FALSE });
  });

  it('未收起时不渲染（其它视图收起不影响当前视图）', () => {
    useUiStore.setState({ activeView: 'im', ...collapsedFor('files') });
    const { container } = render(<SidebarRestoreButton />);
    expect(container.firstChild).toBeNull();
  });

  it.each(['agents', 'marketplace', 'settings'] as const)(
    '收起但 %s 视图（无侧边栏）不渲染',
    (view) => {
      useUiStore.setState({ activeView: view, ...collapsedFor('im') });
      const { container } = render(<SidebarRestoreButton />);
      expect(container.firstChild).toBeNull();
    },
  );

  it.each(['im', 'files', 'tasks'] as const)('收起 + %s 视图渲染，点击仅恢复该视图', (view) => {
    useUiStore.setState({ activeView: view, ...collapsedFor(view) });
    render(<SidebarRestoreButton />);
    fireEvent.click(screen.getByLabelText('展开侧边栏'));
    expect(useUiStore.getState().sidebarCollapsed).toEqual(ALL_FALSE);
  });
});
