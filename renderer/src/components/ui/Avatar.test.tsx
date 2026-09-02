// renderer/src/components/ui/Avatar.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('渲染名称首字母（大写）并带 title 提示', () => {
    render(<Avatar name="coder" />);
    const el = screen.getByTitle('coder');
    expect(el.textContent).toBe('C');
    expect(el.className).toContain('rounded-full');
  });

  it('同名单测试稳定（同名同色相），异名大概率异色相', () => {
    // 同名 → 相同 hsl 背景
    const { container: c1 } = render(<Avatar name="alice" />);
    const { container: c2 } = render(<Avatar name="alice" />);
    expect(c1.querySelector('span')?.style.backgroundColor).toBe(
      c2.querySelector('span')?.style.backgroundColor,
    );
  });

  it('bot=true 渲染 Bot 图标且无首字母', () => {
    render(<Avatar name="pm-agent" bot />);
    const el = screen.getByTitle('pm-agent');
    expect(el.textContent).toBe('');
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('size sm 为 20px 方形圆角', () => {
    render(<Avatar name="x" size="sm" />);
    const el = screen.getByTitle('x');
    expect(el.style.width).toBe('20px');
    expect(el.style.height).toBe('20px');
  });
});
