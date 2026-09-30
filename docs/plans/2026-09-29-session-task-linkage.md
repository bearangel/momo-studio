# 会话与任务联动优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 三项——G1 任务变更显示统一 ChangesChip 视觉、G2 任务双锚点定位到会话、G3 撤回确认框显式联动取消任务。

**Architecture:** 全部建在现有机制上（journal 账本按 taskId 聚合、`sourceSessionId`/`sourceMessageId`/`executionSessionId` 数据列、`TurnUndoDialog` 预检清单），无 schema 迁移。renderer 侧抽两个共享件（`JournalFileChangesList` 文件行渲染、`locate-message` 定位链路），electron 侧仅给 `listTasks` 加一个可选过滤参数。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React renderer（ESM + zustand + Tailwind 语义 token）、Vitest。

**Spec:** `docs/specs/2026-09-29-session-task-linkage-design.md`（本计划从 spec 出发，执行者须同时读两份）

## Global Constraints

- Node 20 LTS（容器默认 Node 26 会坏 better-sqlite3）：先 `nvm use 20`。
- 包管理一律 `npx pnpm@9.0.0`；测试命令 `cd <workspace> && npx pnpm@9.0.0 vitest run <file>`。
- TypeScript strict：**禁止** `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error`）。
- 所有代码注释中文；标识符英文。
- UI 只用语义 token（`text-secondary` / `bg-surface-2`…），禁标准 Tailwind 色阶与 inline 硬编码色；图标 lucide-react（chip 内 12px、分区头 16px，stroke 1.75）；禁 emoji。
- 测试位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 与组件同目录）。
- Conventional Commits：`feat:` / `refactor:` / `test:` / `chore:`。
- 版本号纪律：特性 commit 不动版本号；全部任务完成后统一 alpha +1（Task 9）。
- 写测试前先加载 skill `momo-test-rules`；改 IPC / 跨模块契约前加载 `momo-boundary-rules`（Task 1 涉及）。
- mock 必须仿真真实运行时（完整类型形状构造、`window.api` 桩 + ipc Proxy 透传模式），禁「方便测试」的简化 mock。

## Review Focus

执行者注意：以下五类输入/失败模式 spec 有语义要求但分散在各 task，最易踩坑。每行已标注归属 task 的测试锚点。

1. **sourceMessageIds 空数组**：SQLite `IN ()` 是语法错误 / 语义陷阱——空数组必须跳过条件返回全量（与不传等价），不能返回空集。→ Task 1 测试钉死。
2. **journal.list 挂载即查失败**（G1 摘要常显后从「展开才查」变「挂载即查」）：失败必须降级「无变更记录」+ console.warn，面板不得崩。→ Task 4 测试钉死。
3. **撤回后任务 sourceMessageId 悬空**：点「来源消息」定位到底找不到 → toast「消息不存在（可能已被撤回）」+ 返回 `message-missing`，不静默不崩。→ Task 6 测试钉死。
4. **进行中任务在撤回框被误取消**：`session_queued`/`in_progress`/`paused` 行无勾选框、确认后不调 `task.cancel`；取消失败的错误逐条呈现（对话已撤回的事实不回滚）。→ Task 8 测试钉死。
5. **定位锚点是非顶层行**（task_reply / dispatch 嵌套行被 MessageList 过滤，无 DOM 锚点）：降级为「已进入会话、不定锚」（返回 `entered`），不得报 toast 失败。→ Task 6 测试钉死（`revealMessage` 返回 false 分支 + `locateTaskExecution` fallback）。

---

### Task 1: electron `listTasks` 增加 `sourceMessageIds` 过滤（G3 数据面）

**Files:**
- Modify: `electron/src/main/storage/tasks/repo.ts`（listTasks，约 336-404 行）
- Modify: `electron/src/main/task/ipc.handlers.ts`（ListOpts 接口，约 72-83 行）
- Modify: `renderer/src/ipc/types.d.ts`（TaskApiSurface.list，约 255-265 行）
- Test: `electron/tests/storage/tasks-repo.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 现有 `listTasks(opts)` 多维过滤模式（where 数组动态拼条件）。
- Produces: `listTasks` opts 新增 `sourceMessageIds?: string[]`（in 查询；**空数组跳过条件**）；IPC 契约 `TaskApiSurface.list` 同名参数。Task 8 的 `ipc.task.list({workspaceId, sourceMessageIds})` 依赖此参数。

- [ ] **Step 1: 写失败测试**（追加到 `electron/tests/storage/tasks-repo.test.ts`，沿用文件既有的临时库 bootstrap；`insertTask` / `listTasks` 若未导入则补导入）

```typescript
describe('listTasks sourceMessageIds 过滤（会话任务联动 G3）', () => {
  it('按 source_message_id IN 精确命中', () => {
    insertTask({ workspaceId: 'ws-1', title: 'A', creatorUserId: 'owner', sourceSessionId: 'ses-1', sourceMessageId: 'm-1' });
    insertTask({ workspaceId: 'ws-1', title: 'B', creatorUserId: 'owner', sourceSessionId: 'ses-1', sourceMessageId: 'm-2' });
    insertTask({ workspaceId: 'ws-1', title: 'C', creatorUserId: 'owner' });
    const rows = listTasks({ workspaceId: 'ws-1', sourceMessageIds: ['m-1'] });
    expect(rows.map((r) => r.sourceMessageId)).toEqual(['m-1']);
  });

  it('空数组 → 跳过条件返回全量（不得变成空集——SQLite IN () 陷阱）', () => {
    insertTask({ workspaceId: 'ws-1', title: 'A', creatorUserId: 'owner', sourceMessageId: 'm-1' });
    insertTask({ workspaceId: 'ws-1', title: 'B', creatorUserId: 'owner' });
    expect(listTasks({ workspaceId: 'ws-1', sourceMessageIds: [] })).toHaveLength(2);
  });

  it('不传参数 → 行为不变（回归锁）', () => {
    insertTask({ workspaceId: 'ws-1', title: 'A', creatorUserId: 'owner', sourceMessageId: 'm-1' });
    expect(listTasks({ workspaceId: 'ws-1' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/tasks-repo.test.ts`
Expected: FAIL（类型错误：sourceMessageIds 不在 opts 类型上）

- [ ] **Step 3: 实现**——`repo.ts` listTasks 的 opts 类型加字段（`sourceSessionId?: string;` 之后）：

```typescript
  /** 按 source_message_id 集合过滤（会话任务联动 G3：撤回时命中受影响任务）；空数组跳过条件 */
  sourceMessageIds?: string[];
```

条件块（放在 `if (opts.sourceSessionId)` 块后）：

```typescript
  if (opts.sourceMessageIds !== undefined && opts.sourceMessageIds.length > 0) {
    const placeholders = opts.sourceMessageIds.map(() => '?').join(',');
    where.push(`source_message_id IN (${placeholders})`);
    params.push(...opts.sourceMessageIds);
  }
```

`ipc.handlers.ts` 的 `ListOpts` 接口加同一行字段（`sourceSessionId?: string;` 之后，注释同上）。handler 体是 `return listTasks(opts)` 直通，无需改。
`renderer/src/ipc/types.d.ts` 的 `TaskApiSurface.list` 入参加 `sourceMessageIds?: string[];`（`sourceSessionId?: string;` 之后）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/tasks-repo.test.ts`
Expected: PASS（新 3 例 + 既有全绿）

- [ ] **Step 5: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/storage/tasks/repo.ts electron/src/main/task/ipc.handlers.ts renderer/src/ipc/types.d.ts electron/tests/storage/tasks-repo.test.ts
git commit -m "feat: listTasks 支持 sourceMessageIds 集合过滤（会话任务联动数据面）"
```

---

### Task 2: 共享组件 `JournalFileChangesList`（G1）

**Files:**
- Create: `renderer/src/components/common/JournalFileChangesList.tsx`
- Test: `renderer/src/components/common/JournalFileChangesList.test.tsx`

**Interfaces:**
- Consumes: `groupByPath` / `DiffBlock` / `FileChangeGroup`（`common/JournalChangeViews.tsx` 既有导出，不搬动）。
- Produces: `JournalFileChangesList({ entries: JournalEntryView[]; testId?: string })`——**纯文件行渲染**（无摘要行；摘要计数由宿主头行承担）。Task 3 / Task 4 消费。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/common/JournalFileChangesList.test.tsx
//
// 共享文件行渲染件测试（G1）：逐文件行（rename 箭头 + 条数）+ 就地展开 DiffBlock。
// mock 形态照抄 ChangesChip.test（window.api 桩不需要——本组件无 IPC，纯展示）。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { JournalEntryView } from '../../ipc/types';
import { JournalFileChangesList } from './JournalFileChangesList';

function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'je-1', workspaceId: 'ws-1', taskId: null, sessionId: 'ses-1',
    streamSessionId: 's-1', toolName: 'write_file', path: 'src/app.ts', op: 'modify',
    beforeHash: 'hb', afterHash: 'ha', oldPath: null, createdAt: 1757000001000,
    beforeText: 'old-line', afterText: 'new-line', ...overrides,
  };
}

describe('JournalFileChangesList', () => {
  it('渲染逐文件行（路径 + 条数）；点开就地展开 DiffBlock', () => {
    render(<JournalFileChangesList entries={[makeEntry()]} />);
    const row = screen.getByRole('button', { name: /src\/app\.ts/ });
    expect(row).toHaveTextContent(/1 条/);
    fireEvent.click(row);
    expect(screen.getByTestId('changes-diff')).toBeInTheDocument();
  });

  it('rename 条目显示 old → new 箭头路径', () => {
    render(
      <JournalFileChangesList
        entries={[makeEntry({ op: 'rename', oldPath: 'src/old.ts', path: 'src/new.ts' })]}
      />,
    );
    expect(screen.getByRole('button', { name: /src\/old\.ts → src\/new\.ts/ })).toBeInTheDocument();
  });

  it('同 path 多条目合并单行「N 条」（groupByPath 语义）', () => {
    render(
      <JournalFileChangesList
        entries={[
          makeEntry({ id: 'je-1', createdAt: 1757000001000 }),
          makeEntry({ id: 'je-2', createdAt: 1757000002000 }),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toHaveTextContent(/2 条/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/common/JournalFileChangesList.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（FileRow 逐字取自 ChangesChip 现有实现，提取不重写）

```tsx
// renderer/src/components/common/JournalFileChangesList.tsx
//
// 变更账本共享文件行渲染件（G1 spec §3.2）：逐文件行（rename 显示 old → new +
// 条数）+ 就地展开 DiffBlock。摘要计数行由宿主头行承担（chip 折叠头 / 任务
// 分区头形态不同），本组件只负责文件行——防双份计数与多态 prop。
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { JournalEntryView } from '../../ipc/types';
import { DiffBlock, groupByPath, type FileChangeGroup } from './JournalChangeViews';

export interface JournalFileChangesListProps {
  entries: JournalEntryView[];
  /** 宿主专属 testid（文件清单容器） */
  testId?: string;
}

export function JournalFileChangesList({ entries, testId }: JournalFileChangesListProps) {
  const groups = groupByPath(entries);
  return (
    <div data-testid={testId}>
      <div className="space-y-1">
        {groups.map((g) => (
          <FileRow key={g.path} group={g} />
        ))}
      </div>
    </div>
  );
}

function FileRow({ group }: { group: FileChangeGroup }): JSX.Element {
  const [open, setOpen] = useState(false);
  const renameFrom = group.first.oldPath;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1 py-0.5 text-left font-mono text-[11px] text-primary hover:text-accent-500"
      >
        <span className="shrink-0 text-tertiary" aria-hidden>
          {open ? (
            <ChevronDown size={11} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={11} strokeWidth={1.75} />
          )}
        </span>
        <span className="truncate">
          {renameFrom !== null ? `${renameFrom} → ${group.path}` : group.path}
        </span>
        <span className="shrink-0 text-tertiary">{group.entries.length} 条</span>
      </button>
      {open && <DiffBlock beforeText={group.first.beforeText} afterText={group.last.afterText} />}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/common/JournalFileChangesList.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/common/JournalFileChangesList.tsx renderer/src/components/common/JournalFileChangesList.test.tsx
git commit -m "feat: 抽取 JournalFileChangesList 共享文件行渲染件"
```

---

### Task 3: `ChangesChip` 薄壳化（G1）

**Files:**
- Modify: `renderer/src/components/im/ChangesChip.tsx`
- Test: `renderer/src/components/im/ChangesChip.test.tsx`（既有 134 行，预期零修改保持绿）

**Interfaces:**
- Consumes: Task 2 的 `JournalFileChangesList`。
- Produces: ChangesChip 对外 props / 渲染形态不变（回归锁）。

- [ ] **Step 1: 先跑既有测试建立基线**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ChangesChip.test.tsx`
Expected: PASS（重构前基线全绿）

- [ ] **Step 2: 重构**——删除本地 `FileRow` 函数与 `groupByPath` 内联用法中的行渲染，展开体替换为共享组件：

```tsx
// 头部按钮行保持不变（含 entries.length / fileGroups.length 计数——仍需 groupByPath 计数）
import { JournalFileChangesList } from '../common/JournalFileChangesList';
// ...
  const fileGroups: FileChangeGroup[] = groupByPath(entries);
// ...头部 button 原样...
      {open && (
        <div className="space-y-1 border-t border-subtle px-2 py-1.5">
          <JournalFileChangesList entries={entries} />
        </div>
      )}
```

同时删除不再使用的本地 `FileRow`、`DiffBlock` / `ChevronDown` / `ChevronRight` 等孤儿 import（保留 `groupByPath` / `FileChangeGroup`——计数仍用；`FileDiff` 头部仍用）。

- [ ] **Step 3: 跑既有测试确认零回归**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ChangesChip.test.tsx`
Expected: PASS（全部既有用例）

- [ ] **Step 4: Commit**

```bash
git add renderer/src/components/im/ChangesChip.tsx
git commit -m "refactor: ChangesChip 文件行渲染收敛到 JournalFileChangesList 共享件"
```

---

### Task 4: `TaskChangesPanel` 摘要常显 + `TaskDetailPanel` 常驻挂载（G1）

**Files:**
- Modify: `renderer/src/components/task-board/TaskChangesPanel.tsx`（结构重写）
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`（移除 changesOpen 条件挂载与分区头按钮，66-68 行 + 331-351 行区域）
- Test: `renderer/src/components/task-board/TaskChangesPanel.test.tsx`（改写挂载/明细用例）

**Interfaces:**
- Consumes: Task 2 的 `JournalFileChangesList`；既有 `JournalRollbackSection`（props 不变：workspaceId / entries / onAfterRevert / testId / unjournaledPaths）。
- Produces: TaskChangesPanel 对外 props 不变（`{workspaceId, taskId}`）；新增 testid：`task-changes-toggle`（分区头，取代原 TaskDetailPanel 按钮）、`task-changes-summary`（计数文本）。**移除** testid `task-changes-detail-toggle`（明细常显后无此开关）。

- [ ] **Step 1: 改写测试**（TaskChangesPanel.test.tsx；mock 布局 / makeEntry / makeScan 不动，改用例语义）

改写点：
1. 「挂载并行懒查」用例 → **list 挂载即查、scan 展开才查**：

```typescript
  it('挂载即查 list（摘要常显）；scan 展开后才执行（懒执行保持）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(makeScan());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-9' }));
    expect(scanMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('task-changes-toggle'));
    await waitFor(() => expect(scanMock).toHaveBeenCalledWith('ws-1', 'task-9'));
  });
```

2. 「明细默认折叠」describe → **折叠态路径常显**（删掉 `task-changes-detail-toggle` 断言，文件行按钮直接可见）：

```typescript
  it('折叠态即常显文件路径行（摘要常显——无需展开分区）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByRole('button', { name: /src\/app\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /docs\/guide\.md/ })).toBeInTheDocument();
    // 回滚区默认不可见（展开才挂载）
    expect(screen.queryByTestId('task-changes-rollback-btn')).not.toBeInTheDocument();
  });
```

（「同 path 合并单行 2 条 + 净 diff」用例保留，去掉前置 toggle 点击。）
3. 分区头计数用例（新增）：

```typescript
  it('分区头右侧显示「N 处变更 · M 个文件」计数', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-summary')).toHaveTextContent('2 处变更 · 2 个文件');
  });
```

4. 空态用例：折叠头显示「无变更记录」（`task-changes-summary`）；展开后见指引文案。
5. 回滚流 describe 用例：主按钮前先 `fireEvent.click(screen.getByTestId('task-changes-toggle'))` 展开分区。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskChangesPanel.test.tsx`
Expected: FAIL（task-changes-toggle 不存在）

- [ ] **Step 3: 重写 TaskChangesPanel**（保留 refresh / 未入账区 / JournalRollbackSection 消费不动）：

```tsx
// 结构（关键代码——未入账区 JSX 原样保留，此处省略号处照抄现行实现）：
export function TaskChangesPanel({ workspaceId, taskId }: TaskChangesPanelProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [scan, setScan] = useState<JournalScanResult | null>(null);
  // 展开态：挂载回滚区 + 未入账区（scan 懒执行的触发位）
  const [open, setOpen] = useState(false);

  // journal.list 挂载即查（摘要常显）；失败降级空账面 + warn 留痕
  useEffect(() => {
    let cancelled = false;
    void ipc.journal
      .list({ workspaceId, taskId })
      .then((rows) => { if (!cancelled) setEntries(rows); })
      .catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.list 查询失败', err);
        if (!cancelled) setEntries([]);
      });
    return () => { cancelled = true; };
  }, [workspaceId, taskId]);

  // scan 仅展开后执行（2026-09-28 spec §5.5 懒执行语义保持）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void ipc.journal
      .scan(workspaceId, taskId)
      .then((r) => { if (!cancelled) setScan(r); })
      .catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 查询失败', err);
        if (!cancelled) setScan(null);
      });
    return () => { cancelled = true; };
  }, [open, workspaceId, taskId]);

  // 回滚后的幂等二次查询（撤回条目仍留账——对称记账）；scan 仅展开态刷新
  const refresh = async (): Promise<void> => {
    const rows = await ipc.journal.list({ workspaceId, taskId }).catch((err: unknown) => {
      console.warn('[TaskChangesPanel] journal.list 二次查询失败', err);
      return [] as JournalEntryView[];
    });
    setEntries(rows);
    if (open) {
      const scanResult = await ipc.journal.scan(workspaceId, taskId).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 二次查询失败', err);
        return null;
      });
      setScan(scanResult);
    }
  };

  if (entries === null) {
    return <div className="text-xs text-tertiary">变更与回滚加载中...</div>;
  }

  const unjournaled = scan?.unjournaled ?? [];
  const degraded = scan?.degraded ?? false;
  const fileCount = new Set(entries.map((e) => e.path)).size;
  const empty = entries.length === 0 && unjournaled.length === 0;

  return (
    <div className="mt-1" data-testid="task-changes-panel">
      {/* 分区头：标题 + 计数 + 展开箭头（自 TaskDetailPanel 移入） */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="task-changes-toggle"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded border border-strong bg-surface-3 px-2 py-1 text-left text-xs transition-colors"
      >
        <FileDiff size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
        <span className="text-primary">变更与回滚</span>
        <span className="ml-auto shrink-0 text-tertiary" data-testid="task-changes-summary">
          {empty ? '无变更记录' : `${entries.length} 处变更 · ${fileCount} 个文件`}
        </span>
        <span className="shrink-0 text-tertiary" aria-hidden>
          {open ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronRight size={16} strokeWidth={1.75} />}
        </span>
      </button>
      {/* 折叠态即常显：文件路径清单（可就地展开 diff） */}
      {entries.length > 0 && (
        <div className="mt-1 max-h-40 overflow-y-auto px-2 py-1">
          <JournalFileChangesList entries={entries} />
        </div>
      )}
      {/* 展开态：指引 / 回滚区 / 未入账区 */}
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {empty && (
            <div className="text-tertiary">
              会话内直接对话产生的变更不计入任务——请到对应会话头部的「回滚」入口操作
            </div>
          )}
          {entries.length > 0 && (
            <JournalRollbackSection
              workspaceId={workspaceId}
              entries={entries}
              onAfterRevert={refresh}
              testId="task-changes"
              unjournaledPaths={unjournaled}
            />
          )}
          {/* ……未入账区 JSX 原样照抄现行 173-202 行…… */}
        </div>
      )}
    </div>
  );
}
```

（import 调整：`FileDiff` 从 lucide-react 引入；`JournalFileChangesList` 引入；删除原 `detailOpen` / `openPaths` / `togglePath`。）

- [ ] **Step 4: TaskDetailPanel 去条件挂载**——删除 `changesOpen` state（66-68 行）与分区头按钮块（331-351 行），原位置替换为：

```tsx
        <div className="pt-1">
          <TaskChangesPanel workspaceId={task.workspaceId} taskId={taskId} />
        </div>
```

同步清理因此孤立的 import（`FileDiff` / `ChevronDown` / `ChevronRight` 若仅分区头使用则从 lucide-react import 列表删除——ESLint 会拦未用 import）。

- [ ] **Step 5: 跑测试确认通过**（含 TaskDetailPanel 既有测试——若其断言旧分区头按钮则同步修正）

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskChangesPanel.test.tsx src/components/task-board/TaskDetailPanel.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/task-board/TaskChangesPanel.tsx renderer/src/components/task-board/TaskChangesPanel.test.tsx renderer/src/components/task-board/TaskDetailPanel.tsx
git commit -m "feat: 任务详情变更摘要常显（ChangesChip 同款视觉，journal 挂载即查 + scan 保持懒执行）"
```

---

### Task 5: 消息锚点归一 + `msg-flash` 共享（G2 基础设施）

**Files:**
- Create: `renderer/src/components/common/MessageFlash.tsx`
- Modify: `renderer/src/components/im/MessageList.tsx`（157-164 行 map 加锚点包装 + 挂 MessageFlashStyle）
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx`（135 行移除根节点 `id`）
- Modify: `renderer/src/components/im/TaskProgressButton.tsx`（todo-flash → flashElement）
- Test: `renderer/src/components/im/TaskProgressButton.test.tsx`（断言同步）

**Interfaces:**
- Produces: `MessageFlash.tsx` 导出 `MSG_FLASH_CLASS = 'msg-flash'`、`flashMessage(el: HTMLElement): void`（加 class + 2.4s 移除）、`MessageFlashStyle()` 组件（keyframes `<style>` 注入）。Task 6 消费 `flashMessage`。
- Produces: 全部顶层可见消息行有 DOM id `msg-<messageId>`（锚点从 AgentStreamBubble 移到 MessageList 包装 div——owner 静态气泡此前无锚点）。

- [ ] **Step 1: 更新 TaskProgressButton 测试断言**（todo-flash → msg-flash；其余不动）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TaskProgressButton.test.tsx`
Expected: FAIL（仍加 todo-flash）

- [ ] **Step 3: 实现**——新建 `MessageFlash.tsx`：

```tsx
// renderer/src/components/common/MessageFlash.tsx
//
// 消息定位闪烁共享件（G2 spec §4.2）：keyframes 组件内 <style> 注入（仓库惯例，
// 先例 AgentStreamBubble momo-stream-blink）+ flashMessage 工具。挂载于 MessageList
// （im 视图常驻）；TaskProgressButton 与 locate-message 共用同一视觉。
export const MSG_FLASH_CLASS = 'msg-flash';

/** 闪烁停留时长（ms）——0.8s × 3 次 */
const FLASH_MS = 2400;

export function flashMessage(el: HTMLElement): void {
  el.classList.add(MSG_FLASH_CLASS);
  window.setTimeout(() => el.classList.remove(MSG_FLASH_CLASS), FLASH_MS);
}

export function MessageFlashStyle() {
  return (
    <style>{`
@keyframes momo-msg-flash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 2px rgb(var(--accent-500))}}
.msg-flash{animation:momo-msg-flash .8s ease-in-out 3}
    `}</style>
  );
}
```

MessageList map 处（157-164 行）改为：

```tsx
      <MessageFlashStyle />
      {visibleMessages.map((msg) => (
        <div key={msg.id} id={`msg-${msg.id}`}>
          <MessageBubble
            message={msg}
            isSelf={msg.sender === currentUserId}
            senderName={botNameByUserId.get(msg.sender)}
          />
        </div>
      ))}
```

AgentStreamBubble.tsx 135 行：删除根节点上的 `id={`msg-${message.id}`}`（防重复 id）。
TaskProgressButton.tsx：`locate()` 内两行 classList 操作替换为 `flashMessage(el)`；`<style>` 块删除 `.todo-flash` 规则与 `momo-todo-flash` keyframes（保留呼吸灯两条）；import `{ flashMessage }` from `'../common/MessageFlash'`。

- [ ] **Step 4: 跑受影响测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TaskProgressButton.test.tsx src/components/im/MessageList.test.tsx src/components/im/MessageList.autoscroll.test.tsx src/components/im/AgentStreamBubble.test.tsx 2>/dev/null || cd renderer && npx pnpm@9.0.0 vitest run src/components/im`
Expected: PASS（im 目录全绿——锚点包装 div 不改变 flex 列布局语义）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/common/MessageFlash.tsx renderer/src/components/im/MessageList.tsx renderer/src/components/im/AgentStreamBubble.tsx renderer/src/components/im/TaskProgressButton.tsx renderer/src/components/im/TaskProgressButton.test.tsx
git commit -m "refactor: 消息锚点归一到 MessageList 行包装 + msg-flash 闪烁共享件"
```

---

### Task 6: `locate-message` 定位链路（G2 核心）

**Files:**
- Create: `renderer/src/lib/locate-message.ts`
- Test: `renderer/src/lib/locate-message.test.ts`

**Interfaces:**
- Consumes: `flashMessage`（Task 5）；session.store 既有公开接口（`activeSessionId` / `selectSession` / `loadOlder` / `messagesBySession` / `hasMoreBySession`）；`useUiStore.setActiveView`；`showToast`。
- Produces（Task 7 消费）:
  - `type LocateResult = 'located' | 'entered' | 'message-missing'`
  - `locateMessage(sessionId: string, messageId: string | null): Promise<LocateResult>`
  - `locateTaskExecution(taskId: string, executionSessionId: string): Promise<LocateResult>`
  - `revealMessage(messageId: string): Promise<boolean>`
  - `isTopLevelMessage(msg: ImMessage): boolean`

- [ ] **Step 1: 写失败测试**（真实 store 模块 + setState 控制状态——不 mock store 模块本身；按 momo-test-rules，动作替换用 setState 覆写）

```typescript
// renderer/src/lib/locate-message.test.ts
//
// 定位链路测试（G2）：分页循环 / 悬空降级 / 非顶层行降级 / 执行会话锚点。
// store 用真实模块 + setState 覆写动作（selectSession/loadOlder 为 spy）；
// DOM 锚点用 jsdom 真实元素；scrollIntoView jsdom 未实现——prototype 桩。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionStore } from '../stores/session.store';
import { useUiStore } from '../stores/ui.store';
import { locateMessage, locateTaskExecution, isTopLevelMessage } from './locate-message';
import type { ImMessage } from '../ipc/types';

function makeMsg(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-1', sessionId: 'ses-1', sender: 'owner', body: '', eventType: 'm.room.message',
    streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null,
    status: 'done', source: 'local', workspaceId: 'ws-1', taskId: null, contextJson: null,
    createdAt: 1, updatedAt: 1, ...overrides,
  };
}

let anchorEl: HTMLDivElement;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  anchorEl = document.createElement('div');
  anchorEl.id = 'msg-m-1';
  anchorEl.scrollIntoView = scrollIntoView;
  document.body.appendChild(anchorEl);
  // 最小 window.api 桩：session.store 顶层 import ipc client（Proxy 透传），
  // store 动作已被 setState 覆写不会真正触达 IPC——此桩仅保 import 期安全
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {};
  useUiStore.setState({ setActiveView: vi.fn() } as never);
});

afterEach(() => {
  anchorEl.remove();
});

describe('locateMessage', () => {
  it('已激活会话 + 消息已加载 → 直接定位（scrollIntoView + flash + 切 im 视图）', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg()]]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(useUiStore.getState().setActiveView).toHaveBeenCalledWith('im');
  });

  it('未激活会话 → 先 selectSession 再定位', async () => {
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map([['ses-1', [makeMsg()]]]),
      selectSession: vi.fn().mockImplementation(async () => {
        useSessionStore.setState({ activeSessionId: 'ses-1' } as never);
      }),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(useSessionStore.getState().selectSession).toHaveBeenCalledWith('ses-1');
  });

  it('消息不在已加载窗口 → loadOlder 循环直到命中', async () => {
    let olderLoaded = false;
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg({ id: 'm-new' })]]]),
      hasMoreBySession: new Map([['ses-1', true]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn().mockImplementation(async () => {
        if (olderLoaded) return;
        olderLoaded = true;
        useSessionStore.setState({
          messagesBySession: new Map([['ses-1', [makeMsg(), makeMsg({ id: 'm-new' })]]]),
        } as never);
      }),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(useSessionStore.getState().loadOlder).toHaveBeenCalled();
  });

  it('到底仍未见（悬空 sourceMessageId）→ toast + message-missing（撤回降级路径）', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg({ id: 'm-other' })]]]),
      hasMoreBySession: new Map([['ses-1', false]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-gone');
    expect(r).toBe('message-missing');
  });

  it('messageId null → 只切会话返回 entered', async () => {
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map(),
      selectSession: vi.fn().mockResolvedValue(undefined),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateMessage('ses-1', null)).toBe('entered');
  });
});

describe('locateTaskExecution', () => {
  it('锚点 = 已加载消息中 taskId 命中的最后一条顶层消息', async () => {
    document.getElementById('msg-m-t2')?.remove();
    const el2 = document.createElement('div');
    el2.id = 'msg-m-t2';
    el2.scrollIntoView = scrollIntoView;
    document.body.appendChild(el2);
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([
        ['ses-exec', [
          makeMsg({ id: 'm-t1', taskId: 'task-1', sender: 'agent' }),
          makeMsg({ id: 'm-t2', taskId: 'task-1', sender: 'agent' }),
        ]],
      ]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateTaskExecution('task-1', 'ses-exec');
    expect(r).toBe('located');
    expect(scrollIntoView).toHaveBeenCalled();
    el2.remove();
  });

  it('命中行是非顶层（task_reply 被过滤）→ 降级 entered，不 toast 失败', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([
        ['ses-exec', [makeMsg({ id: 'm-tr', taskId: 'task-1', eventType: 'io.momo-studio.task_reply' })]],
      ]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateTaskExecution('task-1', 'ses-exec')).toBe('entered');
  });

  it('无 taskId 命中 → 只切会话 entered', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([['ses-exec', [makeMsg({ id: 'm-x' })]]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateTaskExecution('task-1', 'ses-exec')).toBe('entered');
  });
});

describe('isTopLevelMessage', () => {
  it('dispatch / task_reply / 嵌套行 / 分段行 → false；普通行 → true', () => {
    expect(isTopLevelMessage(makeMsg())).toBe(true);
    expect(isTopLevelMessage(makeMsg({ eventType: 'io.momo-studio.dispatch' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ eventType: 'io.momo-studio.task_reply' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ parentStreamSessionId: 's-1' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ segmentOf: 'm-0' }))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/locate-message.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// renderer/src/lib/locate-message.ts
//
// 任务双锚点定位链路（G2 spec §4.2）：
//   - locateMessage：来源消息定位——selectSession（如需）→ loadOlder 循环直到
//     命中或 hasMore=false（服务端权威终止；防御上限 50 批）→ revealMessage
//   - locateTaskExecution：执行会话定位——最新 taskId 命中必在首屏窗口（最新
//     消息语义），无需向历史翻页；无命中/非顶层行 → 只切会话
//   - revealMessage：切 im 视图 + 双 rAF 等 DOM 提交 + scrollIntoView + 闪烁
//   - isTopLevelMessage：MessageList 顶层渲染口径单源（两处消费防漂移）
// 悬空 sourceMessageId（撤回后硬删）→ toast 如实告知，返回 message-missing。
import { useSessionStore } from '../stores/session.store';
import { useUiStore } from '../stores/ui.store';
import { showToast } from '../components/ui/Toast';
import { flashMessage } from '../components/common/MessageFlash';
import type { ImMessage } from '../ipc/types';

export type LocateResult = 'located' | 'entered' | 'message-missing';

/** loadOlder 循环防御上限（批）——正常由服务端 hasMore 权威终止 */
const MAX_LOAD_OLDER_BATCHES = 50;

/** MessageList 顶层渲染口径（v1.4 嵌套过滤的单一真相源） */
export function isTopLevelMessage(msg: ImMessage): boolean {
  if (msg.eventType === 'io.momo-studio.dispatch') return false;
  if (msg.eventType === 'io.momo-studio.task_reply') return false;
  if (msg.parentStreamSessionId !== null) return false;
  if (msg.segmentOf !== null) return false;
  return true;
}

function nextFrame(): Promise<void> {
  // 双 rAF：先等 React commit 再查 DOM
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** 切 im 视图并滚动闪烁定位；DOM 行不存在（被过滤的嵌套/分段行）返回 false */
export async function revealMessage(messageId: string): Promise<boolean> {
  useUiStore.getState().setActiveView('im');
  await nextFrame();
  const el = document.getElementById(`msg-${messageId}`);
  if (el === null) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashMessage(el);
  return true;
}

/** 确保会话消息已入 store；失败 toast 并返回 null（调用方中止） */
async function ensureSession(sessionId: string): Promise<boolean> {
  if (useSessionStore.getState().activeSessionId === sessionId) return true;
  try {
    await useSessionStore.getState().selectSession(sessionId);
    return true;
  } catch (err) {
    showToast(`进入会话失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 来源消息定位（任务详情「来源消息」入口） */
export async function locateMessage(
  sessionId: string,
  messageId: string | null,
): Promise<LocateResult> {
  if (!(await ensureSession(sessionId))) return 'message-missing';
  if (messageId === null) {
    useUiStore.getState().setActiveView('im');
    return 'entered';
  }
  const find = (): boolean =>
    (useSessionStore.getState().messagesBySession.get(sessionId) ?? []).some(
      (m) => m.id === messageId,
    );
  let found = find();
  let batches = 0;
  while (
    !found &&
    useSessionStore.getState().hasMoreBySession.get(sessionId) !== false &&
    batches < MAX_LOAD_OLDER_BATCHES
  ) {
    await useSessionStore.getState().loadOlder(sessionId);
    batches += 1;
    found = find();
  }
  if (!found) {
    useUiStore.getState().setActiveView('im');
    showToast('定位失败：消息不存在（可能已被撤回）');
    return 'message-missing';
  }
  return (await revealMessage(messageId)) ? 'located' : 'entered';
}

/** 执行会话定位（任务详情「进入执行会话」入口，全状态可用） */
export async function locateTaskExecution(
  taskId: string,
  executionSessionId: string,
): Promise<LocateResult> {
  if (!(await ensureSession(executionSessionId))) return 'message-missing';
  const msgs =
    useSessionStore.getState().messagesBySession.get(executionSessionId) ?? [];
  // 最新命中必在首屏窗口（最新消息语义），不做历史翻页
  const anchor = [...msgs].reverse().find((m) => isTopLevelMessage(m) && m.taskId === taskId);
  if (anchor === undefined) {
    useUiStore.getState().setActiveView('im');
    return 'entered';
  }
  return (await revealMessage(anchor.id)) ? 'located' : 'entered';
}
```

注意：`useSessionStore.setState({...} as never)` 的测试写法若与 store 类型冲突，改用 `useSessionStore.setState({ ... } as Partial<typeof useSessionStore.getState()>)` 形式对齐仓库既有测试（session.store.test.ts 先例）——**不允许** `as any`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/locate-message.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/locate-message.ts renderer/src/lib/locate-message.test.ts
git commit -m "feat: locate-message 双锚点定位链路（分页循环 + 悬空/非顶层降级）"
```

---

### Task 7: `TaskDetailPanel` 双锚点入口（G2 UI）

**Files:**
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`
- Test: `renderer/src/components/task-board/TaskDetailPanel.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `locateMessage` / `locateTaskExecution`。
- Produces: UI 入口（信息网格「来源消息」行 + 底部「进入执行会话」全状态可见）。

- [ ] **Step 1: 改写测试**——文件顶部 vi.mock 区追加：

```typescript
const { locateMessageMock, locateTaskExecutionMock } = vi.hoisted(() => ({
  locateMessageMock: vi.fn().mockResolvedValue('located'),
  locateTaskExecutionMock: vi.fn().mockResolvedValue('located'),
}));
vi.mock('../../lib/locate-message', () => ({
  locateMessage: locateMessageMock,
  locateTaskExecution: locateTaskExecutionMock,
}));
```

「进入执行会话」describe 的 4 个既有用例改写（selectSession 顺序断言已移入 locate-message.test，此处只锁接线）：

```typescript
describe('TaskDetailPanel 进入执行会话（全状态 + 定位接线）', () => {
  it('executionSessionId 存在时渲染跳转按钮（含终态 completed）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'completed' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('进入执行会话 →')).toBeInTheDocument();
  });

  it('executionSessionId 缺失时不渲染跳转按钮', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'pending', executionSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('#task-1')).toBeInTheDocument();
    expect(screen.queryByText('进入执行会话 →')).not.toBeInTheDocument();
  });

  it('点击按钮 → locateTaskExecution(taskId, executionSessionId)', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-abc' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('进入执行会话 →'));
    await waitFor(() =>
      expect(locateTaskExecutionMock).toHaveBeenCalledWith('task-1', 'sess-abc'),
    );
  });
});

describe('TaskDetailPanel 来源消息入口', () => {
  it('sourceSessionId 存在 → 信息网格渲染「来源消息」行；点击 → locateMessage(来源会话, 消息 id)', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ sourceSessionId: 'ses-src', sourceMessageId: 'm-origin' }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('来源消息定位'));
    await waitFor(() => expect(locateMessageMock).toHaveBeenCalledWith('ses-src', 'm-origin'));
  });

  it('sourceSessionId null（手建任务）→ 不渲染来源行', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ sourceSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByText('来源消息定位')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskDetailPanel.test.tsx`
Expected: FAIL（来源消息入口不存在 / locateTaskExecution 未被调用）

- [ ] **Step 3: 实现**——TaskDetailPanel：

handler 替换（原 handleEnterSession 148-158 行删除）：

```typescript
  /** G2：执行会话定位（全状态可用——完结任务也能回看执行记录） */
  const handleEnterSession = (): void => {
    const sessionId = task.executionSessionId;
    if (sessionId === null) return;
    void locateTaskExecution(task.id, sessionId);
  };

  /** G2：来源消息定位（悬空时 locateMessage 内部 toast 降级） */
  const handleLocateSource = (): void => {
    if (task.sourceSessionId === null) return;
    void locateMessage(task.sourceSessionId, task.sourceMessageId);
  };
```

import 追加：`import { locateMessage, locateTaskExecution } from '../../lib/locate-message';`
底部按钮块条件改为全状态（原 352 行）：

```tsx
        {task.executionSessionId && (
          <button
            type="button"
            onClick={handleEnterSession}
            className="text-accent-600 hover:underline dark:text-accent-300"
          >
            进入执行会话 →
          </button>
        )}
```

信息网格（「母任务」块后）追加来源行——样式与母任务链接一致：

```tsx
          {task.sourceSessionId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">来源</span>
              <button
                type="button"
                onClick={handleLocateSource}
                className="text-left text-accent-600 hover:underline dark:text-accent-300"
              >
                来源消息定位
              </button>
            </div>
          )}
```

（「来源消息定位」为可访问名；后续 UX 打磨可换为会话标题——依赖 useTaskEntityNames 扩展，非本计划范围。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskDetailPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/task-board/TaskDetailPanel.tsx renderer/src/components/task-board/TaskDetailPanel.test.tsx
git commit -m "feat: 任务详情双锚点入口（来源消息定位 + 执行会话全状态回看）"
```

---

### Task 8: `TurnUndoDialog` 撤回联动取消（G3）

**Files:**
- Modify: `renderer/src/components/im/TurnUndoDialog.tsx`
- Test: `renderer/src/components/im/TurnUndoDialog.test.tsx`（**新建**——该组件此前零测试覆盖）

**Interfaces:**
- Consumes: Task 1 的 `ipc.task.list({workspaceId, sourceMessageIds})` 与既有 `ipc.task.cancel`；`taskStatusStyle`（`lib/task-status.ts`）；`cn`（`lib/cn`）。
- Produces: 确认阶段「关联任务」区块（testid `turn-undo-linked-tasks`；勾选框 testid `turn-undo-cancel-<taskId>`）。

- [ ] **Step 1: 写失败测试**（新建文件；真实 session.store + setState；window.api 桩照抄 TaskChangesPanel.test 模式）

```tsx
// renderer/src/components/im/TurnUndoDialog.test.tsx
//
// 撤回联动取消测试（G3 spec §5）：
//   - 预检并行 task.list({sourceMessageIds: turn.messageIds})
//   - 分层矩阵：未启动默认勾选 / 进行中无勾选框 / 终态灰显
//   - 确认序：journal.revert → session.deleteMessages → reload → task.cancel（勾选集）
//   - cancel 失败 → error phase 逐条呈现（对话已撤回事实保留）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ImMessage, TaskRow } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { TurnUndoDialog } from './TurnUndoDialog';

const taskListMock = vi.fn();
const taskCancelMock = vi.fn();
const journalListMock = vi.fn();
const journalPreviewMock = vi.fn();
const journalRevertMock = vi.fn();
const deleteMessagesMock = vi.fn();
const getMessagesMock = vi.fn();

const mockApi = {
  task: { list: taskListMock, cancel: taskCancelMock },
  journal: { list: journalListMock, preview: journalPreviewMock, revert: journalRevertMock },
  session: { deleteMessages: deleteMessagesMock, getMessages: getMessagesMock },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeMsg(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-a', sessionId: 'ses-1', sender: 'owner', body: 'q', eventType: 'm.room.message',
    streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null,
    status: 'done', source: 'local', workspaceId: 'ws-1', taskId: null, contextJson: null,
    createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1', workspaceId: 'ws-1', title: '联动任务', description: '', status: 'draft',
    sourceSessionId: 'ses-1', sourceMessageId: 'm-a', creatorUserId: 'owner',
    executionSessionId: null, assigneeAgentId: null, targetTeamId: null, targetSessionId: null,
    recurrenceParentId: null, priority: 0, scheduledAt: null, recurrenceRule: null,
    deadlineAt: null, queuePosition: null, runtimeInstanceId: null, estimatedTokens: null,
    actualTokens: null, toolCallsUsed: 0, errorMessage: null, sourceNodeId: null,
    createdAt: 1, updatedAt: 1, startedAt: null, completedAt: null,
    groupId: null, boardPosition: null, archivedAt: null, ...overrides,
  };
}

/** 组装一轮对话：owner m-a + agent m-b（带 streamSessionId 供账本匹配） */
function seedTurn(): void {
  useSessionStore.setState({
    messagesBySession: new Map([
      ['ses-1', [makeMsg({ id: 'm-a' }), makeMsg({ id: 'm-b', sender: 'agent', streamSessionId: 's-1' })]],
    ]),
    reloadMessages: vi.fn().mockImplementation(async () => {}),
  } as never);
}

beforeEach(() => {
  taskListMock.mockReset().mockResolvedValue([]);
  taskCancelMock.mockReset().mockResolvedValue(undefined);
  journalListMock.mockReset().mockResolvedValue([]);
  journalPreviewMock.mockReset().mockResolvedValue([]);
  journalRevertMock.mockReset().mockResolvedValue([]);
  deleteMessagesMock.mockReset().mockResolvedValue({ deletedIds: [], affectedSessions: [] });
  getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
  seedTurn();
});

describe('TurnUndoDialog — 关联任务预检与分层', () => {
  it('预检调 task.list({workspaceId, sourceMessageIds: 组内全部消息 id})', async () => {
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-confirm');
    await waitFor(() =>
      expect(taskListMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        sourceMessageIds: ['m-a', 'm-b'],
      }),
    );
  });

  it('未启动任务（draft）默认勾选「撤回时一并取消」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    expect(await screen.findByTestId('turn-undo-linked-tasks')).toBeInTheDocument();
    expect(screen.getByTestId('turn-undo-cancel-task-1')).toBeChecked();
  });

  it('进行中任务无勾选框 + 明示「仍在执行，不会被自动取消」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'in_progress' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-linked-tasks');
    expect(screen.queryByTestId('turn-undo-cancel-task-1')).not.toBeInTheDocument();
    expect(screen.getByText('仍在执行，不会被自动取消')).toBeInTheDocument();
  });

  it('终态任务灰显「已结束，不受影响」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'completed' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-linked-tasks');
    expect(screen.queryByTestId('turn-undo-cancel-task-1')).not.toBeInTheDocument();
    expect(screen.getByText('已结束，不受影响')).toBeInTheDocument();
  });

  it('无关联任务 → 区块不渲染', async () => {
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-confirm');
    expect(screen.queryByTestId('turn-undo-linked-tasks')).not.toBeInTheDocument();
  });
});

describe('TurnUndoDialog — 确认执行联动', () => {
  it('确认 → deleteMessages 成功后 cancel 勾选任务；取消勾选的不 cancel', async () => {
    taskListMock.mockResolvedValue([
      makeTask({ id: 'task-1', status: 'draft' }),
      makeTask({ id: 'task-2', status: 'assigned' }),
    ]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    await waitFor(() => expect(deleteMessagesMock).toHaveBeenCalledWith('ses-1', ['m-a', 'm-b']));
    // 默认勾选语义：两个未启动任务都被取消
    await waitFor(() => expect(taskCancelMock).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(taskCancelMock).toHaveBeenCalledWith('task-2'));
  });

  it('取消勾选的任务不被 cancel', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('turn-undo-cancel-task-1'));
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    await waitFor(() => expect(deleteMessagesMock).toHaveBeenCalled());
    expect(taskCancelMock).not.toHaveBeenCalled();
  });

  it('cancel 失败 → error phase 逐条呈现（对话已撤回事实保留）', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    taskCancelMock.mockRejectedValue(new Error('状态机拒绝'));
    const onClose = vi.fn();
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    const err = await screen.findByTestId('turn-undo-error');
    expect(err).toHaveTextContent(/task-1/);
    expect(err).toHaveTextContent(/状态机拒绝/);
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TurnUndoDialog.test.tsx`
Expected: FAIL（区块 / cancel 逻辑不存在）

- [ ] **Step 3: 实现**——TurnUndoDialog.tsx：

import 追加：

```typescript
import { taskStatusStyle } from '../../lib/task-status';
import { cn } from '../../lib/cn';
import type { TaskRow, TaskStatus } from '../../ipc/types';
```

模块级常量（组件外）：

```typescript
/** 未启动三态：撤回时可勾选一并取消（G3 spec §5.3 分层） */
const NOT_STARTED_STATUSES = new Set<TaskStatus>(['draft', 'pending', 'assigned']);
/** 进行中三态：不提供勾选（打断性副作用，用户手动处置） */
const RUNNING_STATUSES = new Set<TaskStatus>(['session_queued', 'in_progress', 'paused']);
```

state 追加（组件内）：

```typescript
  const [linkedTasks, setLinkedTasks] = useState<TaskRow[]>([]);
  const [cancelIds, setCancelIds] = useState<Set<string>>(new Set());
```

load() 内 `setTurn(seg)` 之后、journal 查询并行处追加：

```typescript
        // G3：并行预检受影响任务（sourceMessageId ∈ 组内消息 id）
        const tasks = await ipc.task.list({
          workspaceId,
          sourceMessageIds: seg.messageIds,
        });
        if (cancelled) return;
        setLinkedTasks(tasks);
        setCancelIds(
          new Set(tasks.filter((t) => NOT_STARTED_STATUSES.has(t.status)).map((t) => t.id)),
        );
```

confirm() 内 `await useSessionStore.getState().reloadMessages(sessionId);` 之后、`onClose();` 之前插入：

```typescript
      // G3：撤回成功后取消勾选任务（先撤后取消——反向会出现「任务取消了但对话
      // 没撤掉」的更脏状态）；失败逐条收集如实呈现，不回滚已撤回的对话
      const cancelFailures: string[] = [];
      for (const t of linkedTasks) {
        if (!cancelIds.has(t.id)) continue;
        try {
          await ipc.task.cancel(t.id);
        } catch (err) {
          cancelFailures.push(
            `#${t.id} ${t.title}（${err instanceof Error ? err.message : String(err)}）`,
          );
        }
      }
      if (cancelFailures.length > 0) {
        setPhase('error');
        setErrorText(
          `对话已撤回，但 ${cancelFailures.length} 个任务取消失败：${cancelFailures.join('；')}`,
        );
        return;
      }
```

确认阶段 JSX（`{hasChanges && previewOutcomes !== null && (...)}` 块后、按钮行前）插入：

```tsx
          {linkedTasks.length > 0 && (
            <div
              className="rounded border border-subtle px-2 py-1.5"
              data-testid="turn-undo-linked-tasks"
            >
              <div className="font-medium text-secondary">
                这组对话关联的任务（{linkedTasks.length}）
              </div>
              {linkedTasks.map((t) => {
                const st = taskStatusStyle(t.status);
                const notStarted = NOT_STARTED_STATUSES.has(t.status);
                const running = RUNNING_STATUSES.has(t.status);
                return (
                  <div key={t.id} className="flex items-center gap-1.5 py-0.5">
                    <span className={cn('shrink-0', st.className)}>{st.label}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-secondary">
                      #{t.id} {t.title}
                    </span>
                    {notStarted && (
                      <label className="ml-auto flex shrink-0 items-center gap-1 text-tertiary">
                        <input
                          type="checkbox"
                          checked={cancelIds.has(t.id)}
                          disabled={busy}
                          data-testid={`turn-undo-cancel-${t.id}`}
                          onChange={(e) =>
                            setCancelIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(t.id);
                              else next.delete(t.id);
                              return next;
                            })
                          }
                        />
                        撤回时一并取消
                      </label>
                    )}
                    {running && (
                      <span className="ml-auto shrink-0 text-tertiary">仍在执行，不会被自动取消</span>
                    )}
                    {!notStarted && !running && (
                      <span className="ml-auto shrink-0 text-tertiary">已结束，不受影响</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/TurnUndoDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/TurnUndoDialog.tsx renderer/src/components/im/TurnUndoDialog.test.tsx
git commit -m "feat: 撤回确认框联动取消未启动任务（分层展示 + 失败逐条呈现）"
```

---

### Task 9: 全量验证 + 版本 alpha +1 + CHANGELOG

**Files:**
- Modify: `package.json` / `electron/package.json` / `renderer/package.json`（alpha 号 +1）
- Modify: `CHANGELOG.md`（研发账本条目）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 全量类型检查**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error（两 workspace）

- [ ] **Step 2: 全量单测**

Run: `nvm use 20 && npx pnpm@9.0.0 test`
Expected: 全绿（本计划新增/改写用例 + 既有回归）

- [ ] **Step 3: 版本 alpha +1**——三处 `package.json` 的 `2.1.0-alpha.N` → `N+1`（先 `grep '"version"' package.json electron/package.json renderer/package.json` 确认当前 N）。

- [ ] **Step 4: CHANGELOG 研发账本条目**——按文件既有格式追加：会话与任务联动优化（G1 变更显示统一 / G2 双锚点定位 / G3 撤回联动取消），引用 spec 与本计划路径。

- [ ] **Step 5: Commit**

```bash
git add package.json electron/package.json renderer/package.json CHANGELOG.md
git commit -m "chore: 会话任务联动特性合入 alpha 号 +1 + CHANGELOG 账本"
```

---

## 执行注意事项

- Task 顺序依赖：1 独立；2 → 3 → 4（G1 链）；5 → 6 → 7（G2 链）；8 依赖 1。可并行推进 G1 链与 G2 链。
- Task 4 Step 3 中「未入账区 JSX 原样照抄」指现行 `TaskChangesPanel.tsx` 173-202 行——执行时以工作区实际文件为准逐字保留。
- 所有 `as never` / setState 覆写写法若触碰 ESLint 规则，以 `session.store.test.ts` / `TaskDetailPanel.test.tsx` 既有先例为准调整——**禁止** `as any`。
- e2e 不在本计划范围（现有 e2e 套件待重写，README 路线图已列）。
