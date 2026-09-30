// renderer/src/components/ui/Toast.test.tsx
//
// Toast 通用通知条(看板重构 Task 13):
//   - showToast → 底部通知条出现(role=status 屏幕阅读器直播区)
//   - 3s 自动消散;手动关闭立即消散
//   - 单例语义:同一时刻至多一条,新 toast 覆盖旧条并重置计时
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast, showToast, dismissToast } from './Toast';

describe('Toast 通知条', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 模块级单例 state 跨用例隔离复位
    dismissToast();
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('showToast → 通知条出现,role=status 且直出文本', () => {
    render(<Toast />);
    act(() => {
      showToast('目标分组不存在: G-9');
    });
    const el = screen.getByTestId('ui-toast');
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveTextContent('目标分组不存在: G-9');
  });

  it('3s 后自动消散', () => {
    render(<Toast />);
    act(() => {
      showToast('移动失败提示');
    });
    expect(screen.getByTestId('ui-toast')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId('ui-toast')).not.toBeInTheDocument();
  });

  it('手动关闭钮 → 立即消散', () => {
    render(<Toast />);
    act(() => {
      showToast('失败乙');
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    });
    expect(screen.queryByTestId('ui-toast')).not.toBeInTheDocument();
  });

  it('单例覆盖:新 toast 顶掉旧条并重置 3s 计时', () => {
    render(<Toast />);
    act(() => {
      showToast('第一条');
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      showToast('第二条');
    });
    expect(screen.getByTestId('ui-toast')).toHaveTextContent('第二条');
    // 第一条已存在 4s,但第二条只 2s → 覆盖重置计时,仍在
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('ui-toast')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('ui-toast')).not.toBeInTheDocument();
  });
});
