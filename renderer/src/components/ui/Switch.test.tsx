import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Switch } from './Switch';

describe('Switch（原子开关，role=switch 键盘可达）', () => {
  it('role=switch + aria-checked 反映选中态', () => {
    render(<Switch checked onChange={() => undefined} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('点击触发 onChange(next)；disabled 时不触发', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch checked={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
