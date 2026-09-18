// renderer/src/components/im/TaskProgressButton.test.tsx
//
// TaskProgressButton 行为测试（spec 2026-09-18-session-todo-header-button-design.md §8）：
//   隐藏规则 / 徽标 / 呼吸灯（含子 agent 场景）/ 浮层开-关-Esc-点外部 /
//   目标替换跟随 / 定位调用 / 会话切换收起
// 测试模式：真实 zustand store + setState（不 vi.mock store 模块）；DOM 定位仅
// mock getElementById 返回元素，scrollIntoView 为 spy（momo-test-rules：mock 收窄）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ImMessage, TodoItem } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useAgentStore } from '../../stores/agent.store';
import { TaskProgressButton } from './TaskProgressButton';

function mkMessage(id: string, sender: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id,
    sessionId: 's1',
    sender,
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    contextJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function mkTodos(n: number, done: number): TodoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    subject: `条目${i + 1}`,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  }));
}

function mkStream(messageId: string, todos: TodoItem[], status: StreamState['status']): StreamState {
  return {
    thinking: '',
    text: '',
    toolCalls: [],
    todos,
    dispatches: [],
    segments: [],
    events: [],
    status,
    messageId,
    startedAt: 0,
  };
}

function setStores(
  messages: ImMessage[],
  streams: Array<[string, StreamState]>,
  sessionId: string | null = 's1',
): void {
  useSessionStore.setState({
    activeSessionId: sessionId,
    messagesBySession: sessionId ? new Map([[sessionId, messages]]) : new Map(),
  });
  useStreamStore.setState({ streams: new Map(streams) });
}

describe('TaskProgressButton', () => {
  beforeEach(() => {
    useAgentStore.setState({ members: [], definitions: [] });
  });

  it('无顶层清单目标 → 不渲染', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', [], 'done')]]);
    const { container } = render(<TaskProgressButton sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('仅子 agent 有清单 → 不渲染（子清单去嵌套区看）', () => {
    setStores(
      [mkMessage('m-sub', '@member:ws', { parentStreamSessionId: 'ps-1' })],
      [['m-sub', mkStream('m-sub', mkTodos(2, 1), 'streaming')]],
    );
    const { container } = render(<TaskProgressButton sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('徽标显示最新顶层清单 n/m；呼吸灯随流式点亮', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(3, 1), 'streaming')]]);
    render(<TaskProgressButton sessionId="s1" />);
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('1/3');
    expect(document.querySelector('.todo-breath-dot')).not.toBeNull();
  });

  it('目标已完成但子 agent 流式中 → 呼吸灯仍点亮，徽标为目标 n/m', () => {
    setStores(
      [
        mkMessage('m1', '@a:ws'),
        mkMessage('m-sub', '@member:ws', { parentStreamSessionId: 'ps-1' }),
      ],
      [
        ['m1', mkStream('m1', mkTodos(2, 2), 'done')],
        ['m-sub', mkStream('m-sub', mkTodos(3, 0), 'streaming')],
      ],
    );
    render(<TaskProgressButton sessionId="s1" />);
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('2/2');
    expect(document.querySelector('.todo-breath-dot')).not.toBeNull();
  });

  it('点击展开浮层渲染目标清单；再点按钮收起', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<TaskProgressButton sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    expect(screen.getByTestId('task-progress-popover')).toBeInTheDocument();
    expect(screen.getByText('2. 条目2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
  });

  it('Esc 与点浮层外收起', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<TaskProgressButton sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    fireEvent.mouseDown(document.body); // 浮层外（capture 监听）
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
  });

  it('目标替换：新一轮顶层清单成为按钮目标（主 agent 优先语义）', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(5, 5), 'done')]]);
    render(<TaskProgressButton sessionId="s1" />);
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('5/5');
    act(() => {
      useSessionStore.setState({
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws'), mkMessage('m2', '@a:ws')]],
        ]),
      });
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(5, 5), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 0), 'streaming')],
        ]),
      });
    });
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('0/3');
  });

  it('定位到消息：滚动 + 闪烁 class + 浮层收起', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const classList = { add: vi.fn(), remove: vi.fn() };
    const el = { scrollIntoView, classList } as unknown as HTMLElement;
    const getById = vi.spyOn(document, 'getElementById').mockReturnValue(el);
    try {
      setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
      render(<TaskProgressButton sessionId="s1" />);
      fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
      fireEvent.click(screen.getByRole('button', { name: /定位到消息/ }));
      expect(getById).toHaveBeenCalledWith('msg-m1');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(classList.add).toHaveBeenCalledWith('todo-flash');
      expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(classList.remove).toHaveBeenCalledWith('todo-flash');
    } finally {
      getById.mockRestore();
      vi.useRealTimers();
    }
  });

  it('目标消失（清单清空）→ 浮层收起；新目标出现不自动弹开', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<TaskProgressButton sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    expect(screen.getByTestId('task-progress-popover')).toBeInTheDocument();
    // todos 清空 → 目标消失 → 组件返回 null（浮层随之消失）
    act(() => {
      useStreamStore.setState({ streams: new Map([['m1', mkStream('m1', [], 'done')]]) });
    });
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
    // 新目标出现 → 按钮回归但浮层保持关闭（open 不残留）
    act(() => {
      useStreamStore.setState({
        streams: new Map([['m1', mkStream('m1', mkTodos(3, 0), 'streaming')]]),
      });
    });
    expect(screen.getByRole('button', { name: /查看会话任务/ })).toBeInTheDocument();
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
  });

  it('会话切换 → 浮层收起且目标跟随新会话', () => {
    // s2 清单需播种：spec §5 规定无 todos 流的消息不是目标（brief 原稿漏播种）
    setStores(
      [mkMessage('m1', '@a:ws')],
      [
        ['m1', mkStream('m1', mkTodos(2, 1), 'done')],
        ['m-s2', mkStream('m-s2', mkTodos(1, 0), 'done')],
      ],
    );
    const { rerender } = render(<TaskProgressButton sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /查看会话任务/ }));
    expect(screen.getByTestId('task-progress-popover')).toBeInTheDocument();
    // 组件 sessionId prop 变化（MiddlePanel 头部随 activeSessionId 重渲染）
    act(() => {
      useSessionStore.setState({
        activeSessionId: 's2',
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws')]],
          ['s2', [mkMessage('m-s2', '@c:ws')]],
        ]),
      });
    });
    rerender(<TaskProgressButton sessionId="s2" />);
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('0/1');
  });
});
