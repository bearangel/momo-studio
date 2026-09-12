// renderer/src/components/workspace/TakeoverIndicator.test.tsx
//
// TakeoverIndicator 单元测试（v2.7 Task 8，spec §3.5）：
//   - user 态：warning 徽标 + 「释放」按钮 → onRelease
//   - agent 态：无按钮（agent 自由操作，无需释放）
// 纯展示组件（回调注入），不触 IPC；徽标用 status-warning 系语义 token。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TakeoverIndicator } from './TakeoverIndicator';

describe('TakeoverIndicator（v2.7 Task 8）', () => {
  it('user 态 → 渲染「用户接管中」徽标 + 「释放」按钮', () => {
    render(<TakeoverIndicator takeover="user" onRelease={vi.fn()} />);
    expect(screen.getByText('用户接管中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '释放' })).toBeInTheDocument();
  });

  it('user 态徽标用 status-warning 语义 token（设计系统锁定）', () => {
    render(<TakeoverIndicator takeover="user" onRelease={vi.fn()} />);
    const badge = screen.getByText('用户接管中');
    expect(badge.className).toMatch(/status-warning/);
  });

  it('点击「释放」→ onRelease', () => {
    const onRelease = vi.fn();
    render(<TakeoverIndicator takeover="user" onRelease={onRelease} />);
    fireEvent.click(screen.getByRole('button', { name: '释放' }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('agent 态 → 无「释放」按钮（agent 自由操作）', () => {
    render(<TakeoverIndicator takeover="agent" onRelease={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '释放' })).not.toBeInTheDocument();
  });

  it('agent 态 → 不渲染任何内容', () => {
    const { container } = render(<TakeoverIndicator takeover="agent" onRelease={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
