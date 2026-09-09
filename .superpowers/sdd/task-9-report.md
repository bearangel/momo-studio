# Task 9 报告：TaskCard/DetailPanel 增量展示 + renderer recurrence lib

## 状态

**DONE** — commit `7f0e085`（分支 `feat/task-execution-runtime`）

> 注：本文件原为上一计划周期（session UI 渲染）的同号 Task 9 报告，按本任务指令覆写为任务执行运行时计划（11 任务）的 Task 9 报告。

## 交付物（7 文件，+161/−4）

| 文件 | 变更 |
|---|---|
| `renderer/src/lib/recurrence.ts` | 新建：`RecurrencePreset` / `serializeRecurrence` / `humanizeRecurrence`（brief 代码原文） |
| `renderer/src/lib/recurrence.test.ts` | 新建：brief 测试原文（序列化 3 规则 + once→null + 人性化 + 未知规则回退） |
| `renderer/src/components/task-board/TaskCard.tsx` | 新 prop `queueRank?`；排队徽标（标题行、状态徽标前、`text-status-warning`）；Repeat+humanize 循环标记；pending+rule+scheduledAt「下次」时间；Users/MessagesSquare 委派目标（11px 跟随既有元信息行） |
| `renderer/src/components/task-board/TaskCard.test.tsx` | 新建：brief 测试原文（排队 #N + 循环标记/下次） |
| `renderer/src/components/task-board/TaskList.tsx` | props 加 `queueRanks?: Map<string, number>`，透传 `queueRank={queueRanks?.get(t.id)}` |
| `renderer/src/components/task-board/TaskSidebarPanel.tsx` | `filteredTasks` 后新增 `queueRanks` useMemo（排序表达式与 brief 一字不差：priority DESC → scheduledAt??createdAt ASC → createdAt ASC，rank 从 1），传入 TaskList |
| `renderer/src/components/task-board/TaskDetailPanel.tsx` | 元信息 grid 追加：循环 humanize / 母任务 #T 链接（`useTaskStore.getState().setSelectedTaskId`）/ 目标团队 / 目标会话（均 brief 代码原文） |

## TDD 流程

1. **RED**：先写 `recurrence.test.ts` + `TaskCard.test.tsx`（brief 原文）→ 跑测确认 2 文件全败（模块不存在 / queueRank prop 与循环渲染不存在）——失败原因均为功能缺失，符合预期
2. **GREEN**：实现 5 交付物 → 目标测试 29/29 全绿（含 task-board 目录全部既有测试零回归）
3. **全套**：renderer 全套 106 文件 / 950 测试全绿
4. **typecheck**：根 `pnpm typecheck` 双 workspace clean（electron + renderer）
5. **LSP**：改动文件零 error

## 与 brief 的偏差（1 处，已论证）

`humanizeRecurrence` 中 `UNIT_LABEL[ev[2]]` 在 `noUncheckedIndexedAccess` 下报 TS2538（`string | undefined` 不能做索引）。修复采用 **electron 孪生文件**（`electron/src/main/task/recurrence.ts` 同一正则）的既有模式：`ev[2] ?? ''` + 移植其两行说明注释。regex 命中时 `?? ''` 永不触发，运行时行为与 brief 语义逐字节一致。brief 代码其余部分（含 TaskCard/TaskList/SidebarPanel/DetailPanel 全部 JSX、排序表达式、测试代码）逐字落地。

## 自审记录

- **UI 红线**：全部语义 token（`text-status-warning` / `text-tertiary` / `text-accent-600 dark:text-accent-300` 均为仓库存量 token）；图标全 lucide（Repeat/Users/MessagesSquare，11px 跟随 TaskCard 既有 Calendar/Clock/Bot 元信息行用法——主图标 16px 规范不适用于这些既有 11px 行）；无 emoji；无动态拼接 Tailwind class（新增类全静态）
- **TaskDetailPanel.test.tsx**：先读后改判定——既有 4 用例只断言「进入执行会话」按钮行为与 `#task-1` 标题行，与新增量渲染零冲突；**未删除/未修改任何断言**，4 用例原样全绿（其 makeTask fixture 无 recurrence/target 字段 → 新条件分支不渲染，天然无干扰）
- **TaskSidebarPanel/TaskBoardView 既有测试**：TASK_B（assigned）现在会显示「排队 #1」，但既有断言均按标题正则/任务顺序断言，不受影响——11+7 用例零改动全绿
- **布局决策**：排队徽标按 brief「标题行状态徽标前」落位；为保 `justify-between` 布局不产生三元素中间悬空，徽标与状态徽标包进 `inline-flex shrink-0 gap-1.5` 右侧组（视觉顺序不变：标题 | 排队 #N | 状态）
- **已知展示细节（按 brief 原样，未加戏）**：pending+rule+scheduledAt 任务会同时显示 Calendar 日期行与「下次 …」时间行（Calendar 行是既有逻辑，brief 未要求抑制，scope discipline 不扩）
- **注释**：全中文；文件头沿用各文件既有变更日志模式；`?? ''` 处注释移植自 electron 先例

## 验证命令与结果

```bash
nvm use 20
cd renderer && npx pnpm@9.0.0 vitest run src/lib/recurrence.test.ts src/components/task-board
# → 6 files / 29 tests passed
npx pnpm@9.0.0 test          # renderer 全套 → 106 files / 950 tests passed
# 根目录 npx pnpm@9.0.0 typecheck → electron Done + renderer Done
```
