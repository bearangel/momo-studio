// renderer/src/components/layout/SidebarRestoreButton.test.tsx
//
// 恢复按钮（方案 A 顶行内联停靠）测试：仅「收起 + 侧边栏视图」渲染，点击恢复。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarRestoreButton } from './SidebarRestoreButton';
import { useUiStore } from '../../stores/ui.store';

describe('SidebarRestoreButton', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
  });

  it('未收起时不渲染', () => {
    const { container } = render(<SidebarRestoreButton />);
    expect(container.firstChild).toBeNull();
  });

  it.each(['agents', 'marketplace', 'settings'] as const)(
    '收起但 %s 视图（无侧边栏）不渲染',
    (view) => {
      useUiStore.setState({ activeView: view, sidebarCollapsed: true });
      const { container } = render(<SidebarRestoreButton />);
      expect(container.firstChild).toBeNull();
    },
  );

  it.each(['im', 'files', 'tasks'] as const)('收起 + %s 视图渲染，点击恢复', (view) => {
    useUiStore.setState({ activeView: view, sidebarCollapsed: true });
    render(<SidebarRestoreButton />);
    fireEvent.click(screen.getByLabelText('展开侧边栏'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});