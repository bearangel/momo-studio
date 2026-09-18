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
});
