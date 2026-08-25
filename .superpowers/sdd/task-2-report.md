# Task 2 Report: runChatLoop 工具循环三段式重构（绿阶段）

**Status: DONE**
**Commit: d8b6c7e `feat(agent): dispatch 同轮并发执行——chat loop 连续段并发 / 预算预扣均分 / 回填保序`**
**改动文件：仅 `electron/src/main/agent/runtime-entry.ts`（+167 / −58）**

## GREEN Evidence

### Step 5 — 新测试（brief 验收标准）

```
$ cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts
 ✓ tests/agent/dispatch-parallel.test.ts  (8 tests) 218ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Task 1 的 4 红（B 派发先于 A 回执 / 双 chip 同现 / D3 均分 3-3 / 预算截断）全部转绿，4 绿基线用例保持绿 → 8/8。

### Step 6 — 6 套件零回归

```
$ cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-stream.test.ts tests/agent/runtime-segment.test.ts \
    tests/agent/runtime-entry-routing.test.ts tests/agent/dispatch-fresh-session.test.ts \
    tests/agent/dispatch-wait.test.ts tests/agent/runtime-task-driven.test.ts
 ✓ dispatch-wait.test.ts            (3 tests)
 ✓ runtime-segment.test.ts          (2 tests)
 ✓ dispatch-fresh-session.test.ts   (4 tests)
 ✓ runtime-entry-routing.test.ts    (5 tests)   [stderr「runTaskChatLoop 异常」为错误路径用例预期输出]
 ✓ runtime-task-driven.test.ts     (20 tests)
 ✓ runtime-stream.test.ts          (19 tests)
 Test Files  6 passed (6) / Tests 53 passed (53)
```

runtime-stream（含单 dispatch 路径 = 段长 1 回归 / abort / 预算 / 分段）全部通过。

### Step 7 — typecheck 双 clean

```
$ npx pnpm@9.0.0 typecheck
electron typecheck: Done
renderer typecheck: Done
```

lsp_diagnostics（runtime-entry.ts，error 级）：0 错误。

## 实施摘要（对照 brief 四步）

1. **Step 1**：`execDispatchCall` 闭包插入 `runChatLoop` 内、`MAX_DUPLICATE_TOOLS` 声明之后 / `for (let round…)` 之前（在 brief 指定的「sendEndChunk 定义之后、for 之前」窗口内，紧邻使用点）。逐字采用 brief 代码。
2. **Step 2**：`for (const tc of toolCalls)` → 游标 `while (ti < toolCalls.length)` + `const tc = toolCalls[ti]!`；重复检测块与预算耗尽块逐字未动（两者内部 `return` 语义在 while 中不变）。
3. **Step 3**：task_complete 1 处 + compact 2 处 `continue;` → `ti++; continue;`（brief 逐字写法，单行）；其余逻辑（分段持久化 / 消息 push / `toolCallCount++` / `budgetRemaining--`）逐字保留。
4. **Step 4**：原 `isDispatch` 分支 + 串行路径整段删除，替换为「段扫描（重复/预算截断）→ 段预扣 K → D3 均分 subBudget → Promise.allSettled 并发 → 中断统一退出 → 保序回填 + 回执追扣 → 段内截断退出 → `ti = segEnd`」+ 非 dispatch 串行路径（`ti++` 收尾）。逐字采用 brief 代码。

行号锚点核验：brief 行号（:315/:409/:437-499/:504-564/:566-659/:660）与文件实际内容全部按内容匹配命中，无锚点漂移。

## 不变量自查（①-④）

| # | 不变量 | 自查结论 |
|---|---|---|
| ① | 消息回填按原 toolCalls 顺序 | ✅ 段回填 `for (idx = 0; idx < seg.length; idx++)` 按 `seg = toolCalls.slice(ti, segEnd)` 原序 push，`toolCallId: seg[idx]!.id`，不按完成顺序；串行路径单件原位。测试「回填按原 toolCalls 顺序（B 先完成仍排 A 后）」+「混排 cA/cR/cB」双绿锁定 |
| ② | 中断统一退出、不回填 tool result | ✅ `execDispatchCall` catch 中 AbortError/已 abort → 原样 rethrow（不发 tool_result chip）；段边界 `signal.aborted \|\| settled.some(rejected)` → `process.off` + end(interrupted) + `stats.aborted=true` + return，位于回填循环**之前**。测试「并发批次中断」绿：cA/cB 均无 tool_result、end(interrupted)、返回 '(中断)' |
| ③ | 段长 1 时 sub-budget 与串行逐位一致 | ✅ 串行公式 `budgetRemaining === Infinity ? -1 : max(0, budgetRemaining - 1)`；新公式段长 1 时 = `budgetBeforeSegment === Infinity ? -1 : max(0, budgetBeforeSegment - 1)`，`budgetBeforeSegment` 即预检后预算（预检已保证 ≥ 1），逐位一致；段预扣 `-= seg.length`（=1）对应串行 `--`。runtime-stream 19 用例（含单 dispatch 预算链）零回归 |
| ④ | 被截断成员不发 tool_call chip | ✅ chip 只在 `execDispatchCall` 同步段发送，调用范围 = `seg`（slice 到 segEnd）；扫描循环只做签名/预算预检不执行。测试「预算不足截断」绿：`idxOfChunk('tool_call','cB') === -1`、仅 1 个派发事件、end(budget_exhausted) |

## 边界自查

- **空 toolCalls**：`finishReason === 'stop' || toolCalls.length === 0` 提前 return，不进 while。
- **budget Infinity（-1）**：段预扣跳过（`!== Infinity` 守卫）；subBudget = -1（无限），与串行一致。
- **budget 0**：顶部逐位预检 `budgetRemaining <= 0` → budget_exhausted return（原样保留），不进段逻辑。
- **重复窗口语义**：成员 1 签名由顶部预检 push，成员 2..K 由段扫描按原顺序 push——窗口内容与串行逐位等价；差异仅在「段内预检先于任何执行」（spec §4.3 设计如此，测试「3 相同 dispatch 执行 2 个后终止」绿）。
- **非 abort 错误**：execDispatchCall 内转 `工具执行失败: …` 字符串 → allSettled fulfilled → 回填为 tool 消息（LLM 可见自行纠正），与串行语义一致；subStatus 按「超时」关键词分 timeout/failed。
- **`settled[idx] as PromiseFulfilledResult<string>`**：上方 rejected 守卫保证安全；非 `any`、无 `@ts-ignore`，strict + ESLint no-explicit-any 合规。

## 契约与范围自查

- 契约零改动：未触碰 StreamChunk / DispatchContent / dispatch-wait.ts / router-service / preload / renderer（commit 仅 1 文件）。
- `subStreamSessionId` 仍由 PM 侧 randomUUID 预生成后经 executeTool 透传（P0-7 查找键语义不变），dispatch 路由目标仍用当前 `roomId`（P0-8 语义不变）。
- 测试保真（momo-test-rules）：未改测试文件；其驱动方式（真实 handleTaskReply / 真实 executeDispatch / 真实 randomUUID subStreamSessionId）不受本次重构影响。

## Concerns（非阻塞）

1. `ti++; continue;` 为 brief 逐字单行写法（两条语句一行）；tsc/vitest 均无异议，本任务验证步骤不含 ESLint，如后续 lint 有 single-statement-per-line 偏好可格式化为两行（纯格式，零语义）。
2. 段边界中断判定含 `abortController.signal.aborted`（即使全部成员 fulfilled）：abort 落在最后一个 settle 之后、检查之前时，新实现立即 interrupted 退出，而旧串行会等下一轮 LLM 调用才 AbortError——更严格的中断观察，属 brief 逐字设计（§6.1），非回归。
3. 段内截断退出时 `recentToolCallSignatures` 已含被截成员签名（预检 push）——若未来支持「截断后继续而非退出」需回滚窗口；当前两条截断路径均直接 return 退出 chat loop，无影响。
