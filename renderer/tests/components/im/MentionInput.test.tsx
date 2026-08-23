// renderer/tests/components/im/MentionInput.test.tsx
//
// MentionInput 行为测试（B 子系统 B5）：
//   1. 渲染 textarea + 发送按钮
//   2. 输入 @ 弹出 agent 菜单（仅显示当前 workspace 的 assignments）
//   3. 输入 # 弹出任务菜单（仅显示 status in [draft, pending, assigned] 的任务）
//   4. 点击 agent 菜单项插入 mention 文本（onChange 收到 @agentName）
//   5. 发送时回调携带 parseMentions 解析后的 Mention[]
//
// 重要：MentionInput 是受控组件（value + onChange 来自父）。
// 为让 fireEvent.change 真正影响渲染，每个用例用 ControlledHarness
// 包一层持有本地 state。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MentionInput } from '../../../src/components/im/MentionInput';
import { useAgentStore } from '../../../src/stores/agent.store';
import { useTaskStore } from '../../../src/stores/task.store';

vi.mock('../../../src/stores/agent.store');
vi.mock('../../../src/stores/task.store');

/** 受控 harness：把 MentionInput 包成 value 真正受 useState 控制的组件。 */
function ControlledHarness({
  onSend,
  initial = '',
}: {
  onSend: (text: string, mentions: import('../../../src/lib/mention-parser').Mention[]) => void;
  initial?: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <MentionInput
      value={v}
      onChange={setV}
      onSend={onSend}
      roomId="r1"
      workspaceId="ws1"
    />
  );
}

describe('MentionInput', () => {
  beforeEach(() => {
    vi.mocked(useAgentStore).mockReset();
    vi.mocked(useTaskStore).mockReset();
  });

  it('渲染 textarea + 发送按钮', () => {
    vi.mocked(useAgentStore).mockReturnValue({ assignments: [] } as never);
    vi.mocked(useTaskStore).mockReturnValue({ tasks: [] } as never);
    const onSend = vi.fn();
    render(<ControlledHarness onSend={onSend} />);
    expect(screen.getByPlaceholderText(/输入消息/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /发送/ })).toBeInTheDocument();
  });

  it('输入 @ 弹出 agent 菜单', () => {
    vi.mocked(useAgentStore).mockReturnValue({
      assignments: [
        { instanceId: 'i1', agentUserId: '@pm:home', agentName: 'PM-agent', lastRunning: true },
      ],
    } as never);
    vi.mocked(useTaskStore).mockReturnValue({ tasks: [] } as never);
    const onSend = vi.fn();
    render(<ControlledHarness onSend={onSend} />);
    const input = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.getByText(/PM-agent/)).toBeInTheDocument();
  });

  it('输入 # 弹出待处理任务菜单', () => {
    vi.mocked(useAgentStore).mockReturnValue({ assignments: [] } as never);
    vi.mocked(useTaskStore).mockReturnValue({
      tasks: [
        { id: 'T-001', title: 'task 1', status: 'pending' },
        { id: 'T-002', title: 'task 2', status: 'completed' }, // 不应显示
      ],
    } as never);
    const onSend = vi.fn();
    render(<ControlledHarness onSend={onSend} />);
    const input = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(input, { target: { value: '#' } });
    expect(screen.getByText(/task 1/)).toBeInTheDocument();
    expect(screen.queryByText(/task 2/)).not.toBeInTheDocument();
  });

  it('点击 agent 菜单项插入 chip', () => {
    vi.mocked(useAgentStore).mockReturnValue({
      assignments: [
        { instanceId: 'i1', agentUserId: '@pm:home', agentName: 'PM-agent', lastRunning: true },
      ],
    } as never);
    vi.mocked(useTaskStore).mockReturnValue({ tasks: [] } as never);
    const onSend = vi.fn();
    render(<ControlledHarness onSend={onSend} />);
    const input = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(screen.getByText(/PM-agent/));
    // 父级 onChange 收到的 value 应含 '@PM-agent'
    const inputAfter = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    expect(inputAfter.value).toContain('@PM-agent');
  });

  it('发送时回调携带解析后的 mentions', () => {
    vi.mocked(useAgentStore).mockReturnValue({ assignments: [] } as never);
    vi.mocked(useTaskStore).mockReturnValue({ tasks: [] } as never);
    const onSend = vi.fn();
    render(<ControlledHarness onSend={onSend} />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@PM-agent #T-001 开始' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenCalled();
    const [, mentions] = onSend.mock.calls[0]!;
    expect(mentions.length).toBe(2);
    expect(mentions[0]?.type).toBe('agent');
    expect(mentions[1]?.type).toBe('task');
  });
});
