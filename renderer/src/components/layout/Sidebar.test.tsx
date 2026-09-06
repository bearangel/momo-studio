// renderer/src/components/layout/Sidebar.test.tsx
//
// Sidebar 展开态外壳测试（v2.2）：
// - 宽度 props 驱动；头部行（标题 + 收起按钮）
// - 拖拽：pointerdown → window pointermove 实时预览（角标）→ pointerup 一次提交
// - 钳制 200–480；触界角标「最小/最大」；pointercancel 同 up 提交；双击重置 260
// - 拖拽期间不调用 onWidthCommit（预览不写 store，spec §5.3）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const baseProps = {
  label: '会话',
  width: 260,
  onWidthCommit: vi.fn(),
  onCollapse: vi.fn(),
};

const renderSidebar = (props: Partial<typeof baseProps> = {}) =>
  render(<Sidebar {...baseProps} {...props}>内容</Sidebar>);

describe('Sidebar', () => {
  it('宽度由 props 驱动，渲染头部行标题与收起按钮', () => {
    renderSidebar({ width: 320 });
    expect(screen.getByTestId('view-sidebar').style.width).toBe('320px');
    expect(screen.getByText('会话')).toBeInTheDocument();
    expect(screen.getByLabelText('收起侧边栏')).toBeInTheDocument();
  });

  it('点击收起按钮调用 onCollapse', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('收起侧边栏'));
    expect(baseProps.onCollapse).toHaveBeenCalledTimes(1);
  });

  it('拖拽：down→move 实时预览（角标 350），up 一次提交 350', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    // 预览阶段：宽度已变 + 角标显示，但未提交
    expect(screen.getByTestId('view-sidebar').style.width).toBe('310px');
    expect(screen.getByTestId('sidebar-width-badge').textContent).toBe('310 px');
    expect(onWidthCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 150 });
    expect(onWidthCommit).toHaveBeenCalledTimes(1);
    expect(onWidthCommit).toHaveBeenCalledWith(310);
  });

  it('拖拽钳制：超出上限角标提示「最大」，提交 480', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ width: 400, onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 2000 });
    expect(screen.getByTestId('sidebar-width-badge').textContent).toBe('480 px · 最大');
    expect(screen.getByTestId('view-sidebar').style.width).toBe('480px');

    fireEvent.pointerUp(window, { clientX: 2000 });
    expect(onWidthCommit).toHaveBeenCalledWith(480);
  });

  it('拖拽钳制：低于下限提交 200', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: -500 });
    fireEvent.pointerUp(window, { clientX: -500 });
    expect(onWidthCommit).toHaveBeenCalledWith(200);
  });

  it('pointercancel 与 pointerup 同路径提交当前预览宽度', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 60 });
    fireEvent.pointerCancel(window);
    expect(onWidthCommit).toHaveBeenCalledTimes(1);
    expect(onWidthCommit).toHaveBeenCalledWith(220);
  });

  it('双击分隔条重置默认 260', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ width: 400, onWidthCommit });

    fireEvent.doubleClick(screen.getByTestId('sidebar-resizer'));
    expect(onWidthCommit).toHaveBeenCalledWith(260);
  });

  it('拖拽中 children 仍渲染（不卸载）', () => {
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(screen.getByText('内容')).toBeInTheDocument();
  });
});
