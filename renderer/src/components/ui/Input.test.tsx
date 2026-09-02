// renderer/src/components/ui/Input.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('基础样式 token 化：surface-2 底 + subtle 边 + focus 换 accent 边', () => {
    render(<Input placeholder="请输入" />);
    const input = screen.getByPlaceholderText('请输入');
    expect(input.className).toContain('bg-surface-2');
    expect(input.className).toContain('border-subtle');
    expect(input.className).toContain('focus:border-focus');
  });

  it('label 关联：htmlFor 与 input id 一致', () => {
    render(<Input label="名称" />);
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
  });

  it('占位符颜色走 disabled 层级', () => {
    render(<Input placeholder="搜索" />);
    expect(screen.getByPlaceholderText('搜索').className).toContain('placeholder:text-disabled');
  });
});
