// renderer/src/components/ui/Button.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('primary 变体：accent-500 底 + inverse 文字', () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn.className).toContain('bg-accent-500');
    expect(btn.className).toContain('text-inverse');
  });

  it('secondary 变体：accent 描边 + 明暗自适应文字', () => {
    render(<Button variant="secondary">取消</Button>);
    const cls = screen.getByRole('button', { name: '取消' }).className;
    expect(cls).toContain('border-accent-500');
    expect(cls).toContain('text-accent-600');
    expect(cls).toContain('dark:text-accent-300');
  });

  it('ghost 变体与 danger 变体', () => {
    render(
      <div>
        <Button variant="ghost">忽略</Button>
        <Button variant="danger">删除</Button>
      </div>,
    );
    expect(screen.getByRole('button', { name: '忽略' }).className).toContain('hover:bg-surface-3');
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-status-error');
  });

  it('disabled 透传原生属性并带禁用样式', () => {
    render(<Button disabled>不可用</Button>);
    expect(screen.getByRole('button', { name: '不可用' }).className).toContain('disabled:opacity-50');
  });

  it('type 默认 button（表单内不触发隐式 submit）', () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole('button', { name: '保存' }).getAttribute('type')).toBe('button');
  });

  it('点击回调正常触发', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>点我</Button>);
    fireEvent.click(screen.getByRole('button', { name: '点我' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
