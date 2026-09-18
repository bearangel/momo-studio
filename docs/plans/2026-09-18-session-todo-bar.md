# 会话底部常驻任务条（SessionTodoBar）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent 消息气泡里的 todowrite 待办列表（TodoSection）移到会话底部常驻任务条，多 agent 并行分页签 + 最新快照生命周期。

**Architecture:** 新增 `SessionTodoBar` 组件挂载在 im 视图 MessageList 与 InputToolbar 之间，从既有 `session.store`（messagesBySession）+ `stream.store`（streams Map）推导候选集，复用不动 `TodoSection` 渲染列表；`AgentStreamBubble` / `SubAgentSection` 移除 TodoSection 渲染。数据链路（stream-aggregator / IPC / 主进程）零改动。

**Tech Stack:** React 18 + TypeScript strict + zustand + @testing-library/react（vitest，jsdom）+ Tailwind 语义 token + lucide-react。

**Spec:** `docs/specs/2026-09-18-session-todo-bar-design.md`（本计划的唯一依据，实施前先读一遍）

## Global Constraints

- **Node 20**：所有 pnpm/vitest 命令前先 `nvm use 20`（容器默认 Node 26 会破坏 better-sqlite3）
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）
- **UI 设计系统 v2.1**：只用语义 token（`bg-surface-*` / `text-secondary` / `border-subtle`…），禁标准 Tailwind 色阶、禁 inline 硬编码颜色、禁 emoji 图标；图标一律 lucide-react，16px / stroke 1.75 基准
- **注释中文**，标识符英文
- **测试贴源 colocated**：`SessionTodoBar.test.tsx` 与组件同目录（`renderer/vitest.config.ts` 只 include `src/**/*.test.{ts,tsx}`）
- **Conventional Commits**：`feat:` / `refactor:` 等；**不动版本号**
- **测试保真度（momo-test-rules）**：不 mock 组件依赖的 zustand store 模块——用真实 store + `setState` 注入状态（仓库既有模式，见 `AgentStreamBubble.test.tsx`）；mock 只收窄到必要边界
- 单测命令（在 `renderer/` 目录）：`npx pnpm@9.0.0 vitest run <文件路径>`；全量：`npx pnpm@9.0.0 --filter momo-studio-renderer test`；类型：`npx pnpm@9.0.0 typecheck`

## 关键类型契约（实施用速查）

```ts
// renderer/src/ipc/types.d.ts
interface ImMessage {
  id: string; sessionId: string; sender: string; body: string; eventType: string;
  streamSessionId: string | null; parentStreamSessionId: string | null;
  segmentOf: string | null; segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix'; workspaceId: string | null;
  taskId: string | null; contextJson: string | null; createdAt: number; updatedAt: number;
}
interface TodoItem { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; source?: 'user' | 'agent'; }

// renderer/src/stores/stream.store.ts
interface StreamState {  // extends AggregatedStream
  thinking: string; text: string; toolCalls: unknown[]; todos: TodoItem[];
  dispatches: unknown[]; segments: StreamSegment[]; events: unknown[];
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  messageId: string; startedAt: number;
  streamSessionId?: string; botUserId?: string; parentStreamSessionId?: string;
}
// stream.store: { streams: Map<string /* messageId */, StreamState>, ... }
// session.store: { activeSessionId: string | null, messagesBySession: Map<string, ImMessage[]>, ... }
```

---

### Task 1: SessionTodoBar 组件——候选推导 + 单候选渲染

**Files:**
- Create: `renderer/src/components/im/SessionTodoBar.tsx`
- Test: `renderer/src/components/im/SessionTodoBar.test.tsx`

**Interfaces:**
- Consumes: `useSessionStore`（activeSessionId / messagesBySession）、`useStreamStore`（streams）、`useBotNameMap` / `resolveBotName`（`renderer/src/lib/useBotNames.ts`）、`TodoSection`（同目录，props `{ todos: TodoItem[]; isStreaming: boolean }`）
- Produces: `export function SessionTodoBar(): JSX.Element | null`——后续 Task 4 由 MiddlePanel 挂载，无 props

- [ ] **Step 1: 写失败测试（无候选 / 单候选 / 子 agent 消息也算候选）**

创建 `renderer/src/components/im/SessionTodoBar.test.tsx`：

```tsx
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
nvm use 20 && cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: FAIL——`Failed to resolve import "./SessionTodoBar"`（组件不存在）。

- [ ] **Step 3: 实现 SessionTodoBar（骨架版：候选推导 + 单候选渲染）**

创建 `renderer/src/components/im/SessionTodoBar.tsx`：

```tsx
// renderer/src/components/im/SessionTodoBar.tsx
//
// 会话底部常驻任务条（spec docs/specs/2026-09-18-session-todo-bar-design.md）：
//   - 候选集：当前会话 messagesBySession 中 streams.get(msg.id)?.todos.length > 0
//     的 agent 消息（含子 agent 消息——它们留在 store，只是不进顶层消息列表），按
//     数组序（时间序，loadOlder 头部插入）
//   - 单候选：无页签行，直接渲染 TodoSection；多候选：页签行（agent 名 + 各自进度）
//   - 激活页签：自动跟随最后一个 streaming 候选；无流式取最后候选（最新快照）；
//     手动点击固定，固定候选「由流式转入终态」后解除固定恢复自动跟随
//   - ✕ 手动关闭：隐藏；仅当候选集增员（新候选 id 出现）才重现
//   - 切换会话：pinned / dismissed 重置
//
// TodoSection 原样复用（流式展开 / 结束折叠 / 进度百分比）；key=messageId 切页签
// 时重挂载，展开态按新候选的 isStreaming 重新初始化。
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore, type StreamState } from '../../stores/stream.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';
import { TodoSection } from './TodoSection';
import type { TodoItem } from '../../ipc/types';

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

  // 手动固定：null=自动跟随；否则固定候选的 messageId
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // 手动关闭：仅候选集增员才清除（见 prevIdsRef effect）
  const [dismissed, setDismissed] = useState(false);

  // 候选集推导（时间序）
  const candidates = useMemo<TodoCandidate[]>(() => {
    const list: TodoCandidate[] = [];
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue; // 用户消息无流
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        list.push({ messageId: msg.id, sender: msg.sender, stream });
      }
    }
    return list;
  }, [messages, streams]);

  // 候选 id 逗号串——增员检测与重置判据的依赖项
  const candidateIds = useMemo(() => candidates.map((c) => c.messageId).join(','), [candidates]);

  // 固定候选「由流式转入终态」→ 解除固定（恢复自动跟随）。
  // 只在曾是 streaming 的固定被终结时解除——固定一个已完成的历史候选（回看）
  // 不受影响：prev 状态从 null 直接变 done，不满足 wasStreaming 条件。
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

  // 候选集增员 → 清除 dismissed（新消息的流获得 todos 才重现；
  // 同一候选流式更新不顶回）。mount 时 prevIdsRef 已初始化为当前值，不算增员。
  const prevIdsRef = useRef<string>(candidateIds);
  useEffect(() => {
    const prev = new Set(prevIdsRef.current.split(',').filter(Boolean));
    const grew = candidateIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (grew) setDismissed(false);
    prevIdsRef.current = candidateIds;
  }, [candidateIds]);

  // 切换会话：重置固定与关闭状态
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      setPinnedId(null);
      setDismissed(false);
    }
  }, [activeSessionId]);

  if (dismissed || candidates.length === 0) return null;

  // 激活候选：固定优先；否则自动跟随（最后一个流式 → 否则最后候选）
  const active: TodoCandidate =
    pinned ??
    [...candidates].reverse().find((c) => c.stream.status === 'streaming') ??
    candidates[candidates.length - 1]!;

  const doneOf = (c: TodoCandidate): string => {
    const done = c.stream.todos.filter((t) => t.status === 'completed').length;
    return `${done}/${c.stream.todos.length}`;
  };

  return (
    <div className="border-t border-subtle bg-surface-1 px-3 py-1.5" data-testid="session-todo-bar">
      <div className="flex min-h-[26px] items-center gap-2">
        {candidates.length > 1 ? (
          <div className="flex flex-1 flex-wrap gap-1" role="tablist" aria-label="会话任务页签">
            {candidates.map((c) => {
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
                  {c.stream.status === 'streaming' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-hidden />
                  )}
                  {resolveBotName(c.sender, botNameMap)} {doneOf(c)}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="flex-1 text-xs text-tertiary">
            {resolveBotName(active.sender, botNameMap)} · 待办
          </span>
        )}
        <button
          type="button"
          aria-label="关闭会话任务条"
          title="关闭（新待办出现时自动恢复）"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <TodoSection
        key={active.messageId}
        todos={active.stream.todos}
        isStreaming={active.stream.status === 'streaming'}
      />
    </div>
  );
}
```

注：骨架版即完整实现（页签/固定/关闭逻辑一次写全）——Task 2/3 只补对应测试用例。若想严格分步，可先只保留候选推导 + 单候选分支，Task 2/3 再补页签与生命周期；测试是任务的验收边界。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: PASS 3 个用例。

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/im/SessionTodoBar.tsx renderer/src/components/im/SessionTodoBar.test.tsx
git commit -m "feat: SessionTodoBar 会话底部任务条——候选推导与单候选渲染"
```

---

### Task 2: 多候选页签——自动跟随与手动固定

**Files:**
- Modify: `renderer/src/components/im/SessionTodoBar.test.tsx`（追加用例）
- （实现已在 Task 1 Step 3 一次写全；若分步实现，此处补页签/固定逻辑）

**Interfaces:**
- Consumes: Task 1 的 `SessionTodoBar` 与测试工厂 `mkMessage` / `mkStream` / `mkTodos` / `setStores`
- Produces: 页签交互行为契约（自动跟随 = 最后 streaming 候选；手动固定跨流式持续；固定候选终结即解除）——Task 3 依赖固定语义不变

- [ ] **Step 1: 追加失败测试（多候选 + 自动跟随 + 固定）**

在 `SessionTodoBar.test.tsx` 的 `describe` 内、Task 1 用例之后追加：

```tsx
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
    return m ? m[1] : null;
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
```

- [ ] **Step 2: 跑测试确认通过（实现已就位则直接绿；红则补实现）**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: PASS 9 个用例（Task 1 的 3 个 + 本任务 6 个）。若有红：对照 Task 1 Step 3 的实现补齐页签 / `pinnedId` / `prevPinnedStatusRef` 逻辑。

- [ ] **Step 3: 提交**

```bash
git add renderer/src/components/im/SessionTodoBar.test.tsx
git commit -m "test: SessionTodoBar 多 agent 页签用例——自动跟随与手动固定语义锁"
```

---

### Task 3: 生命周期——手动关闭、增员重现、切会话重置

**Files:**
- Modify: `renderer/src/components/im/SessionTodoBar.test.tsx`（追加用例）
- （实现已在 Task 1 Step 3 一次写全；若分步实现，此处补 dismissed / prevIdsRef / prevSessionRef 逻辑）

**Interfaces:**
- Consumes: Task 1 测试工厂；Task 2 的固定语义
- Produces: 生命周期行为契约——Task 4 挂载后即为最终用户可见行为

- [ ] **Step 1: 追加失败测试（关闭 / 增员 / 切会话）**

继续在 `describe` 内追加：

```tsx
  // --- Task 3：生命周期（✕ 关闭 / 增员重现 / 切会话重置）---

  it('✕ 关闭后隐藏；同一候选流式更新不重现', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 0), 'streaming')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' }));
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
    // m1 继续 todowrite 更新（同 id，非增员）——保持隐藏
    act(() => {
      useStreamStore.setState({
        streams: new Map([['m1', mkStream('m1', mkTodos(2, 1), 'streaming')]]),
      });
    });
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
  });

  it('候选增员（新消息的流获得 todos）→ 任务条重现', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' }));
    expect(screen.queryByTestId('session-todo-bar')).not.toBeInTheDocument();
    // 新消息 m2 的流获得 todos → 增员 → 重现（自动跟随无流式 → 最后候选 m2）
    act(() => {
      useSessionStore.setState({
        messagesBySession: new Map([
          ['s1', [mkMessage('m1', '@a:ws'), mkMessage('m2', '@b:ws')]],
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
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('切换会话：dismissed / pinned 重置，显示新会话候选', () => {
    setStores([mkMessage('m1', '@a:ws')], [['m1', mkStream('m1', mkTodos(2, 1), 'done')]]);
    render(<SessionTodoBar />);
    fireEvent.click(screen.getByRole('button', { name: '关闭会话任务条' })); // s1 关闭
    // 切到 s2（自带候选）——关闭状态不跨会话
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
    expect(screen.getByText('0/1（0%）')).toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SessionTodoBar.test.tsx
```

Expected: PASS 12 个用例（累计）。红则补 dismissed / `prevIdsRef` / `prevSessionRef` 逻辑（对照 Task 1 Step 3 实现）。

- [ ] **Step 3: 提交**

```bash
git add renderer/src/components/im/SessionTodoBar.test.tsx
git commit -m "test: SessionTodoBar 生命周期用例——关闭隐藏、增员重现、切会话重置"
```

---

### Task 4: 气泡移除 TodoSection + MiddlePanel 挂载（视觉切换）

**Files:**
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx:27,141-143`（删 import + 渲染块）
- Modify: `renderer/src/components/im/SubAgentSection.tsx:18,35-37`（删 import + 渲染块）
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（im 分支挂载）
- Test: `renderer/src/components/im/AgentStreamBubble.test.tsx`、`renderer/src/components/im/SubAgentSection.test.tsx`（各加反向断言）

**Interfaces:**
- Consumes: Task 1-3 的 `SessionTodoBar`（无 props，直接 `<SessionTodoBar />`）
- Produces: 最终用户可见布局——待办只在会话底部出现

- [ ] **Step 1: 写失败测试（todos 存在也不再渲染 TodoSection）**

在 `AgentStreamBubble.test.tsx` 的 `describe('AgentStreamBubble', ...)` 内追加（复用该文件既有的 `makeStream` / `makeMessage` 工厂）：

```tsx
  it('stream 带 todos 也不渲染 TodoSection（待办已移至会话底部 SessionTodoBar）', () => {
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
    // TodoSection 头部按钮文案是「任务」——气泡内不得出现
    expect(screen.queryByText('任务')).not.toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });
```

在 `SubAgentSection.test.tsx` 的 `describe('SubAgentSection — segments 时间线', ...)` 内追加（该文件工厂为 `makeStream(overrides: Partial<StreamState>)`，L12-26）：

```tsx
  it('stream 带 todos 也不渲染 TodoSection（待办已移至会话底部 SessionTodoBar）', () => {
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
    expect(screen.queryByText('任务')).not.toBeInTheDocument();
  });
```


- [ ] **Step 2: 跑两个测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/AgentStreamBubble.test.tsx src/components/im/SubAgentSection.test.tsx
```

Expected: FAIL——两个新用例红（`queryByText('任务')` 命中现有渲染）。

- [ ] **Step 3: 移除两处 TodoSection 渲染**

`AgentStreamBubble.tsx`：删除 L27 `import { TodoSection } from './TodoSection';` 与 L141-143 渲染块：

```tsx
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}
```

同时把 L128 注释中「/ todowrite 去冗余」的分段分组说明保留不动（分组逻辑不受影响）；顶部文件头注释若有「TodoSection」相关描述行则同步删除。

`SubAgentSection.tsx`：删除 L18 `import { TodoSection } from './TodoSection';` 与 L35-37 渲染块：

```tsx
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}
```

- [ ] **Step 4: 跑两个测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/AgentStreamBubble.test.tsx src/components/im/SubAgentSection.test.tsx
```

Expected: PASS（含新增反向断言与原有全部用例）。

- [ ] **Step 5: 提交（移除 = 一次原子视觉变更前半）**

```bash
git add renderer/src/components/im/AgentStreamBubble.tsx renderer/src/components/im/AgentStreamBubble.test.tsx renderer/src/components/im/SubAgentSection.tsx renderer/src/components/im/SubAgentSection.test.tsx
git commit -m "refactor: agent 气泡与子 agent 嵌套区移除 TodoSection 渲染——待办迁移至会话底部"
```

- [ ] **Step 6: MiddlePanel 挂载 SessionTodoBar**

`renderer/src/components/layout/MiddlePanel.tsx`：

import 区（`MessageList` 导入之后）加：

```tsx
import { SessionTodoBar } from '../im/SessionTodoBar';
```

im 分支中 `<MessageList />` 与 `<InputToolbar ... />` 之间插入一行：

```tsx
          <MessageList />
          <SessionTodoBar />
          <InputToolbar
```

- [ ] **Step 7: 全量验证**

```bash
npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-renderer test
```

Expected: typecheck 双 workspace 0 error；renderer 全部测试 PASS（含 MessageList / MessageBubble / DispatchChip 等相邻组件不受影响）。

- [ ] **Step 8: 提交（挂载 = 视觉切换后半）**

```bash
git add renderer/src/components/layout/MiddlePanel.tsx
git commit -m "feat: im 视图挂载 SessionTodoBar——待办列表常驻会话底部"
```

---

## 验收（对照 spec §10）

1. `npx pnpm@9.0.0 typecheck` 通过
2. `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全绿
3. 手工验收（`npx pnpm@9.0.0 dev`，需 GUI 环境）：
   - 单 agent 流式产生 todos → 底部条实时更新、回合结束自动折叠为完成态
   - leader 并行 dispatch 多个跑 todowrite 的子 agent → 页签出现、自动跟随流式者、点击可固定
   - ✕ 关闭后同流更新不重现、新 agent 产出 todos 重现
   - 切换会话 → 任务条跟随新会话各自状态
