// renderer/src/components/task-board/TaskList.test.tsx
//
// TaskList 空态文案：默认「暂无任务」；emptyText 覆盖（过滤无结果场景）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskList } from './TaskList';

describe('TaskList emptyText', () => {
  it('空列表默认显示「暂无任务」', () => {
    render(<TaskList tasks={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
  });

  it('传入 emptyText 时显示自定义文案（无匹配任务）', () => {
    render(
      <TaskList tasks={[]} selectedId={null} onSelect={() => {}} emptyText="无匹配任务" />,
    );
    expect(screen.getByText('无匹配任务')).toBeInTheDocument();
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument();
  });
});
