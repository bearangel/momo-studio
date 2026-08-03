// renderer/src/components/im/InputToolbar.test.tsx
// InputToolbar 工具条：成员切换按钮渲染 + 交互。
// 纯展示组件，不依赖 store / IPC，无需 vi.mock。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputToolbar } from './InputToolbar';

describe('InputToolbar', () => {
  it('渲染成员切换按钮', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: /成员/ })).toBeInTheDocument();
  });

  it('点击成员按钮触发 onToggleMembers', () => {
    const onToggle = vi.fn();
    render(<InputToolbar showMembers={false} onToggleMembers={onToggle} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /成员/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('showMembers=true 时按钮高亮', () => {
    render(<InputToolbar showMembers={true} onToggleMembers={() => {}} disabled={false} />);
    const btn = screen.getByRole('button', { name: /成员/ });
    expect(btn.className).toContain('accent-blue');
  });

  it('showMembers=false 时按钮不高亮', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    const btn = screen.getByRole('button', { name: /成员/ });
    expect(btn.className).not.toContain('accent-blue');
  });

  it('disabled=true 时按钮禁用', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={true} />);
    expect(screen.getByRole('button', { name: /成员/ })).toBeDisabled();
  });
});
