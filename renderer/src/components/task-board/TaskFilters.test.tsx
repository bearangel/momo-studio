// renderer/src/components/task-board/TaskFilters.test.tsx
//
// P3 Task 4：assignee 下拉实数据接线
//   - 渲染外部传入的 assigneeOptions（label=valueAgentName, value=instanceId）
//   - 保留 "全部 agent" 占位（value='all'）
//   - 选择后 onChange 携带新 assignee（其余字段保持）
//
// sidebar-search Task 5：FilterState.text 字段 + 文本输入框接线
//   - INITIAL 与既有 onChange 期望对象补 text: ''
//   - 文本输入触发 onChange 携带 text 更新，其余字段不变
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskFilters, type FilterState } from './TaskFilters';

const INITIAL: FilterState = { status: 'all', assignee: 'all', sort: 'priority', text: '' };

describe('TaskFilters', () => {
  it('默认 assignee 下拉只有「全部 agent」', () => {
    render(<TaskFilters value={INITIAL} onChange={() => {}} assigneeOptions={[]} />);
    const select = screen.getByDisplayValue('全部 agent') as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(select.options[0]?.value).toBe('all');
  });

  it('外部传入 assigneeOptions 后渲染对应 option（label=agentName, value=instanceId）', () => {
    render(
      <TaskFilters
        value={INITIAL}
        onChange={() => {}}
        assigneeOptions={[
          { value: 'inst-pm', label: 'PM-agent' },
          { value: 'inst-qa', label: 'QA-agent' },
        ]}
      />,
    );
    const select = screen.getByDisplayValue('全部 agent') as HTMLSelectElement;
    expect(select.options).toHaveLength(3);
    expect(select.options[0]?.value).toBe('all');
    expect(select.options[0]?.text).toBe('全部 agent');
    expect(select.options[1]?.value).toBe('inst-pm');
    expect(select.options[1]?.text).toBe('PM-agent');
    expect(select.options[2]?.value).toBe('inst-qa');
    expect(select.options[2]?.text).toBe('QA-agent');
  });

  it('选中 agent 后 onChange 收到 assignee 更新，其余字段不变', () => {
    const onChange = vi.fn();
    render(
      <TaskFilters
        value={INITIAL}
        onChange={onChange}
        assigneeOptions={[{ value: 'inst-pm', label: 'PM-agent' }]}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('全部 agent'), {
      target: { value: 'inst-pm' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      status: 'all',
      assignee: 'inst-pm',
      sort: 'priority',
      text: '',
    });
  });

  it('文本输入 onChange 携带 text 更新，其余字段不变', () => {
    const onChange = vi.fn();
    render(
      <TaskFilters value={INITIAL} onChange={onChange} assigneeOptions={[]} />,
    );
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '登录' } });
    expect(onChange).toHaveBeenCalledWith({
      status: 'all',
      assignee: 'all',
      sort: 'priority',
      text: '登录',
    });
  });
});
