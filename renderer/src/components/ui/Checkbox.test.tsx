// renderer/src/components/ui/Checkbox.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('label 关联且可点击切换', () => {
    const onChange = vi.fn();
    render(<Checkbox label="启用 bash 工具" onChange={onChange} />);
    const cb = screen.getByRole('checkbox', { name: '启用 bash 工具' });
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledOnce();
    expect((cb as HTMLInputElement).checked).toBe(true);
  });

  it('选中态样式类（peer 机制由 CSS 生效，此处断言类名存在）', () => {
    render(<Checkbox label="L" defaultChecked />);
    expect(screen.getByRole('checkbox').className).toContain('checked:bg-accent-500');
  });

  it('disabled 透传', () => {
    render(<Checkbox label="只读" disabled />);
    expect(screen.getByRole('checkbox', { name: '只读' })).toBeDisabled();
  });
});
