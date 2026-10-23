// renderer/src/components/im/SessionContextMenu.test.tsx
//
// 右键菜单组件定值锁（2026-10-22 右键菜单改造预览批准）：
// - 会话菜单四条目：置顶切换（按 pinned 态切文案）/ 移入分组… / 重命名 ‖ 解散会话（danger）
// - 组头菜单三条目：设置组色 / 重命名分组 ‖ 删除分组（danger）
// - 关闭三通道：遮罩点击 / 遮罩右键 / Escape
// - 视口钳制：右缘/下缘溢出回移（FileContextMenu 未做的补齐）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionContextMenu, GroupContextMenu, BatchSessionContextMenu } from './SessionContextMenu';

describe('SessionContextMenu —— 会话行右键菜单', () => {
  it('未置顶会话渲染四条目：置顶 / 移入分组… / 重命名 / 解散会话', () => {
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId('session-context-menu');
    expect(within(menu).getByText('置顶')).toBeInTheDocument();
    expect(within(menu).getByText('移入分组…')).toBeInTheDocument();
    expect(within(menu).getByText('重命名')).toBeInTheDocument();
    expect(within(menu).getByText('解散会话')).toBeInTheDocument();
  });

  it('已置顶会话首条目切「取消置顶」', () => {
    render(
      <SessionContextMenu x={10} y={10} pinned={true} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('取消置顶')).toBeInTheDocument();
    expect(screen.queryByText('置顶')).not.toBeInTheDocument();
  });

  it('解散会话为 danger 红字（status-error）', () => {
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('解散会话')).toHaveClass('text-status-error');
  });

  it('点条目 → 执行动作并关闭菜单', () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={onTogglePin} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByText('置顶'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GroupContextMenu —— 组头右键菜单', () => {
  function setup(): { onPalette: ReturnType<typeof vi.fn>; onDelete: ReturnType<typeof vi.fn> } {
    const onPalette = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(<GroupContextMenu x={10} y={10} onPalette={onPalette} onRename={onRename} onDelete={onDelete} onClose={vi.fn()} />);
    return { onPalette, onDelete };
  }

  it('渲染三条目：设置组色 / 重命名分组 / 删除分组（danger）', () => {
    setup();
    const menu = screen.getByTestId('group-context-menu');
    expect(within(menu).getByText('设置组色')).toBeInTheDocument();
    expect(within(menu).getByText('重命名分组')).toBeInTheDocument();
    expect(within(menu).getByText('删除分组')).toHaveClass('text-status-error');
  });

  it('点「设置组色」→ onPalette', () => {
    const { onPalette } = setup();
    fireEvent.click(screen.getByText('设置组色'));
    expect(onPalette).toHaveBeenCalledTimes(1);
  });
});

describe('BatchSessionContextMenu —— 批量右键菜单（多选>1）', () => {
  it('仅两条目：移入分组… (N) ‖ 解散会话 ×N（danger）；无置顶/重命名', () => {
    render(
      <BatchSessionContextMenu x={10} y={10} count={3} onMove={vi.fn()} onDissolve={vi.fn()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId('batch-context-menu');
    expect(within(menu).getByText('移入分组… (3)')).toBeInTheDocument();
    expect(within(menu).getByText('解散会话 ×3')).toHaveClass('text-status-error');
    expect(within(menu).queryByText('置顶')).not.toBeInTheDocument();
    expect(within(menu).queryByText('重命名')).not.toBeInTheDocument();
  });

  it('点「移入分组…」→ onMove + 关闭', () => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    render(
      <BatchSessionContextMenu x={10} y={10} count={2} onMove={onMove} onDissolve={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByText('移入分组… (2)'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('右键菜单关闭三通道 + 视口钳制（两菜单共享外壳）', () => {
  it('遮罩点击关闭', () => {
    const onClose = vi.fn();
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId('context-menu-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩右键关闭（ preventDefault 不弹原生菜单）', () => {
    const onClose = vi.fn();
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={onClose} />,
    );
    fireEvent.contextMenu(screen.getByTestId('context-menu-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape 关闭', () => {
    const onClose = vi.fn();
    render(
      <SessionContextMenu x={10} y={10} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('右缘/下缘溢出钳制：x 超视口 → 左移至视口内（jsdom 1024×768）', () => {
    render(
      <SessionContextMenu x={2000} y={800} pinned={false} onTogglePin={vi.fn()} onMove={vi.fn()} onRename={vi.fn()} onDissolve={vi.fn()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId('session-context-menu');
    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    expect(left).toBeLessThanOrEqual(1024 - 8);
    expect(top).toBeLessThanOrEqual(768 - 8);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});
