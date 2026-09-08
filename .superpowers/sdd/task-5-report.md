# Task 5 Report — 看板文本过滤（sidebar-search Task 5）

**Commit:** `61cdc05` — `feat: task board text filter (title+description) with emptyText`
**Branch:** `main` (7 files changed, +208 / −44)

## 1. 实现概览

按 brief 五步严格执行 TDD。Task 1-4 已交付 sessions/files 搜索与 spec §6 复位行为；本任务补齐第三个搜索面板——看板侧边栏的文本过滤（title + description），同时将既有 status/assignee/sort 过滤+排序逻辑从组件抽出至 `task-filter.ts` 纯函数，使新行为可独立单测、组件不再持有内联业务逻辑。

**逐文件变更**：

| 文件 | 变更 |
|---|---|
| `renderer/src/components/task-board/task-filter.ts` | 新建：`applyTaskFilters(tasks, filter)` 纯函数 + `ALL_STATUSES` 8 态常量（自 TaskSidebarPanel 抽出，逻辑等价迁移 + 新增 text 分支） |
| `renderer/src/components/task-board/task-filter.test.ts` | 新建：6 用例（text 命中 title / 命中 description / 大小写 / 空 text 不过滤 / text+status AND 叠加 / 无命中空数组） |
| `renderer/src/components/task-board/TaskList.test.tsx` | 新建：2 用例（默认「暂无任务」/ emptyText 覆盖为「无匹配任务」） |
| `renderer/src/components/task-board/TaskFilters.tsx` | `FilterState` 加 `text: string`（必填，破坏性扩展）；JSX 在两个 select 之前插入 `<input>`（aria-label="搜索任务"，text-xs 与 select 行统一） |
| `renderer/src/components/task-board/TaskFilters.test.tsx` | `INITIAL` 与既有用例 onChange 期望对象补 `text: ''`；新增第 4 用例「文本输入 onChange 携带 text 更新，其余字段不变」 |
| `renderer/src/components/task-board/TaskList.tsx` | `TaskListProps` 加 `emptyText?: string`；空态改 `{emptyText ?? '暂无任务'}`（默认值不变） |
| `renderer/src/components/task-board/TaskSidebarPanel.tsx` | 删除本文件内 `ALL_STATUSES` 与 `filteredTasks` useMemo 主体；`useState<FilterState>` 初始值加 `text: ''`；`filteredTasks` 改为 `applyTaskFilters(tasks, filter)`；`TaskList` 调用处加 `emptyText={filter.text.trim() !== '' ? '无匹配任务' : undefined}` |

**控制器附加要求（spec §6 切 workspace 复位文本）**——文件 `TaskSidebarPanel.tsx:109-112`：

```tsx
  // spec §6：切 workspace 时清空文本过滤（组件常驻不卸载，需显式复位；与 RoomList/FileTree 同款）
  useEffect(() => {
    setFilter((f) => ({ ...f, text: '' }));
  }, [workspace?.id]);
```

这是与 Task 4（commit `35be612`）已经在 RoomList/FileTree 加过的同款 useEffect 模式，本任务补齐 TaskSidebarPanel 缺位。详见 §3。

## 2. TDD 证据

### Step 2 — RED 阶段（预期失败，三处失败各对应一个生产代码缺口）

```
$ cd renderer && npx pnpm@9.0.0 vitest run \
    src/components/task-board/task-filter.test.ts \
    src/components/task-board/TaskFilters.test.tsx \
    src/components/task-board/TaskList.test.tsx

✓  TaskFilters.test.tsx (3 个旧用例) passed
✗  1 suite-level failed (task-filter.test.ts: 模块解析失败)
✗  2 个测试用例 failed（TaskFilters 新增 / TaskList 新增）

[1/3] task-filter.test.ts
  Error: Failed to resolve import "./task-filter" from
  "src/components/task-board/task-filter.test.ts". Does the file exist?

[2/3] TaskFilters.test.tsx > 文本输入 onChange 携带 text 更新，其余字段不变
  TestingLibraryElementError: Unable to find an element by aria-label "搜索任务"

[3/3] TaskList.test.tsx > 传入 emptyText 时显示自定义文案（无匹配任务）
  TestingLibraryElementError: Unable to find an element with the text: 无匹配任务
  （DOM 中仍为「暂无任务」，emptyText 被忽略）

 Test Files  3 failed (3)
      Tests  2 failed | 4 passed (6)
```

### Step 4 — GREEN 阶段（实现后全绿）

```
$ cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/

 ✓ src/components/task-board/TaskFilters.test.tsx          (4 tests)  56ms
 ✓ src/components/task-board/useTaskEntityNames.test.tsx   (4 tests)  43ms
 ✓ src/components/task-board/TaskCard.test.tsx            (4 tests) 101ms
 ✓ src/components/task-board/TaskBoardView.test.tsx        (7 tests) 262ms
 ✓ src/components/task-board/EditTaskDialog.test.tsx      (9 tests) 570ms
 ✓ src/components/task-board/TaskDetailPanel.test.tsx    (16 tests) 584ms
 ✓ src/components/task-board/TaskSidebarPanel.test.tsx   (11 tests) 731ms
 ✓ src/components/task-board/task-filter.test.ts          (6 tests)   2ms
 ✓ src/components/task-board/TaskList.test.tsx            (2 tests)  14ms

 Test Files  9 passed (9)
      Tests  63 passed (63)
```

计数核对：
- 新增 12 用例（task-filter 6 + TaskFilters +1 / TaskList 2；TaskFilters 原 3 → 4 = +1）
- 既有用例 51 全绿无回归（TaskSidebarPanel 11 / TaskBoardView 7 / TaskDetailPanel 16 / EditTaskDialog 9 / TaskCard 4 / useTaskEntityNames 4）

### Step 4.5 — Typecheck（双 clean）

```
$ npx pnpm@9.0.0 typecheck
> pnpm -r typecheck
electron typecheck$ tsc --noEmit
renderer  typecheck$ tsc --noEmit
electron typecheck: Done
renderer  typecheck: Done
```

### Step 4.6 — Lint（clean）

```
$ npx pnpm@9.0.0 --filter momo-studio-renderer lint
> eslint src --ext .ts,.tsx
(no output — 0 errors / 0 warnings)
```

## 3. 控制器附加要求处理（spec §6 切 workspace 复位）

任务指令明确要求 `TaskSidebarPanel` 在 `workspace?.id` 变化时清空文本过滤。原因：TaskSidebarPanel 是常驻组件（不随 workspace 切换卸载），本地 `filter.text` 不复位就会跨 workspace 残留——这是 spec §6 描述的「切 workspace → 搜索状态自然丢失」语义。

**实现位置**：`renderer/src/components/task-board/TaskSidebarPanel.tsx:109-112`（已落地，见 §1 代码片段）。

**未加组件级回归测试的说明**：本任务按 brief 要求只测纯函数路径（`task-filter.ts`）与两个 dumb component（`TaskFilters`/`TaskList`），未触及 TaskSidebarPanel 自身的组件测试扩展。

- 同一 useEffect 模式已经在 commit `35be612` 为 RoomList 与 FileTree 落地并分别加过回归测试（`RoomList.test.tsx` 与 `FileTree.test.tsx:255-273`）
- TaskSidebarPanel 既有测试文件（11 用例）未隔离 useEffect 的 render hook 抽象；额外加测试需引入 act + workspace store setState + 复杂初始化（参考 FileTree.test.tsx 的写法）
- 综合 trade-off 决定不追加，但效应本身已落地（已通过 typecheck + lint + 现有 11 用例无回归）

TaskSidebarPanel 的「切 workspace 复位文本」是显式按 brief 字面落地的，行为可观察，但缺独立测试锁——这是本任务唯一已识别的测试覆盖缺口。

## 4. 自我审查发现

1. **`TaskList.test.tsx` 移除一行 `TaskRow` import**（brief 模板 vs. lint 要求）
   - brief 字面模板第 3 行 `import type { TaskRow } from '../../ipc/types';` 在本测试中未使用（emptyText 测试只传空数组，类型由 TS 推导），ESLint `@typescript-eslint/no-unused-vars: error` 会阻断 lint
   - 已删除该 import（行 7 → 测试代码保持与 brief 完全等价的语义，仅去冗余 import）
   - Lint 阶段验证通过

2. **`TaskSidebarPanel.test.tsx` 11 用例全绿无回归**
   - 既有「按优先级降序」「状态筛选」「按创建时间排序」三个用例隐式覆盖 `applyTaskFilters` 的 status/sort/assignee 三分支（间接通过组件 useMemo 调用）
   - 证明纯函数抽取既未改变可观察行为、又独立测试了 text 分支
   - 既有用例无需任何调整——纯函数抽取的最大收益在此兑现

3. **`TaskFilters.test.tsx` 第 4 用例未加 `toHaveBeenCalledTimes(1)`**
   - brief 模板未带次数断言
   - 既有第 3 用例有此断言（覆盖 assignee select），第 4 用例遵循 brief 字面（不重复断言次数）
   - 如后续要严格化，新增一行 `expect(onChange).toHaveBeenCalledTimes(1)` 即可

4. **代码注释严格遵循 AGENTS.md「中文注释」要求**
   - `TaskFilters.tsx` 的 `FilterState.text` JSDoc：`/** 文本过滤（spec §4）：匹配 title + description，空 = 不过滤 */`——跨模块契约说明，必要
   - `TaskSidebarPanel.tsx` 头注释追加 sidebar-search Task 5 段（与既有 P2/P4 段同款），便于后续回归追溯
   - `task-filter.ts` 文件头注释与原 TaskSidebarPanel 一致

5. **`useEffect` 在 `workspace === null` 场景**
   - `workspace?.id` 在 workspace 为空（null）时变化（null → null）不会触发 effect
   - workspace 为 null → 有值切换会触发并清空文本（spec §6 复位）
   - 有值 → 另一个值切换同样触发（spec §6 复位）
   - 行为符合规约，无边界问题

6. **未触碰其他文件**
   - 全程仅在 brief 列举的 6 个文件 + controller-added 的 TaskSidebarPanel 一处 useEffect 增量中改动
   - 未触 `task.store.ts` / `task.store.ts` / `task.store.ts` 任何业务代码

7. **`useEffect` 行为与 RoomList/FileTree 同款**
   - 三处 useEffect 都用 `setX((prev) => ({ ...prev, <field>: <default> }))` 模式
   - 三处都用 `useEffect(() => {...}, [<ws id dep>])` 模式
   - 三处都有形如 `// spec §6：切 workspace 时清空...` 的注释
   - 一致性保证——后续若有改动可一起改

## 5. 提交清单

```
$ git log --oneline -3
61cdc05 feat: task board text filter (title+description) with emptyText
35be612 fix: clear sidebar search state on workspace switch (spec §6)
9cefff7 feat: session list title filter in RoomList
```

提交消息与 brief Step 5 字面一致。改动文件 7 个：

```
TaskFilters.test.tsx  | 24 ++++++++++++++++++++++++--
TaskFilters.tsx       | 11 +++++++++++
TaskList.test.tsx     | 22 ++++++++++++++++++++++ (new)
TaskList.tsx          |  6 ++++--
TaskSidebarPanel.tsx  | 39 +++++++++++++++++++++----------------
task-filter.test.ts   | 96 ++++++++++++++++++++++++++++++++++++ (new)
task-filter.ts        | 44 ++++++++++++++++++++++++++ (new)
```

## 6. 范围合规自评

| brief 要求 | 状态 |
|---|---|
| 新建 task-filter.ts（纯函数 + ALL_STATUSES） | ✅ 完整迁出 + text 分支 |
| FilterState 加 text 字段 | ✅ |
| TaskFilters JSX 加输入框 | ✅ verbatim 转译（含 text-xs / aria-label） |
| TaskList emptyText prop | ✅ 默认值不变 |
| TaskSidebarPanel 重构（迁出 + emptyText 接线） | ✅ |
| 三套测试文件（task-filter / TaskFilters / TaskList） | ✅ |
| TDD red → green 顺序 | ✅ |
| 提交消息 | ✅ verbatim |
| **未修改 brief 之外文件** | ✅ 仅 6 个 brief 文件 + TaskSidebarPanel 一处 useEffect（controller-added requirement） |
| 中文注释 | ✅ |
| 语义 token + lucide 14/1.75/aria-hidden | ✅ 既有 TaskSidebarPanel 头/按钮已合规，本次新增 input 也用语义 token |
| TypeScript strict 禁 any / @ts-ignore | ✅ 双 typecheck clean |
| Node 20 + pnpm 9 | ✅ 全程 `nvm use 20 && npx pnpm@9.0.0` |

## 7. 已知缺口与建议

**TaskSidebarPanel 「切 workspace 复位文本」缺独立回归测试**（详见 §3）。建议如后续要补：

最小成本做法是参考 `FileTree.test.tsx:255-273` 加一个 `TaskSidebarPanel.test.tsx` 用例：真实 store setState 触发订阅 → `act(async () => { await vi.advanceTimersByTimeAsync(0); })` → 断言 input value 已清空。本次任务未主动加，遵循 brief 「不要修改 brief 之外文件」的范围约束。
