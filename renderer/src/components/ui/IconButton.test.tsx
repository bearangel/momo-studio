// renderer/src/components/ui/IconButton.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('aria-label 必填并渲染为可访问名称', () => {
    render(
      <IconButton aria-label="删除">
        <Trash2 size={16} strokeWidth={1.75} />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
  });

  it('ghost 变体 hover 语义类 + 点击回调', () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="关闭" onClick={onClick}>
        <Trash2 size={16} strokeWidth={1.75} />
      </IconButton>,
    );
    const btn = screen.getByRole('button', { name: '关闭' });
    expect(btn.className).toContain('hover:bg-surface-3');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('danger 变体使用 error tint', () => {
    render(
      <IconButton aria-label="移除成员" variant="danger">
        <Trash2 size={16} strokeWidth={1.75} />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: '移除成员' }).className).toContain('hover:bg-status-error-tint');
  });
});
