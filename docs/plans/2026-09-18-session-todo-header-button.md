# 会话头部任务按钮（TaskProgressButton）+ 气泡内联清单恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取代 v2 底条——待办清单恢复气泡内联（v1 语义），入口改为会话头部任务按钮（徽标 + 呼吸灯 + 浮层 + 定位）。

**Architecture:** `TodoSection`（v1 自包含折叠语义，内部用新的纯列表 `TodoList`）回挂 AgentStreamBubble / SubAgentSection；新增 `TaskProgressButton`（头部，导出旁）：目标 = 最新顶层含清单消息，浮层渲染 `TodoList`，「定位到消息」滚动 + 闪烁。删除 SessionTodoBar 及全部交互。数据链路零改动。

**Tech Stack:** React 18 + TypeScript strict + zustand + @testing-library/react（vitest/jsdom）+ Tailwind 语义 token + lucide-react。

**Spec:** `docs/specs/2026-09-18-session-todo-header-button-design.md`（唯一依据）

## Global Constraints

- **Node 20**：所有命令前 `nvm use 20`
- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；`noUncheckedIndexedAccess` 开启
- **UI v2.1**：语义 token only / lucide（16px / stroke 1.75 基准，紧凑语境 11-14px）/ 无 emoji / 无硬编码色（CSS 内引用 token 用 `rgb(var(--accent-500))` 形式，同 globals.css L170 既有用法）
- **动效模式（spec §4/§7 修正）**：keyframes 按仓库惯例以组件内 `<style>` 标签注入（先例 `AgentStreamBubble.tsx:249` momo-stream-blink），**不改 globals.css**
- **注释中文**；测试贴源 colocated；Conventional Commits；**不动版本号**
- **测试保真度（momo-test-rules）**：真实 zustand store + `setState` 注入，不 vi.mock store 模块；DOM 定位 mock（getElementById）只 mock 返回元素、scrollIntoView 为 spy
- 单测：`cd renderer && npx pnpm@9.0.0 vitest run <path>`；全量：`npx pnpm@9.0.0 --filter momo-studio-renderer test`；类型：`npx pnpm@9.0.0 typecheck`
- 预存环境项：`BrowserSidebar.test.tsx` 全量并行偶发 flake（与本特性无关，solo 复验即绿，勿动）

## 现状基线（v2 终态，commit 05e6a18）

- `TodoSection.tsx` = 纯列表（v2 形态，无 header/展开态）；`SessionTodoBar.tsx` 挂载于 MiddlePanel（L82 附近）
- `AgentStreamBubble.tsx` / `SubAgentSection.tsx` 无 TodoSection 渲染（v2 反向断言在测）
- 测试工厂参考：`SessionTodoBar.test.tsx` 的 `mkMessage` / `mkTodos` / `mkStream` / `setStores`（本任务 Task 2 将新建同型工厂，勿 import 已删文件）

---

### Task 1: 移除底条 + TodoList 拆分 + v1 TodoSection 恢复 + 气泡内联回归

**排序关键**：先删 SessionTodoBar（其 v2 测试与 TodoSection 纯列表契约耦合），再恢复 v1 TodoSection（必填 `isStreaming`）——顺序颠倒会打破类型与测试。中间态（删除后、恢复前）待办 UI 短暂完全消失，测试每步全绿，同一任务内闭合。

**Files:**
- Delete: `renderer/src/components/im/SessionTodoBar.tsx` + `SessionTodoBar.test.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（移除底条挂载与 import）
- Create（改名）: `renderer/src/components/im/TodoList.tsx`（现 TodoSection 纯列表改名）+ `TodoList.test.tsx`（4 用例改名迁移）
- Rewrite: `renderer/src/components/im/TodoSection.tsx`（v1 自包含版，内部用 TodoList）+ `TodoSection.test.tsx`（v1 用例恢复）
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx`（+测试：v2 反向断言改回 v1 正向）
- Modify: `renderer/src/components/im/SubAgentSection.tsx`（+测试：同上）

**Interfaces:**
- Produces: `TodoList({ todos }: { todos: TodoItem[] })`——纯列表（Task 2 浮层复用）；`TodoSection({ todos, isStreaming })`——v1 折叠语义（两气泡复用）

- [ ] **Step 1: 移除底条**

```bash
git rm renderer/src/components/im/SessionTodoBar.tsx renderer/src/components/im/SessionTodoBar.test.tsx
```

`MiddlePanel.tsx`：删除 `import { SessionTodoBar } from '../im/SessionTodoBar';` 与 im 分支中的 `<SessionTodoBar />` 行。跑全量确认绿（20 个底条用例随文件退出套件）：

```bash
nvm use 20 && npx pnpm@9.0.0 --filter momo-studio-renderer test
```

- [ ] **Step 2: 写失败测试**（内容如下，先跑红）

跑四个测试文件确认失败：

```bash
nvm use 20 && cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TodoList.test.tsx src/components/im/TodoSection.test.tsx src/components/im/AgentStreamBubble.test.tsx src/components/im/SubAgentSection.test.tsx
```

Expected: FAIL——TodoList 不存在；TodoSection 无 header（v1 断言红）；两气泡不渲染「任务」。

`TodoList.test.tsx`（新文件——从现 `TodoSection.test.tsx` 迁移 4 用例，组件名/文件头更新；`TodoList` 尚不存在，先红）：

```tsx
// renderer/src/components/im/TodoList.test.tsx
//
// TodoList 纯列表渲染契约（v3 拆分：条目渲染单源，TodoSection/TaskProgressButton 复用）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TodoItem } from '../../ipc/types';
import { TodoList } from './TodoList';

const todos: TodoItem[] = [
  { id: 't1', subject: '已完成项', status: 'completed' },
  { id: 't2', subject: '进行中项', status: 'in_progress' },
  { id: 't3', subject: '待办项', status: 'pending' },
];

describe('TodoList（纯列表）', () => {
  it('渲染全部条目（带序号）', () => {
    render(<TodoList todos={todos} />);
    expect(screen.getByText('1. 已完成项')).toBeInTheDocument();
    expect(screen.getByText('2. 进行中项')).toBeInTheDocument();
    expect(screen.getByText('3. 待办项')).toBeInTheDocument();
  });

  it('完成态条目 line-through 弱化', () => {
    const { container } = render(<TodoList todos={todos} />);
    const first = container.querySelector('li');
    expect(first).not.toBeNull();
    expect(first!.className).toContain('line-through');
  });

  it('进行中条目 accent 高亮', () => {
    const { container } = render(<TodoList todos={todos} />);
    const items = container.querySelectorAll('li');
    expect(items[1]!.className).toContain('text-accent-600');
  });

  it('空数组返回 null', () => {
    const { container } = render(<TodoList todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

`TodoSection.test.tsx` 整文件替换（v1 语义用例）：

```tsx
// renderer/src/components/im/TodoSection.test.tsx
//
// TodoSection v1 语义恢复（v3 回归气泡内联）：header 进度 / 流式自动展开 /
// 完成自动折叠 / 手动开合 / 空数组。条目渲染断言经 TodoList 透传。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TodoItem } from '../../ipc/types';
import { TodoSection } from './TodoSection';

const todos: TodoItem[] = [
  { id: 't1', subject: '条目一', status: 'completed' },
  { id: 't2', subject: '条目二', status: 'in_progress' },
];

describe('TodoSection（v1 折叠语义恢复）', () => {
  it('流式默认展开：header 进度 + 列表条目可见', () => {
    render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
  });

  it('非流式默认折叠：仅 header，条目不可见', () => {
    render(<TodoSection todos={todos} isStreaming={false} />);
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('流式转完成：自动折叠', () => {
    const { rerender } = render(<TodoSection todos={todos} isStreaming={true} />);
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
    rerender(<TodoSection todos={todos} isStreaming={false} />);
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('手动开合：点击 header 切换', () => {
    render(<TodoSection todos={todos} isStreaming={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('2. 条目二')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('2. 条目二')).not.toBeInTheDocument();
  });

  it('空数组返回 null', () => {
    const { container } = render(<TodoSection todos={[]} isStreaming={true} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

`AgentStreamBubble.test.tsx`：将 v2 反向用例（「stream 带 todos 也不渲染 TodoSection…」）替换为：

```tsx
  it('stream 带 todos 渲染气泡内联 TodoSection（v3 恢复）', () => {
    useStreamStore.setState({ streams: new Map() });
    render(
      <AgentStreamBubble
        stream={makeStream({
          todos: [
            { id: 't1', subject: '条目1', status: 'completed' },
            { id: 't2', subject: '条目2', status: 'in_progress' },
          ],
          text: '正文',
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('1/2（50%）')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });
```

`SubAgentSection.test.tsx`：将 v2 反向用例替换为（该文件工厂 `makeStream(overrides)`）：

```tsx
  it('stream 带 todos 渲染嵌套区内联 TodoSection（v3 恢复）', () => {
    render(
      <SubAgentSection
        stream={makeStream({
          todos: [
            { id: 't1', subject: '条目1', status: 'pending' },
            { id: 't2', subject: '条目2', status: 'in_progress' },
          ],
        })}
      />,
    );
    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('0/2（0%）')).toBeInTheDocument();
  });
```

- [ ] **Step 3: 实现拆分与恢复**

`git mv renderer/src/components/im/TodoSection.tsx renderer/src/components/im/TodoList.tsx`，然后整文件替换为（改名 + 内边距一行调整 + 头注释更新）：

```tsx
// renderer/src/components/im/TodoList.tsx
//
// 待办清单纯列表渲染（条目单源）：三态图标（Check/Play/Circle）、完成态
// line-through、序号。消费方：TodoSection（气泡内联，v1 折叠语义）与
// TaskProgressButton（头部浮层）。spec 2026-09-18-session-todo-header-button-design.md §4。
import { Check, Circle, Play } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
}

export function TodoList({ todos }: Props) {
  if (todos.length === 0) return null;

  return (
    <ul className="m-0 list-none px-2 py-2">
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

（测试文件同理 `git mv` 为 `TodoList.test.tsx` 并更新为 Step 2 内容。）

新建 `TodoSection.tsx`（v1 语义恢复——结构对齐 git 历史 `fbc84ff^` 版本，ul 部分换用 TodoList）：

```tsx
// renderer/src/components/im/TodoSection.tsx
//
// 待办清单折叠卡片（v1 语义恢复，v3 回归气泡内联）：流式默认展开、完成自动
// 折叠、手动开合；条目渲染单源 TodoList。spec §3.3。
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { TodoList } from './TodoList';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
  isStreaming: boolean;
}

export function TodoSection({ todos, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (!isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (todos.length === 0) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPct = Math.round((doneCount / totalCount) * 100);

  return (
    <div className="my-2 overflow-hidden rounded border border-subtle text-[13px]">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between bg-surface-2 px-3 py-1.5 cursor-pointer"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <ListTodo size={13} strokeWidth={1.75} aria-hidden />
          任务
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-tertiary">
          {doneCount}/{totalCount}（{progressPct}%）
          {expanded ? (
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
          )}
        </span>
      </button>
      {expanded && <TodoList todos={todos} />}
    </div>
  );
}
```

`AgentStreamBubble.tsx`：恢复 import（TodoSection 所在 import 区）与渲染块——`<MessageFrame …>` 打开标签后第一项：

```tsx
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}
```

`SubAgentSection.tsx`：同样恢复 import 与嵌套工作区首项渲染块（同上三行，`isStreaming` 取该文件局部变量）。

- [ ] **Step 4: 跑四个测试文件确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TodoList.test.tsx src/components/im/TodoSection.test.tsx src/components/im/AgentStreamBubble.test.tsx src/components/im/SubAgentSection.test.tsx
```

Expected: PASS（TodoList 4 + TodoSection 5 + 两气泡全量用例）。

- [ ] **Step 5: 全量验证 + 提交**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
git add renderer/src/components/im/TodoList.tsx renderer/src/components/im/TodoList.test.tsx renderer/src/components/im/TodoSection.tsx renderer/src/components/im/TodoSection.test.tsx renderer/src/components/im/AgentStreamBubble.tsx renderer/src/components/im/AgentStreamBubble.test.tsx renderer/src/components/im/SubAgentSection.tsx renderer/src/components/im/SubAgentSection.test.tsx
git commit -m "feat: 待办清单回气泡——TodoList 拆分单源与 v1 TodoSection 折叠语义恢复"
```

Expected: typecheck 0 error；renderer 全绿（底条已在本任务 Step 1 移除，无残留引用）。

---

### Task 2: TaskProgressButton 组件（徽标/呼吸灯/浮层/定位）

**Files:**
- Create: `renderer/src/components/im/TaskProgressButton.tsx`（+ 贴源测试）

**Interfaces:**
- Consumes: Task 1 的 `TodoList`；既有 stores 与 `useBotNameMap`/`resolveBotName`
- Produces: `TaskProgressButton({ sessionId }: { sessionId: string })`——Task 3 由 MiddlePanel 头部挂载

- [ ] **Step 1: 写失败测试**

```tsx
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

  it('会话切换 → 浮层收起且目标跟随新会话', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
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
      // s2 的目标必须有 stream——无 stream 则无清单目标，按钮隐藏（0/1 断言无从谈起）
      useStreamStore.setState({
        streams: new Map([
          ['m1', mkStream('m1', mkTodos(2, 1), 'done')],
          ['m-s2', mkStream('m-s2', mkTodos(1, 0), 'done')],
        ]),
      });
    });
    rerender(<TaskProgressButton sessionId="s2" />);
    expect(screen.queryByTestId('task-progress-popover')).not.toBeInTheDocument();
    // s2 目标：m-s2 需播种 stream（无 stream 则无目标，按钮隐藏——0/1 断言无从谈起）
    expect(screen.getByRole('button', { name: /查看会话任务/ }).textContent).toContain('0/1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TaskProgressButton.test.tsx
```

Expected: FAIL——组件不存在。

- [ ] **Step 3: 实现 TaskProgressButton**

```tsx
// renderer/src/components/im/TaskProgressButton.tsx
//
// 会话头部任务按钮（spec docs/specs/2026-09-18-session-todo-header-button-design.md）：
//   - 「导出会话」旁常驻；无顶层清单目标时整体隐藏（子 agent 清单不抢占）
//   - 徽标 n/m = 最新「顶层 + 非用户」含清单消息进度；呼吸灯 = 会话内任一
//     含待办流（含子 agent）streaming
//   - 点击弹浮层：目标清单（实时刷新）+「定位到消息」；Esc / 点外部 / 再点收起；
//     定位 = scrollIntoView + todo-flash 闪烁，浮层关闭
//   - 动效 keyframes 按仓库惯例组件内 <style> 注入（先例 momo-stream-blink）
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTodo, LocateFixed, X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore, type StreamState } from '../../stores/stream.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';
import { TodoList } from './TodoList';

interface Props {
  sessionId: string;
}

/** 按钮目标：最新顶层含清单消息 */
interface Target {
  messageId: string;
  sender: string;
  stream: StreamState;
}

/** 定位闪烁停留时长（ms）——0.8s × 3 次 */
const FLASH_MS = 2400;

export function TaskProgressButton({ sessionId }: Props) {
  const messages = useSessionStore((s) => s.messagesBySession.get(sessionId));
  const streams = useStreamStore((s) => s.streams);
  const botNameMap = useBotNameMap();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 目标 = 最新「顶层 + 非用户」含清单消息（子 agent 清单留在嵌套区，spec §5）
  const target = useMemo<Target | null>(() => {
    let found: Target | null = null;
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue;
      if (msg.parentStreamSessionId !== null) continue;
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        found = { messageId: msg.id, sender: msg.sender, stream };
      }
    }
    return found;
  }, [messages, streams]);

  // 呼吸灯 = 会话内任一含待办流 streaming（含子 agent）
  const anyRunning = useMemo(() => {
    for (const msg of messages ?? []) {
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0 && stream.status === 'streaming') return true;
    }
    return false;
  }, [messages, streams]);

  // 会话切换 → 收起浮层（spec §6）
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      setOpen(false);
    }
  }, [sessionId]);

  // Esc / 点外部收起（capture mousedown 覆盖浮层外任意按下）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick, true);
    };
  }, [open]);

  if (target === null) return null;

  const todos = target.stream.todos;
  const doneCount = todos.filter((t) => t.status === 'completed').length;

  /** 定位到目标气泡：滚动 + 闪烁，浮层收起 */
  const locate = (): void => {
    setOpen(false);
    const el = document.getElementById(`msg-${target.messageId}`);
    if (el === null) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('todo-flash');
    window.setTimeout(() => el.classList.remove('todo-flash'), FLASH_MS);
  };

  return (
    <div ref={rootRef} className="relative">
      {/* keyframes 组件内注入（仓库惯例，同 AgentStreamBubble momo-stream-blink） */}
      <style>{`
@keyframes momo-todo-breath{0%,100%{opacity:.3;transform:scale(.75)}50%{opacity:1;transform:scale(1.2)}}
@keyframes momo-todo-flash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 2px rgb(var(--accent-500))}}
.todo-breath-dot{display:inline-block;width:7px;height:7px;border-radius:9999px;animation:momo-todo-breath 1.6s ease-in-out infinite}
.todo-flash{animation:momo-todo-flash .8s ease-in-out 3}
      `}</style>
      <button
        type="button"
        aria-label="查看会话任务"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
          open
            ? 'bg-surface-active text-accent-600 dark:text-accent-300'
            : 'text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <ListTodo size={14} strokeWidth={1.75} aria-hidden />
        任务 {doneCount}/{todos.length}
        {anyRunning && <span className="todo-breath-dot bg-accent-500" aria-hidden />}
      </button>

      {open && (
        <div
          data-testid="task-progress-popover"
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-subtle bg-surface-1 p-2 shadow-2xl"
        >
          <div className="flex items-center justify-between px-1 pb-1 text-xs">
            <span className="font-medium text-primary">
              {resolveBotName(target.sender, botNameMap)} · 任务 {doneCount}/{todos.length}
            </span>
            <button
              type="button"
              aria-label="收起任务浮层"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-tertiary hover:text-primary"
            >
              <X size={13} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <div className="max-h-[32vh] overflow-y-auto">
            <TodoList todos={todos} />
          </div>
          <button
            type="button"
            onClick={locate}
            className="mt-1 inline-flex w-full items-center justify-end gap-1 px-1 text-xs text-accent-600 hover:underline dark:text-accent-300"
          >
            <LocateFixed size={12} strokeWidth={1.75} aria-hidden />
            定位到消息
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TaskProgressButton.test.tsx
```

Expected: PASS 9 用例（含会话切换 rerender 版；其 store 播种须含 s2 的 m-s2 stream）。

- [ ] **Step 5: 全量验证 + 提交**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
git add renderer/src/components/im/TaskProgressButton.tsx renderer/src/components/im/TaskProgressButton.test.tsx
git commit -m "feat: TaskProgressButton 会话头部任务按钮——徽标/呼吸灯/浮层/定位"
```

---

### Task 3: MiddlePanel 头部接线 + 消息锚点（收尾）

（SessionTodoBar 删除与底条挂载移除已在 Task 1 Step 1 完成——本任务只做按钮接线与锚点。）

**Files:**
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（头部接入按钮）
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx`（MessageFrame 加 `id="msg-{id}"` 锚点）
- Modify: `renderer/src/components/im/MessageFrame.tsx`（根元素透传可选 `id` prop——实施前先读该文件）

**Interfaces:**
- Consumes: Task 2 `TaskProgressButton({ sessionId })`
- Produces: 最终布局（头部按钮 + 气泡内联清单 + 无底条）

- [ ] **Step 1: 头部接入按钮**

`MiddlePanel.tsx` import 区加 `import { TaskProgressButton } from '../im/TaskProgressButton';`；im 分支头部行（`ExportChatButton` 之后）加：

```tsx
          {activeSessionId && <ExportChatButton sessionId={activeSessionId} />}
          {activeSessionId && <TaskProgressButton sessionId={activeSessionId} />}
```

- [ ] **Step 2: 消息滚动锚点**

先读 `MessageFrame.tsx`：给根元素加可选 `id?: string` prop 透传（机械改动）。`AgentStreamBubble.tsx` 的 `<MessageFrame …>` 调用加 `id={`msg-${message.id}`}`。

- [ ] **Step 3: 全量验证**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
```

Expected: typecheck 0 error；renderer 全绿。

- [ ] **Step 4: 提交**

```bash
git add renderer/src/components/layout/MiddlePanel.tsx renderer/src/components/im/MessageFrame.tsx renderer/src/components/im/AgentStreamBubble.tsx
git commit -m "feat: im 视图头部接入 TaskProgressButton——消息锚点支持定位到清单气泡"
```

---

## 验收（对照 spec §9）

1. typecheck 双 workspace 0 error；renderer 全量全绿
2. 手工 GUI（macOS 主机）：主 agent + 2 并行子 agent 同建清单——按钮徽标跟随主 agent、呼吸灯亮、浮层可看可「定位到消息」、子清单在嵌套区；无底条；多轮对话后各气泡保留各自清单（完成态折叠）
