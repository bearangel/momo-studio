# SessionTodoBar 交互改版（活清单 + 仅活跃页签 + 折叠限高）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 SessionTodoBar 两大体验痛点——长清单遮挡会话（默认折叠 + 限高滚动）、多轮页签堆积（活清单替换 + 仅活跃页签 + 历史下拉）。

**Architecture:** `TodoSection` 退化为纯列表渲染（摘要行/展开控制归 bar）；`SessionTodoBar` 重写编排（活清单推导、仅流式页签、`expanded`/`historyViewId`/`historyOpen` 新状态、`Ctrl+T`）。数据链路（stores/aggregator/IPC）零改动；`MiddlePanel` 挂载点不动。

**Tech Stack:** React 18 + TypeScript strict + zustand + @testing-library/react（vitest/jsdom）+ Tailwind 语义 token + lucide-react。

**Spec:** `docs/specs/2026-09-18-session-todo-bar-ux-refine-design.md`（唯一依据，实施前先读）

## Global Constraints

- **Node 20**：所有命令前 `nvm use 20`
- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；`noUncheckedIndexedAccess` 开启（数组/匹配索引注意 `?? null` 或非空断言配早退守卫）
- **UI v2.1**：语义 token only、lucide 图标（16px/stroke 1.75 基准，紧凑语境可用 11-14px）、无 emoji、无硬编码色（动态进度条宽度 `style={{ width: \`${pct}%\` }}` 属尺寸非颜色，允许）
- **注释中文**；测试贴源 colocated；**Conventional Commits；不动版本号**
- **测试保真度（momo-test-rules）**：真实 zustand store + `setState` 注入，不 vi.mock store 模块；断言真实渲染输出（aria 属性 / 文本 / testid）
- 单测：`cd renderer && npx pnpm@9.0.0 vitest run <path>`；全量：`npx pnpm@9.0.0 --filter momo-studio-renderer test`；类型：`npx pnpm@9.0.0 typecheck`
- **已核事实**：`Ctrl+T` 全仓库无冲突（无 `CmdOrCtrl+T` accelerator、无 ctrlKey+'t' 处理器），可放心绑定

## 现状基线（v1，commit ab44978）

- `SessionTodoBar.tsx`：候选=全部有 todos 的消息；页签 candidates>1 即现；自动跟随流式；✕/增员重现/切会话重置已实现并在测（12 用例）
- `TodoSection.tsx`：自带 header 折叠按钮 + `isStreaming` 自动展开语义（本次退役）
- 测试工厂已在 `SessionTodoBar.test.tsx`：`mkMessage` / `mkTodos(n, done)` / `mkStream(messageId, todos, status)` / `setStores(messages, streams, sessionId?)`

---

### Task 1: TodoSection 纯化 + SessionTodoBar v2 重写 + 核心用例

**Files:**
- Modify: `renderer/src/components/im/TodoSection.tsx`（纯列表化）
- Modify: `renderer/src/components/im/SessionTodoBar.tsx`（v2 完整重写——含页签/历史/快捷键，测试分任务锁）
- Test: `renderer/src/components/im/SessionTodoBar.test.tsx`（重写：删 v1 页签用例，建 v2 核心用例）
- Test: `renderer/src/components/im/TodoSection.test.tsx`（改纯列表契约）

**Interfaces:**
- Produces: `TodoSection({ todos }: { todos: TodoItem[] })`——纯列表，无展开语义；`SessionTodoBar()` 无 props（挂载不变）
- Task 2/3 只向 `SessionTodoBar.test.tsx` 追加用例，不再触碰组件

- [ ] **Step 1: 重写 SessionTodoBar.test.tsx（先红）**

整文件替换为：

```tsx
// renderer/src/components/im/SessionTodoBar.test.tsx
//
// SessionTodoBar v2 行为测试（spec 2026-09-18-session-todo-bar-ux-refine-design.md）：
//   Task 1 核心——默认折叠 / 摘要行内容 / 点击切换 / 活清单替换 / v1 生命周期回归
//   Task 2 页签——仅多流式出现 / 固定与解除 / 终态消失
//   Task 3 历史——下拉临时查看 / 自动退出 / Ctrl+T
//
// 测试模式：真实 zustand store + setState 注入（不 vi.mock store 模块）。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
    // 列表未渲染：条目文本不出现；无滚动容器
    expect(screen.queryByText(/条目\d/)).not.toBeInTheDocument();
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
});
```

- [ ] **Step 2: 重写 TodoSection.test.tsx（纯列表契约，先红）**

整文件替换为：

```tsx
// renderer/src/components/im/TodoSection.test.tsx
//
// TodoSection v2 契约：纯列表渲染（header/展开/自动展开语义已移至 SessionTodoBar，
// spec 2026-09-18-session-todo-bar-ux-refine-design.md §4）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TodoItem } from '../../ipc/types';
import { TodoSection } from './TodoSection';

const todos: TodoItem[] = [
  { id: 't1', subject: '已完成项', status: 'completed' },
  { id: 't2', subject: '进行中项', status: 'in_progress' },
  { id: 't3', subject: '待办项', status: 'pending' },
];

describe('TodoSection（纯列表，v2 契约）', () => {
  it('渲染全部条目（带序号）', () => {
    render(<TodoSection todos={todos} />);
    expect(screen.getByText('1. 已完成项')).toBeInTheDocument();
    expect(screen.getByText('2. 进行中项')).toBeInTheDocument();
    expect(screen.getByText('3. 待办项')).toBeInTheDocument();
  });

  it('完成态条目 line-through 弱化', () => {
    const { container } = render(<TodoSection todos={todos} />);
    const first = container.querySelector('li');
    expect(first).not.toBeNull();
    expect(first!.className).toContain('line-through');
  });

  it('进行中条目 accent 高亮', () => {
    const { container } = render(<TodoSection todos={todos} />);
    const items = container.querySelectorAll('li');
    expect(items[1]!.className).toContain('text-accent-600');
  });

  it('空数组返回 null', () => {
    const { container } = render(<TodoSection todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 3: 跑两个测试文件确认失败**

```bash
nvm use 20 && cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx src/components/im/TodoSection.test.tsx
```

Expected: 大面积 FAIL——旧组件 props/语义不匹配新断言。

- [ ] **Step 4: TodoSection 纯化**

`TodoSection.tsx` 整文件替换为：

```tsx
// renderer/src/components/im/TodoSection.tsx
//
// 待办清单纯列表渲染（v2 交互改版）：
//   v1 的 header 折叠按钮与 isStreaming 自动展开语义已移除——摘要行与展开
//   控制归 SessionTodoBar（spec 2026-09-18-session-todo-bar-ux-refine-design.md §4）。
//   本组件只负责：条目三态图标（Check/Play/Circle）、完成态 line-through、序号。
import { Check, Circle, Play } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
}

export function TodoSection({ todos }: Props) {
  if (todos.length === 0) return null;

  return (
    <ul className="m-0 list-none py-2">
      {todos.map((t, i) => {
        const Icon = t.status === 'completed' ? Check : t.status === 'in_progress' ? Play : Circle;
        return (
          <li
            key={t.id}
            className={cn(
              'flex gap-2',
              t.status === 'completed' ? 'line-through opacity-60' : '',
              t.status === 'in_progress'
                ? 'font-medium text-accent-600 dark:text-accent-300'
                : 'text-secondary',
              i === todos.length - 1 ? '' : 'mb-1',
            )}
          >
            <Icon size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              {i + 1}. {t.subject}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5: SessionTodoBar v2 重写（完整实现——页签/历史/快捷键一次落，Task 2/3 只补测试）**

`SessionTodoBar.tsx` 整文件替换为：

```tsx
// renderer/src/components/im/SessionTodoBar.tsx
//
// 会话底部常驻任务条 v2（spec 2026-09-18-session-todo-bar-ux-refine-design.md）：
//   - 活清单：默认显示最新一份候选（流式优先，新轮次 todowrite 直接替换）
//   - 默认折叠：摘要行 = 图标 + n/m + 进度条 + ▶ 当前进行项；点击或 Ctrl+T 切换；
//     展开列表 max-h 32vh 内部滚动；用户展开选择跨替换保持
//   - 页签仅当 ≥2 候选同时 streaming；点击固定，固定候选由流式转终态自动解除
//     （v1 prevPinnedStatusRef 语义保留）；全部转终态页签消失
//   - 历史 ▾：候选 >1 时出现；点击临时查看快照 + 返回最新；候选增员 / 新流式
//     开始 / 切会话自动退出历史查看
//   - ✕ 关闭：隐藏；候选增员才重现；切会话重置全部交互状态（v1 语义不变）
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, History, ListTodo, Play, X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore, type StreamState } from '../../stores/stream.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';
import { TodoSection } from './TodoSection';

/** 一个待办候选：消息 id + 发送者 + 流聚合状态 */
interface TodoCandidate {
  messageId: string;
  sender: string;
  stream: StreamState;
}

export function SessionTodoBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messagesBySession.get(activeSessionId) : undefined,
  );
  const streams = useStreamStore((s) => s.streams);
  const botNameMap = useBotNameMap();

  // v1 语义：手动固定（null=自动）与 ✕ 关闭
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // v2：默认折叠（跨候选替换保持）；历史临时查看；历史下拉开关
  const [expanded, setExpanded] = useState(false);
  const [historyViewId, setHistoryViewId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 候选集推导（时间序，含子 agent 消息）——与 v1 相同
  const candidates = useMemo<TodoCandidate[]>(() => {
    const list: TodoCandidate[] = [];
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue;
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        list.push({ messageId: msg.id, sender: msg.sender, stream });
      }
    }
    return list;
  }, [messages, streams]);

  const streamingCandidates = useMemo(
    () => candidates.filter((c) => c.stream.status === 'streaming'),
    [candidates],
  );
  // v2：仅多流式并行才出现页签
  const showTabs = streamingCandidates.length >= 2;

  const candidateIds = useMemo(() => candidates.map((c) => c.messageId).join(','), [candidates]);
  const streamingIds = useMemo(
    () => streamingCandidates.map((c) => c.messageId).join(','),
    [streamingCandidates],
  );

  // 固定候选「由流式转入终态」→ 解除固定（固定已完成历史候选不受影响——wasStreaming 守卫）
  const pinned = pinnedId !== null ? candidates.find((c) => c.messageId === pinnedId) : undefined;
  const prevPinnedStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pinned) {
      prevPinnedStatusRef.current = null;
      return;
    }
    const wasStreaming = prevPinnedStatusRef.current === 'streaming';
    if (wasStreaming && pinned.stream.status !== 'streaming') setPinnedId(null);
    prevPinnedStatusRef.current = pinned.stream.status;
  }, [pinned]);

  // 候选增员 → 清 dismissed（v1）+ 退出历史查看（v2 spec §3）
  const prevIdsRef = useRef<string>(candidateIds);
  useEffect(() => {
    const prev = new Set(prevIdsRef.current.split(',').filter(Boolean));
    const grew = candidateIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (grew) {
      setDismissed(false);
      setHistoryViewId(null);
    }
    prevIdsRef.current = candidateIds;
  }, [candidateIds]);

  // 新流式开始（出现此前不在流式集合中的候选）→ 退出历史查看（v2 spec §3）
  const prevStreamingIdsRef = useRef<string>(streamingIds);
  useEffect(() => {
    const prev = new Set(prevStreamingIdsRef.current.split(',').filter(Boolean));
    const anyNew = streamingIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (anyNew) setHistoryViewId(null);
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds]);

  // 切会话：全部交互状态重置（v2 在 v1 基础上加 expanded / historyViewId / historyOpen）
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      setPinnedId(null);
      setDismissed(false);
      setExpanded(false);
      setHistoryViewId(null);
      setHistoryOpen(false);
    }
  }, [activeSessionId]);

  // Ctrl+T 切换展开（已核实全仓库无快捷键冲突；capture 阶段拦截默认行为）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setExpanded((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  if (dismissed || candidates.length === 0) return null;

  // 激活候选：历史查看 > 固定 > 最后流式 > 最后候选（最新活清单）
  const historyView =
    historyViewId !== null ? candidates.find((c) => c.messageId === historyViewId) : undefined;
  const active: TodoCandidate =
    historyView ??
    pinned ??
    [...streamingCandidates].reverse()[0] ??
    candidates[candidates.length - 1]!;
  const isHistory = historyView !== undefined;

  const todos = active.stream.todos;
  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPct = Math.round((doneCount / totalCount) * 100);
  const currentSubject = todos.find((t) => t.status === 'in_progress')?.subject ?? null;

  const doneOf = (c: TodoCandidate): string => {
    const done = c.stream.todos.filter((t) => t.status === 'completed').length;
    return `${done}/${c.stream.todos.length}`;
  };

  return (
    <div className="border-t border-subtle bg-surface-1 px-3 py-1.5" data-testid="session-todo-bar">
      {/* 页签行：仅 ≥2 候选同时流式（v2——历史候选不再占位） */}
      {showTabs && (
        <div className="mb-1 flex flex-wrap gap-1" role="tablist" aria-label="活跃 agent 页签">
          {streamingCandidates.map((c) => {
            const isActive = c.messageId === active.messageId;
            return (
              <button
                key={c.messageId}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setPinnedId(c.messageId)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors',
                  isActive
                    ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                    : 'border border-subtle text-secondary hover:bg-surface-3 hover:text-primary',
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-hidden />
                {resolveBotName(c.sender, botNameMap)} {doneOf(c)}
              </button>
            );
          })}
        </div>
      )}

      {/* 摘要行：整行点击切换展开；历史/关闭按钮 stopPropagation */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="todo-summary"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          // 只处理摘要行自身的键盘事件——嵌套按钮（返回最新/历史待办/关闭）的
          // Enter/Space 必须走按钮原生激活，不能被这里吞掉（终审修订）
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex min-h-[26px] cursor-pointer items-center gap-2 text-xs"
      >
        {isHistory ? (
          <span className="flex flex-1 min-w-0 items-center gap-2 text-secondary">
            <History size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">
              正在查看历史 · {resolveBotName(active.sender, botNameMap)} {doneOf(active)}
            </span>
            <button
              type="button"
              aria-label="返回最新"
              onClick={(e) => {
                e.stopPropagation();
                setHistoryViewId(null);
              }}
              className="shrink-0 text-accent-600 hover:underline dark:text-accent-300"
            >
              返回最新
            </button>
          </span>
        ) : (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-primary">
              <ListTodo size={13} strokeWidth={1.75} aria-hidden />
              任务
              <span className="font-normal text-secondary">
                {doneCount}/{totalCount}
              </span>
            </span>
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span
                className="block h-full rounded-full bg-accent-500"
                style={{ width: `${progressPct}%` }}
              />
            </span>
            {currentSubject !== null && (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-secondary">
                <Play
                  size={11}
                  strokeWidth={1.75}
                  aria-hidden
                  className="shrink-0 text-accent-500"
                />
                <span className="truncate">{currentSubject}</span>
              </span>
            )}
            <span className="ml-auto shrink-0 text-tertiary" aria-hidden>
              {expanded ? (
                <ChevronDown size={12} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={12} strokeWidth={1.75} />
              )}
            </span>
          </>
        )}

        {candidates.length > 1 && (
          <button
            type="button"
            aria-label="历史待办"
            title="查看历史待办清单"
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen((v) => !v);
            }}
            className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
          >
            <History size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭会话任务条"
          title="关闭（新待办出现时自动恢复）"
          onClick={(e) => {
            e.stopPropagation();
            setDismissed(true);
          }}
          className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {/* 历史下拉：列出除当前激活外的全部候选（限高滚动） */}
      {historyOpen && (
        <div
          data-testid="todo-history-menu"
          className="mt-1 max-h-40 overflow-y-auto rounded border border-subtle bg-surface-2 py-1 text-xs"
        >
          {candidates
            .filter((c) => c.messageId !== active.messageId)
            .map((c) => (
              <button
                key={c.messageId}
                type="button"
                onClick={() => {
                  setHistoryViewId(c.messageId);
                  setExpanded(true);
                  setHistoryOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-secondary transition-colors hover:bg-surface-3 hover:text-primary"
              >
                <History size={11} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
                <span className="truncate">{resolveBotName(c.sender, botNameMap)}</span>
                <span className="ml-auto shrink-0 text-tertiary">{doneOf(c)}</span>
              </button>
            ))}
        </div>
      )}

      {/* 展开列表：限高内部滚动（v2 痛点 1 对症） */}
      {expanded && (
        <div className="max-h-[32vh] overflow-y-auto" data-testid="todo-list-scroll">
          <TodoSection todos={todos} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 跑两个测试文件确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx src/components/im/TodoSection.test.tsx
```

Expected: PASS——SessionTodoBar v2 核心 8 用例 + TodoSection 4 用例。

- [ ] **Step 7: 全量验证后提交**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
git add renderer/src/components/im/SessionTodoBar.tsx renderer/src/components/im/SessionTodoBar.test.tsx renderer/src/components/im/TodoSection.tsx renderer/src/components/im/TodoSection.test.tsx
git commit -m "feat: SessionTodoBar v2——活清单+折叠摘要+限高展开，TodoSection 纯列表化"
```

Expected: typecheck 0 error；renderer 全绿（AgentStreamBubble/SubAgentSection 反向断言不受影响——TodoSection 仍存在且仍被 bar 引用）。

---

### Task 2: 页签仅多流式 + 固定语义锁 + 摘要行键盘守卫（测试追加 + 一行组件修复）

**Files:**
- Modify: `renderer/src/components/im/SessionTodoBar.tsx`（仅一处：摘要行 `onKeyDown` 顶部加 `if (e.target !== e.currentTarget) return;` + 中文注释——Task 1 审查发现的 plan 缺陷修订，防嵌套按钮键盘激活被劫持）
- Modify: `renderer/src/components/im/SessionTodoBar.test.tsx`（追加用例）

**Interfaces:**
- Consumes: Task 1 测试工厂与 `summaryProgress()`
- Produces: 页签行为契约（仅 ≥2 流式出现 / 固定不抢 / 终态解除 / 全终态消失回最新）

- [ ] **Step 1: 追加用例**

在 describe 尾部追加：

```tsx
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
```

- [ ] **Step 2: 跑测试——键盘守卫用例应红（复现 plan 缺陷），其余应绿**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: 仅「嵌套按钮的 Enter 不触发摘要行展开切换」FAIL（Task 1 代码无守卫，Enter 冒泡切换了展开）；其余新用例绿（组件其余逻辑已在 Task 1 落全）。

- [ ] **Step 3: 应用一行守卫修复（组件）**

在 `SessionTodoBar.tsx` 摘要行 div 的 `onKeyDown` 处理器顶部（`if (e.key === 'Enter' ...)` 之前）加入：

```tsx
          // 只处理摘要行自身的键盘事件——嵌套按钮（返回最新/历史待办/关闭）的
          // Enter/Space 必须走按钮原生激活，不能被这里吞掉（Task 1 审查修订）
          if (e.target !== e.currentTarget) return;
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: PASS 14 用例（Task 1 的 8 + 本任务 6）。

- [ ] **Step 5: 提交（组件一行修复 + 测试）**

```bash
git add renderer/src/components/im/SessionTodoBar.tsx renderer/src/components/im/SessionTodoBar.test.tsx
git commit -m "fix: SessionTodoBar 摘要行键盘守卫——嵌套按钮 Enter 不再被劫持 + v2 页签语义锁"
```

---

### Task 3: 历史下拉瞬态查看 + Ctrl+T（测试追加 + 收尾验证）

**Files:**
- Modify: `renderer/src/components/im/SessionTodoBar.test.tsx`（追加用例）
- （组件已在 Task 1 落全；本任务结尾做全量收口）

**Interfaces:**
- Consumes: Task 1/2 工厂；组件 testid 契约（`todo-history-menu` / aria「历史待办」「返回最新」）
- Produces: 最终验收状态（全量 + typecheck）

- [ ] **Step 1: 追加用例**

在 describe 尾部追加：

```tsx
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
```

注意：用例用到了 `within`——在文件顶部 testing-library 导入行补上：

```tsx
import { render, screen, fireEvent, act, within } from '@testing-library/react';
```

- [ ] **Step 2: 跑测试**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: PASS 18 用例（8 + 5 + 5）。

- [ ] **Step 3: 收尾全量验证**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
```

Expected: typecheck 双 workspace 0 error；renderer 全绿。

- [ ] **Step 4: 提交**

```bash
git add renderer/src/components/im/SessionTodoBar.test.tsx
git commit -m "test: SessionTodoBar v2 历史下拉瞬态查看与 Ctrl+T 语义锁"
```

---

## 验收（对照 spec §9）

1. typecheck 双 workspace 0 error；renderer 全量全绿
2. 手工 GUI（macOS 主机 `pnpm dev`）：
   - 长清单（12 项）默认只占一行摘要，点击/Ctrl+T 展开、限高滚动
   - 多轮对话后无页签堆积，最新清单自动替换；「历史 ▾」可临时回看并自动退回
   - 并行子 agent 时页签出现、全部结束消失
