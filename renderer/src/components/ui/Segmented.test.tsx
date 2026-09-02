// renderer/src/components/ui/Segmented.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Segmented } from './Segmented';

const OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

describe('Segmented', () => {
  it('渲染全部选项并标记选中项 aria-checked', () => {
    render(<Segmented options={OPTIONS} value="dark" onChange={() => {}} aria-label="主题模式" />);
    const group = screen.getByRole('radiogroup', { name: '主题模式' });
    const radioDark = screen.getByRole('radio', { name: '深色' });
    const radioLight = screen.getByRole('radio', { name: '浅色' });
    expect(radioDark.getAttribute('aria-checked')).toBe('true');
    expect(radioLight.getAttribute('aria-checked')).toBe('false');
    expect(group.querySelectorAll('button').length).toBe(3);
  });

  it('点击选项回调 onChange(value)', () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="light" onChange={onChange} aria-label="主题模式" />);
    fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }));
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('选中项带 surface-active 语义类', () => {
    render(<Segmented options={OPTIONS} value="light" onChange={() => {}} aria-label="主题模式" />);
    expect(screen.getByRole('radio', { name: '浅色' }).className).toContain('bg-surface-active');
  });

  it('方向键右移：焦点与选中同步移动', () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="light" onChange={onChange} aria-label="主题模式" />);
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '主题模式' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(screen.getByRole('radio', { name: '深色' })).toHaveFocus();
  });

  it('单选项边界：Arrow 循环回自身且不崩溃', () => {
    const single = [{ value: 'only', label: '唯一' }] as const;
    const onChange = vi.fn();
    render(<Segmented options={single} value="only" onChange={onChange} aria-label="单选" />);
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '单选' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('only');
  });

  it('roving tabindex：仅激活项可 Tab', () => {
    render(<Segmented options={OPTIONS} value="dark" onChange={() => {}} aria-label="主题模式" />);
    expect(screen.getByRole('radio', { name: '深色' }).tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: '浅色' }).tabIndex).toBe(-1);
    expect(screen.getByRole('radio', { name: '跟随系统' }).tabIndex).toBe(-1);
  });
});
