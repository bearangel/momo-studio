// renderer/src/components/task-board/TaskOriginFilter.test.tsx
//
// 来源多选下拉单测（2026-11-12 看板治理，预览 v2 批准定值）：
//   - 摘要文案：全选「全部」/ 部分选择全名 ' + ' 连接（originFilterSummary 纯函数）
//   - 开合交互：按钮开 → 三选项在场；遮罩点击 / Escape 关闭
//   - 勾选切换：取消勾选上抛去掉该项的新集合；再勾回恢复
//   - 至少保留一项：仅剩一项时该项 disabled 且点击不上抛空集合
// 组件零 IPC 依赖——onChange 是唯一出口（受控组件），无需 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskOriginFilter, originFilterSummary } from './TaskOriginFilter';
import { TASK_ORIGINS } from '../../lib/board';

const ALL: typeof TASK_ORIGINS[number][] = [...TASK_ORIGINS];

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: /按任务来源筛选/ }));
}

describe('originFilterSummary（纯函数）', () => {
  it('全选 →「全部」', () => {
    expect(originFilterSummary(ALL)).toBe('全部');
  });

  it('部分选择 → 全名按固定序 " + " 连接', () => {
    expect(originFilterSummary(['user', 'peer_draft'])).toBe('用户任务 + 平行草稿');
    expect(originFilterSummary(['dispatch'])).toBe('编排任务');
  });
});

describe('TaskOriginFilter（受控多选下拉）', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('默认按钮摘要「来源：全部」+ 中性样式；点击开 → 三选项在场（固定序 + 描述行）', () => {
    render(<TaskOriginFilter value={ALL} onChange={onChange} />);
    const btn = screen.getByRole('button', { name: /按任务来源筛选（当前：全部）/ });
    expect(btn).toHaveTextContent('来源：全部');
    expect(btn.className).toContain('border-subtle');
    openMenu();
    expect(screen.getByRole('listbox', { name: '任务来源选择' })).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      '用户任务手动创建',
      '编排任务agent 派发簿记',
      '平行草稿工作组接收',
    ]);
    expect(screen.getByText('至少保留一项 · 偏好本地记忆')).toBeInTheDocument();
  });

  it('部分选择 → 按钮高亮样式（border-focus + bg-surface-active）+ 摘要列全名', () => {
    render(<TaskOriginFilter value={['user', 'peer_draft']} onChange={onChange} />);
    const btn = screen.getByRole('button', { name: /按任务来源筛选/ });
    expect(btn).toHaveTextContent('来源：用户任务 + 平行草稿');
    expect(btn.className).toContain('border-focus');
    expect(btn.className).toContain('bg-surface-active');
  });

  it('取消勾选「编排任务」→ onChange 上抛 [user, peer_draft]；父层回灌后再勾回 → 上抛全集', () => {
    const view = render(<TaskOriginFilter value={ALL} onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByRole('option', { name: /编排任务/ }));
    expect(onChange).toHaveBeenLastCalledWith(['user', 'peer_draft']);
    // 受控语义：父层回灌新值（追加点在尾——序由 TASK_ORIGINS 消费方归一）
    view.rerender(<TaskOriginFilter value={['user', 'peer_draft']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('option', { name: /编排任务/ }));
    expect(onChange).toHaveBeenLastCalledWith(['user', 'peer_draft', 'dispatch']);
  });

  it('至少保留一项：仅剩一项时该项 disabled，点击不上抛空集合', () => {
    render(<TaskOriginFilter value={['user']} onChange={onChange} />);
    openMenu();
    const lastOption = screen.getByRole('option', { name: /用户任务/ });
    expect(lastOption).toBeDisabled();
    fireEvent.click(lastOption);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape 与遮罩点击关闭下拉', () => {
    render(<TaskOriginFilter value={ALL} onChange={onChange} />);
    openMenu();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /按任务来源筛选/ })); // 按钮再点=切换关
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    openMenu();
    // 遮罩在 listbox 之前插入 DOM——取第一个 fixed 遮罩点击
    const overlay = document.querySelector('.fixed.inset-0.z-40');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
