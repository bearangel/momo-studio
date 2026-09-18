// renderer/src/components/im/TodoSection.test.tsx
//
// TodoSection v1 语义恢复（v3 回归气泡内联）：header 进度 / 流式自动展开 /
// 完成自动折叠 / 手动开合 / 空数组。条目渲染断言经 TodoList 透传。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TodoItem } from '../../ipc/types';
import { TodoSection } from './TodoSection';

const todos: TodoItem[] = [
  { id: 't1', subject: '条目一', status: 'completed' },
  { id: 't2', subject: '条目二', status: 'in_progress' },
];

describe('TodoSection（v1 折叠语义恢复）', () => {
  it('流式默认展开：header 进度 + 列表条目可见', () => {
    render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
  });

  it('非流式默认折叠：仅 header，条目不可见', () => {
    render(<TodoSection todos={todos} isStreaming={false} />);
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('流式转完成：自动折叠', () => {
    const { rerender } = render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
    rerender(<TodoSection todos={todos} isStreaming={false} />);
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('手动开合：点击 header 切换', () => {
    render(<TodoSection todos={todos} isStreaming={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('空数组返回 null', () => {
    const { container } = render(<TodoSection todos={[]} isStreaming={true} />);
    expect(container).toBeEmptyDOMElement();
  });
});
