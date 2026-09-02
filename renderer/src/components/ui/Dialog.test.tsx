// renderer/src/components/ui/Dialog.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('open=false 不渲染', () => {
    render(<Dialog open={false} onClose={() => {}} title="确认" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('open 渲染 role=dialog + aria-modal + 标题', () => {
    render(
      <Dialog open onClose={() => {}} title="删除成员">
        <p>确定要删除吗？</p>
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog', { name: '删除成员' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    // portal 到 document.body
    expect(dlg.parentElement).toBe(document.body);
  });

  it('Esc 触发 onClose', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('点击遮罩触发 onClose；点击内容区不触发', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="T">
        <p data-testid="body">内容</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByTestId('body'));
    expect(onClose).not.toHaveBeenCalled();
    // 遮罩是内容区的兄弟绝对定位元素
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('footer 渲染在尾部', () => {
    render(
      <Dialog open onClose={() => {}} title="T" footer={<button type="button">确定</button>}>
        <p>正文</p>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });
});