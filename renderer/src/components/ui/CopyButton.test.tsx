// renderer/src/components/ui/CopyButton.test.tsx
//
// CopyButton 单测：复制源文 + 2s 已复制反馈 + onMouseDown 保护选区。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('点击调用 clipboard.writeText', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="源文" />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('源文');
  });

  it('点击后显示「已复制」', () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(screen.getByText('已复制')).toBeInTheDocument();
    // act 包住 advanceTimersByTime：setTimeout 回调内 setCopied(false) 的 React 更新需要同步 flush，
    // 否则 expect 拿到的是 setCopied(true) 时的 DOM
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByText('复制')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('onMouseDown preventDefault（保护文本选区）', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="x" />);
    // MouseEvent 默认可取消；调用 preventDefault() 后 fireEvent 返回 false（dispatchEvent 行为）。
    // 断言 false 即证明 preventDefault 生效——用户文本选区因此被保护，不会因按钮 mousedown 失焦。
    const down = fireEvent.mouseDown(screen.getByRole('button', { name: '复制' }));
    expect(down).toBe(false);
  });
});
