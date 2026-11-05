// renderer/src/components/im/InputToolbar.test.tsx
// InputToolbar 工具条（2026-11-05 工具条可视化）：五个选择按钮（定序
// Agent/技能/文件/会话/任务）+ 成员贴右；创建任务按钮下线；按钮经
// bumpMentionTrigger 发信号，mentionScope 驱动激活态高亮。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InputToolbar } from './InputToolbar';

// mock 收窄到 store 模块（与 MentionInput.test 同款形态）：组件只消费
// mentionScope / activeSessionReadOnly 两个读面 + bumpMentionTrigger 一个动作
const { sessionState } = vi.hoisted(() => ({
  sessionState: {
    mentionScope: null as string | null,
    activeSessionReadOnly: false,
    bumpMentionTrigger: vi.fn(),
  },
}));
vi.mock('../../stores/session.store', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
    { getState: () => sessionState },
  ),
}));

function toolbarButtons(): HTMLElement[] {
  // 工具条容器 = 五选择按钮 + 成员的共同父级（border-t bg-surface-1）
  const member = screen.getByRole('button', { name: '成员' });
  const bar = member.parentElement as HTMLElement;
  return within(bar).getAllByRole('button');
}

describe('InputToolbar', () => {
  beforeEach(() => {
    sessionState.mentionScope = null;
    sessionState.activeSessionReadOnly = false;
    sessionState.bumpMentionTrigger = vi.fn();
  });

  it('渲染五个选择按钮（预览合同定序）+ 成员，且成员排最后', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    const buttons = toolbarButtons();
    const labels = buttons.map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Agent', '技能', '文件', '会话', '任务', '成员']);
    // 成员贴右（ml-auto 分区）
    expect(buttons[5]!.className).toContain('ml-auto');
  });

  it('创建任务按钮已下线', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
  });

  it('点击选择按钮 → bumpMentionTrigger(kind)', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '技能' }));
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(sessionState.bumpMentionTrigger).toHaveBeenNthCalledWith(1, 'agent');
    expect(sessionState.bumpMentionTrigger).toHaveBeenNthCalledWith(2, 'skill');
    expect(sessionState.bumpMentionTrigger).toHaveBeenNthCalledWith(3, 'file');
    expect(sessionState.bumpMentionTrigger).toHaveBeenNthCalledWith(4, 'session');
    expect(sessionState.bumpMentionTrigger).toHaveBeenNthCalledWith(5, 'task');
  });

  it('mentionScope 匹配的按钮高亮（surface-active），其余不高亮', () => {
    sessionState.mentionScope = 'file';
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    const file = screen.getByRole('button', { name: '文件' });
    const agent = screen.getByRole('button', { name: 'Agent' });
    expect(file.className).toContain('surface-active');
    expect(file.getAttribute('aria-pressed')).toBe('true');
    expect(agent.className).not.toContain('surface-active');
    expect(agent.getAttribute('aria-pressed')).toBe('false');
  });

  it('disabled=true 时全部按钮禁用', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={true} />);
    for (const b of toolbarButtons()) expect(b).toBeDisabled();
  });

  it('会话只读（activeSessionReadOnly）→ 选择按钮禁用、成员按钮仍可用（成员面板可看）', () => {
    sessionState.activeSessionReadOnly = true;
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: 'Agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '成员' })).toBeEnabled();
  });

  it('点击成员按钮触发 onToggleMembers；showMembers=true 高亮', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <InputToolbar showMembers={false} onToggleMembers={onToggle} disabled={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '成员' }));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<InputToolbar showMembers={true} onToggleMembers={onToggle} disabled={false} />);
    expect(screen.getByRole('button', { name: '成员' }).className).toContain('surface-active');
  });
});
