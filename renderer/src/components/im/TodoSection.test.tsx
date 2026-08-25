// renderer/src/components/im/TodoSection.test.tsx
// TodoSection 行为：流式中默认展开 / 进度显示 / 完成项 line-through /
// 点击 header 折叠 / 空数组不渲染。
//
// 注意：组件把序号与 subject 渲染在同一 <span>（"2. 实现"），
// 因此用正则 /实现/ 做子串匹配，而非精确字符串。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoSection } from './TodoSection';

const todos = [
  { id: '1', subject: '设计', status: 'completed' as const },
  { id: '2', subject: '实现', status: 'in_progress' as const },
  { id: '3', subject: '测试', status: 'pending' as const },
];

describe('TodoSection', () => {
  it('流式中默认展开', () => {
    render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText(/实现/)).toBeInTheDocument();
  });

  it('显示进度', () => {
    render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText(/1\/3/)).toBeInTheDocument();
  });

  it('完成项有 line-through class', () => {
    const { container } = render(<TodoSection todos={todos} isStreaming={true} />);
    expect(container.querySelector('.line-through')).toBeTruthy();
  });

  it('点击折叠', () => {
    render(<TodoSection todos={todos} isStreaming={true} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/实现/)).not.toBeInTheDocument();
  });

  it('空数组不渲染', () => {
    const { container } = render(<TodoSection todos={[]} isStreaming={true} />);
    expect(container.firstChild).toBeNull();
  });
});
