// renderer/src/components/im/SessionTodoBar.test.tsx
//
// SessionTodoBar v2 行为测试（spec 2026-09-18-session-todo-bar-ux-refine-design.md）：
//   Task 1 核心——默认折叠 / 摘要行内容 / 点击切换 / 活清单替换 / v1 生命周期回归
//   Task 2 页签——仅多流式出现 / 固定与解除 / 终态消失
//   Task 3 历史——下拉临时查看 / 自动退出 / Ctrl+T
//
// 测试模式：真实 zustand store + setState 注入（不 vi.mock store 模块）。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { ImMessage, TodoItem } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useAgentStore } from '../../stores/agent.store';
import { SessionTodoBar } from './SessionTodoBar';

/** 构造 ImMessage（契约同 v1 测试） */
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

/** n 项待办：前 done 项 completed、第 done+1 项 in_progress、其余 pending */
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

/** 摘要行的 n/m 进度文本（断言与 agent 名解耦） */
function summaryProgress(): string | null {
  const el = screen.getByTestId('todo-summary');
  const m = el.textContent?.match(/(\d+\/\d+)/);
  return m?.[1] ?? null;
}

describe('SessionTodoBar v2', () => {
  beforeEach(() => {
    useAgentStore.setState({ members: [], definitions: [] });
  });

  // --- Task 1：默认折叠 + 摘要行 ---

  it('默认折叠：流式候选也只渲染摘要行，不渲染列表', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(3, 1), 'streaming')]]);
    render(<SessionTodoBar />);
    const summary = screen.getByTestId('todo-summary');
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    // 列表未渲染：带序号的列表条目不出现（摘要行的当前进行项 subject 无序号前缀，
    // 见下一用例）；无滚动容器
    expect(screen.queryByText(/^\d+\. 条目\d/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('todo-list-scroll')).not.toBeInTheDocument();
  });

  it('摘要行内容：n/m + 当前进行项 subject', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(3, 1), 'streaming')]]);
    render(<SessionTodoBar />);
    expect(summaryProgress()).toBe('1/3');
    // mkTodos(3,1)：进行中项 = 条目2
    expect(screen.getByText('条目2')).toBeInTheDocument();
  });

  it('摘要行无进行中项时不显示条目文本（全完成）', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 2), 'done')]]);
    render(<SessionTodoBar />);
    expect(summaryProgress()).toBe('2/2');
    expect(screen.queryByText(/条目\d/)).not.toBeInTheDocument();
  });

  it('点击摘要行切换展开：列表 + 限高滚动容器出现，再点收起', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(3, 1), 'done')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByTestId('todo-summary'));
    const summary = screen.getByTestId('todo-summary');
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('todo-list-scroll')).toBeInTheDocument();
    // 列表三项齐全（TodoSection 纯列表渲染）
    expect(screen.getByText('1. 条目1')).toBeInTheDocument();
    expect(screen.getByText('2. 条目2')).toBeInTheDocument();
    expect(screen.getByText('3. 条目3')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('todo-summary'));
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('todo-list-scroll')).not.toBeInTheDocument();
  });

  // --- Task 1：活清单替换 ---

  it('活清单替换：新一轮流式清单成为摘要，终态后停留为最新；展开选择跨替换保持', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(5, 5), 'done')]]);
    const { unmount } = render(<SessionTodoBar />);
    expect(summaryProgress()).toBe('5/5');
    // 用户展开——替换后应保持展开（spec §3「展开选择跨替换保持」）
    fireEvent.click(screen.getByTestId('todo-summary'));
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'true');
    // 新一轮开始（m2 streaming）——流式优先
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
    expect(summaryProgress()).toBe('0/3');
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'true'); // 保持
    // m2 结束——停留为最新活清单（不回退 m1），展开仍保持
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(5, 5), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 3), 'done')],
        ]),
      });
    });
    expect(summaryProgress()).toBe('3/3');
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'true');
    unmount();
  });

  it('单候选无历史按钮', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    expect(screen.queryByRole('button', { name: '历史待办' })).not.toBeInTheDocument();
  });

  // --- Task 1：v1 生命周期回归 ---

  it('✕ 关闭后隐藏；同一候选流式更新不重现；增员才重现', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 0), 'streaming')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' }));
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
    // 同候选流式更新（同 id，非增员）——保持隐藏
    act(() => {
      useStreamStore.setState({
        streams: new Map([['m1', mkStream('m1', mkTodos(2, 1), 'streaming')]]),
      });
    });
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
    // 新候选增员——重现且摘要为新清单（活清单替换）
    act(() => {
      useSessionStore.setState({
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws'), mkMessage('m2', '@a:ws')]],
        ]),
      });
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(2, 1), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 0), 'streaming')],
        ]),
      });
    });
    expect(screen.getByTestId('session-todo-bar')).toBeInTheDocument();
    expect(summaryProgress()).toBe('0/3');
  });

  it('切换会话：dismissed / expanded / 历史查看全部重置，显示新会话候选', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByTestId('todo-summary')); // 展开
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' }));
    // 切到 s2（自带候选）——关闭与展开状态不跨会话
    act(() => {
      useSessionStore.setState({
        activeSessionId: 's2',
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws')]],
          ['s2', [mkMessage('m-s2', '@c:ws')]],
        ]),
      });
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(2, 1), 'done')],
          ['m-s2', mkStream('m-s2', mkTodos(1, 0), 'streaming')],
        ]),
      });
    });
    expect(screen.getByTestId('session-todo-bar')).toBeInTheDocument();
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
    expect(summaryProgress()).toBe('0/1');
  });

  // --- Task 2：页签仅多流式 + 固定语义 ---

  /** 双候选夹具：m1（3 项完成 2）+ m2（3 项完成 1），状态可覆写 */
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

  function activeTabProgress(): string | null {
    const tabs = screen.getAllByRole('tab');
    const activeTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    const m = activeTab?.textContent?.match(/(\d+\/\d+)/);
    return m?.[1] ?? null;
  }

  it('全终态：无页签，显示最新候选摘要（页签堆积痛点锁）', () => {
    setupTwo('done', 'done');
    render(<SessionTodoBar />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(summaryProgress()).toBe('1/3'); // m2 最新
  });

  it('单流式：无页签，流式候选成为摘要（自动跟随保留）', () => {
    setupTwo('done', 'streaming');
    render(<SessionTodoBar />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(summaryProgress()).toBe('1/3'); // m2 流式优先于 m1 历史
  });

  it('双流式：页签出现，自动跟随最后一个流式候选', () => {
    setupTwo('streaming', 'streaming');
    render(<SessionTodoBar />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(activeTabProgress()).toBe('1/3');
  });

  it('点击页签固定：另一流式更新不抢；固定流转终态解除，跟随剩余流式', () => {
    setupTwo('streaming', 'streaming');
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('tab', { name: /2\/3/ })); // 固定 m1
    expect(activeTabProgress()).toBe('2/3');
    // m2 仍流式——固定不抢
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 2), 'streaming')],
          ['m2', mkStream('m2', mkTodos(3, 2), 'streaming')],
        ]),
      });
    });
    expect(activeTabProgress()).toBe('2/3');
    // m1 → done：解除固定且页签消失（仅剩 m2 流式）→ 自动跟随 m2——改读摘要行
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 3), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 2), 'streaming')],
        ]),
      });
    });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(summaryProgress()).toBe('2/3'); // m2 的 2/3
  });

  it('嵌套按钮的 Enter 不触发摘要行展开切换（键盘守卫回归锁）', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    // 焦点在关闭按钮上按 Enter——事件冒泡到摘要行也不得切换展开
    fireEvent.keyDown(screen.getByRole('button', { name: '关闭会话任务条' }), { key: 'Enter' });
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
  });

  it('全部转终态：页签消失，回最新候选摘要', () => {
    setupTwo('streaming', 'streaming');
    render(<SessionTodoBar />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 3), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 3), 'done')],
        ]),
      });
    });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(summaryProgress()).toBe('3/3'); // m2 最新
  });

  // --- Task 3：历史下拉 + Ctrl+T ---

  it('历史下拉：多候选显示入口，点开列出非激活候选，点击临时查看快照', () => {
    setupTwo('done', 'done'); // active = m2（最新）
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '历史待办' }));
    const menu = screen.getByTestId('todo-history-menu');
    expect(menu).toBeInTheDocument();
    // 只列 m1（非激活），含进度（m1 = mkTodos(3,2) → 2/3）
    expect(menu.textContent).toContain('2/3');
    // 点击 m1 → 历史查看态：返回最新在场 + 列表展开显示 m1 快照
    fireEvent.click(within(menu).getByRole('button'));
    expect(screen.getByRole('button', { name: '返回最新' })).toBeInTheDocument();
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2. 条目2')).toBeInTheDocument(); // m1 快照（mkTodos(3,2) 进行中项）
  });

  it('返回最新：退出历史查看，回最新候选摘要', () => {
    setupTwo('done', 'done');
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '历史待办' }));
    fireEvent.click(within(screen.getByTestId('todo-history-menu')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: '返回最新' }));
    expect(screen.queryByRole('button', { name: '返回最新' })).not.toBeInTheDocument();
    expect(summaryProgress()).toBe('1/3'); // 回 m2
  });

  it('历史查看中候选增员：自动退出历史，显示新清单', () => {
    setupTwo('done', 'done');
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '历史待办' }));
    fireEvent.click(within(screen.getByTestId('todo-history-menu')).getByRole('button'));
    expect(screen.getByRole('button', { name: '返回最新' })).toBeInTheDocument();
    // 新候选 m3 增员 → 退出历史 + dismissed 清除路径同源
    act(() => {
      useSessionStore.setState({
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws'), mkMessage('m2', '@b:ws'), mkMessage('m3', '@a:ws')]],
        ]),
      });
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 2), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 1), 'done')],
          ['m3', mkStream('m3', mkTodos(2, 0), 'streaming')],
        ]),
      });
    });
    expect(screen.queryByRole('button', { name: '返回最新' })).not.toBeInTheDocument();
    expect(summaryProgress()).toBe('0/2'); // m3 流式
  });

  it('历史查看中新流式开始：自动退出历史', () => {
    setupTwo('done', 'done');
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '历史待办' }));
    fireEvent.click(within(screen.getByTestId('todo-history-menu')).getByRole('button'));
    // m2 开始流式（此前无流式 → 「新流式开始」）→ 退出历史
    act(() => {
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(3, 2), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 1), 'streaming')],
        ]),
      });
    });
    expect(screen.queryByRole('button', { name: '返回最新' })).not.toBeInTheDocument();
    expect(summaryProgress()).toBe('1/3');
  });

  it('Ctrl+T 切换展开（capture 拦截默认）', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
  });

  // --- 终审修复回归锁 ---

  it('Ctrl+T 在任务条隐藏时无效——增员重现后保持默认折叠', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' })); // 隐藏
    fireEvent.keyDown(window, { key: 't', ctrlKey: true }); // 隐藏态按 Ctrl+T——不得翻转
    // 增员重现——必须保持默认折叠
    act(() => {
      useSessionStore.setState({
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws'), mkMessage('m2', '@a:ws')]],
        ]),
      });
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(2, 1), 'done')],
          ['m2', mkStream('m2', mkTodos(3, 0), 'streaming')],
        ]),
      });
    });
    expect(screen.getByTestId('todo-summary')).toHaveAttribute('aria-expanded', 'false');
  });
});
