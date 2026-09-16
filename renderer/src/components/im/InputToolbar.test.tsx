// renderer/src/components/im/InputToolbar.test.tsx
// InputToolbar 工具条：成员切换按钮 + 📎 文件引用按钮（Task 10）渲染与交互。
// Task 10 起组件依赖 session.store（📎 经 fileTriggerTick 信号与 MentionInput
// 解耦通信 + activeSessionReadOnly 只读禁用）——使用真实 store，无需 vi.mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputToolbar } from './InputToolbar';
import { useSessionStore } from '../../stores/session.store';

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
    expect(btn.className).toContain('surface-active');
  });

  it('showMembers=false 时按钮不高亮', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    const btn = screen.getByRole('button', { name: /成员/ });
    expect(btn.className).not.toContain('surface-active');
  });

  it('disabled=true 时按钮禁用', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={true} />);
    expect(screen.getByRole('button', { name: /成员/ })).toBeDisabled();
  });
});

describe('InputToolbar 📎 文件引用按钮（Task 10）', () => {
  beforeEach(() => {
    // 真实 store 为模块级单例：归位触发信号与只读态，防跨用例残留
    useSessionStore.setState({ fileTriggerTick: 0, activeSessionReadOnly: false });
  });

  it('点击 📎 递增 fileTriggerTick', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    fireEvent.click(screen.getByLabelText('引用文件'));
    expect(useSessionStore.getState().fileTriggerTick).toBe(1);
  });

  it('disabled=true（无选中会话）时 📎 禁用且不递增', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={true} />);
    fireEvent.click(screen.getByLabelText('引用文件'));
    expect(useSessionStore.getState().fileTriggerTick).toBe(0);
  });

  it('会话只读（activeSessionReadOnly）时 📎 禁用', () => {
    useSessionStore.setState({ activeSessionReadOnly: true });
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    expect(screen.getByLabelText('引用文件')).toBeDisabled();
  });
});
