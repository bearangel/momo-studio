// renderer/src/components/ui/ConfirmDialog.test.tsx
//
// ConfirmDialog 行为（P2.5 D5 危险操作二次确认）：
//   - 渲染 title / message / 取消+确认双钮（确认钮文案 confirmLabel 缺省「删除」）
//   - 点确认 → 先 onConfirm 后 onClose：顺序是生产行为——消费方 onConfirm 闭包
//     常读待删态（如 pendingDelete.id），若组件先 onClose 清空状态再 onConfirm 即崩
//   - 点取消 / Esc → 仅 onClose，不 onConfirm
//   - 组件自身永不隐藏（无条件渲染 open）——消失由消费方回调清态驱动
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('渲染标题、正文与取消/确认双钮（confirmLabel 缺省「删除」）', () => {
    render(
      <ConfirmDialog title="删除 甲？" message="此操作不可撤销。" onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('dialog', { name: '删除 甲？' })).toBeInTheDocument();
    expect(screen.getByText('此操作不可撤销。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
  });

  it('confirmLabel 覆盖确认钮文案', () => {
    render(
      <ConfirmDialog title="T" message="M" confirmLabel="确认删除" onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '确认删除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('点确认 → onConfirm 先于 onClose 各触发一次', () => {
    const calls: string[] = [];
    const onConfirm = vi.fn(() => calls.push('confirm'));
    const onClose = vi.fn(() => calls.push('close'));
    render(<ConfirmDialog title="T" message="M" onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    // 顺序锁：消费方 onConfirm 闭包读 pendingDelete.id，onClose 先清空即崩
    expect(calls).toEqual(['confirm', 'close']);
  });

  it('点取消 → 仅 onClose，不 onConfirm', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog title="T" message="M" onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc → 仅 onClose，不 onConfirm', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog title="T" message="M" onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
