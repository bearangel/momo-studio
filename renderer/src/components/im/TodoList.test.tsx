// renderer/src/components/im/TodoList.test.tsx
//
// TodoList 纯列表渲染契约（v3 拆分：条目渲染单源，TodoSection/TaskProgressButton 复用）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TodoItem } from '../../ipc/types';
import { TodoList } from './TodoList';

const todos: TodoItem[] = [
  { id: 't1', subject: '已完成项', status: 'completed' },
  { id: 't2', subject: '进行中项', status: 'in_progress' },
  { id: 't3', subject: '待办项', status: 'pending' },
];

describe('TodoList（纯列表）', () => {
  it('渲染全部条目（带序号）', () => {
    render(<TodoList todos={todos} />);
    expect(screen.getByText('1. 已完成项')).toBeInTheDocument();
    expect(screen.getByText('2. 进行中项')).toBeInTheDocument();
    expect(screen.getByText('3. 待办项')).toBeInTheDocument();
  });

  it('完成态条目 line-through 弱化', () => {
    const { container } = render(<TodoList todos={todos} />);
    const first = container.querySelector('li');
    expect(first).not.toBeNull();
    expect(first!.className).toContain('line-through');
  });

  it('进行中条目 accent 高亮', () => {
    const { container } = render(<TodoList todos={todos} />);
    const items = container.querySelectorAll('li');
    expect(items[1]!.className).toContain('text-accent-600');
  });

  it('空数组返回 null', () => {
    const { container } = render(<TodoList todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
