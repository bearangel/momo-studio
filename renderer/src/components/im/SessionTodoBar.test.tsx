// renderer/src/components/im/SessionTodoBar.test.tsx
//
// SessionTodoBar 行为测试（spec docs/specs/2026-09-18-session-todo-bar-design.md）：
//   Task 1 部分——候选推导（无候选不渲染 / 单候选无页签 / 子 agent 消息入候选）
//   Task 2 部分——多候选页签 / 自动跟随 / 手动固定
//   Task 3 部分——手动关闭 / 增员重现 / 切会话重置
//
// 测试模式与 AgentStreamBubble.test.tsx 一致：真实 zustand store + setState 注入，
// 不 vi.mock store 模块（momo-test-rules：mock 收窄）。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ImMessage, TodoItem } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useAgentStore } from '../../stores/agent.store';
import { SessionTodoBar } from './SessionTodoBar';

/** 构造 ImMessage（字段契约见 types.d.ts，与 AgentStreamBubble.test 同型） */
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

/** 构造 n 项待办：前 done 项 completed、第 done+1 项 in_progress、其余 pending */
function mkTodos(n: number, done: number): TodoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    subject: `条目${i + 1}`,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  }));
}

/** 构造 StreamState（status / todos 可覆写） */
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

/** 注入两 store：会话 s1 的消息 + streams Map（renderer 真实 store，setState 合并） */
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

describe('SessionTodoBar', () => {
  beforeEach(() => {
    // agent 名映射置空——页签名走 shortName 回退，断言不耦合名字
    useAgentStore.setState({ members: [], definitions: [] });
  });

  // --- Task 1：候选推导 ---

  it('无 todos 候选时不渲染', () => {
    setStores([mkMessage('m1', '@bot:ws')], [['m1', mkStream('m1', [], 'done')]]);
    const { container } = render(<SessionTodoBar />);
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('单候选：渲染任务条与 TodoSection，无页签行', () => {
    setStores(
      [mkMessage('m1', '@bot:ws')],
      [['m1', mkStream('m1', mkTodos(3, 2), 'done')]],
    );
    render(<SessionTodoBar />);
    expect(screen.getByTestId('session-todo-bar')).toBeInTheDocument();
    // TodoSection 头部：进度 2/3（67%）
    expect(screen.getByText('2/3（67%）')).toBeInTheDocument();
    // 单候选不渲染页签
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    // 单候选标签行（agent 名 + 待办）
    expect(screen.getByText(/· 待办$/)).toBeInTheDocument();
  });

  it('子 agent 消息（parentStreamSessionId 非空）同样入候选', () => {
    setStores(
      [mkMessage('m-sub', '@member:ws', { parentStreamSessionId: 'ps-1' })],
      [['m-sub', mkStream('m-sub', mkTodos(2, 1), 'streaming')]],
    );
    render(<SessionTodoBar />);
    expect(screen.getByTestId('session-todo-bar')).toBeInTheDocument();
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
  });

  // --- Task 2：多候选页签 + 自动跟随 + 手动固定 ---

  /** 多候选夹具：m1（3 项完成 2）+ m2（3 项完成 1），状态可覆写 */
  function setupTwo(
    s1: StreamState['status'] = 'done',
    s2: StreamState['status'] = 'streaming',
  ): void {
    setStores(
      [mkMessage('m1', '@a:ws'), mkMessage('m2', '@b:ws')],
      [
        ['m1', mkStream('m1', mkTodos(3, 2), s1)],
        ['m2', mkStream('m2', mkTodos(3, 1), s2)],
      ],
    );
  }

  /** 取当前激活页签的进度文本（'2/3' 或 '1/3'）——断言不耦合 agent 名 */
  function activeTabProgress(): string | null {
    const tabs = screen.getAllByRole('tab');
    const activeTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    const m = activeTab?.textContent?.match(/(\d+\/\d+)/);
    return m ? (m[1] ?? null) : null;
  }

  it('多候选：渲染页签行，自动跟随最后一个流式候选', () => {
    // m1 done、m2 streaming → 激活 m2（流式优先）
    setupTwo('done', 'streaming');
    render(<SessionTodoBar />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(activeTabProgress()).toBe('1/3');
    // 流式页签带高亮点（aria-hidden 指示圆点）
    expect(document.querySelector('[role="tab"] .bg-accent-500')).not.toBeNull();
  });

  it('流式候选在前、完成候选在后：仍自动跟随流式者', () => {
    // m1 streaming、m2 done → 激活 m1（不是最后一个候选）
    setupTwo('streaming', 'done');
    render(<SessionTodoBar />);
    expect(activeTabProgress()).toBe('2/3');
  });

  it('全部终态：激活最后一个候选（最新快照）', () => {
    setupTwo('done', 'done');
    render(<SessionTodoBar />);
    expect(activeTabProgress()).toBe('1/3'); // m2 是最后候选
  });

  it('手动点击页签固定：另一候选流式中也不抢焦点', () => {
    setupTwo('streaming', 'streaming'); // 自动跟随 m2
    render(<SessionTodoBar />);
    expect(activeTabProgress()).toBe('1/3');
    // 点击 m1 页签（accessible name 含 '2/3'）
    fireEvent.click(screen.getByRole('tab', { name: /2\/3/ }));
    expect(activeTabProgress()).toBe('2/3');
    // m2 仍在流式——固定不被抢
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 2), 'streaming')],
          ['m2', mkStream('m2', mkTodos(3, 1), 'streaming')],
        ]),
      });
    });
    expect(activeTabProgress()).toBe('2/3');
  });

  it('固定候选由流式转入终态：解除固定，恢复自动跟随', () => {
    setupTwo('streaming', 'streaming');
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('tab', { name: /2\/3/ })); // 固定 m1
    // m1 → done（曾流式 → 解除固定），m2 仍流式 → 自动跟随回 m2
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 3), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 1), 'streaming')],
        ]),
      });
    });
    expect(activeTabProgress()).toBe('1/3');
  });

  it('固定已完成的历史候选（回看）：不自动解除', () => {
    setupTwo('done', 'streaming'); // 自动跟随 m2
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('tab', { name: /2\/3/ })); // 固定 m1（done）
    expect(activeTabProgress()).toBe('2/3');
    // m2 继续流式更新——m1 固定不动
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 2), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 2), 'streaming')],
        ]),
      });
    });
    expect(activeTabProgress()).toBe('2/3');
  });
});
