# Task 2 Report: recurrence 规则模块

**Status: DONE_WITH_CONCERNS** | Commit: `41ceece` `feat: 循环任务规则模块——nextRun 纯函数 + 完成后自复制续期`

## 交付物

| 文件 | 变更 |
|---|---|
| `electron/src/main/task/recurrence.ts` | 新增 89 行：`nextRun(from, rule): number \| null` 纯函数 + `spawnNextInstanceIfRecurring(taskId): void`。三种规则编码（every:Nm\|Nh\|Nd / daily@HH:mm / weekly@D,HH:mm），非法规则 null（spec D5），spawn 端静默跳过不抛错 |
| `electron/tests/task/recurrence.test.ts` | 新增 9 用例：6 个 nextRun 正常值（every / daily 当天+次日 / weekly 同周+跨周）/ 1 个非法规则 4 子项 / 2 个 spawn（completed→pending 续期、failed/无规则 不生成） |

## 与 brief 的偏离

**唯一偏离：brief 第 21/28/38 行 6 处 `parseInt(ev[1], 10)` → `parseInt(ev[1] ?? '', 10)`**

- 原因：项目根 `tsconfig.base.json` 启用 `noUncheckedIndexedAccess`，正则捕获 `ev[1]` 类型为 `string | undefined`，verbatim 代码 `tsc --noEmit` 报 6 处 TS2345
- 等价性：正则匹配后捕获组必存在（`?? ''` 永不触发），运行行为与 brief 完全一致；与现有 `lsp-tools.ts:433` `parseInt(m[1] ?? '0', 10)` 模式对齐
- 注释：保留 1 行中文注释解释该 workaround，对齐 `loader.ts:25` / `web-tools.ts:114` 既有的 `noUncheckedIndexedAccess` 注释惯例
- 验证：`tsc --noEmit -p .` 整个 electron workspace 通过（exit 0）

## TDD 闭环

| Step | 命令 | 结果 |
|---|---|---|
| 1 | 写 `recurrence.test.ts`（9 用例，逐字 brief） | 文件落盘 |
| 2 | `cd electron && ./node_modules/.bin/vitest run tests/task/recurrence.test.ts` | **RED** — `Failed to load url ../../src/main/task/recurrence ... Does the file exist?`，模块未创建，0/9 收集即失败 |
| 3 | 写 `recurrence.ts`（verbatim + `?? ''` strict 兜底） | 文件落盘 |
| 4 | 同上 vitest 命令 | **GREEN** — `Test Files 1 passed (1) / Tests 9 passed (9)`，迁移 v29 自动应用 |
| 4b | `./node_modules/.bin/vitest run tests/task/target-columns.test.ts` | **GREEN** — 3/3 passed（Task 1 无回归） |
| 4c | `./node_modules/.bin/tsc --noEmit -p .` | **GREEN** — exit 0，整个 workspace 无 TS 错误 |
| 5 | `git add ... && git commit -m "feat: ..."` | `41ceece` |

## TDD Evidence

### RED（Step 2，模块未创建）

```
 RUN  v1.6.1 /workspace/electron

 ❯ tests/task/recurrence.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/task/recurrence.test.ts [ tests/task/recurrence.test.ts ]
Error: Failed to load url ../../src/main/task/recurrence (resolved id: ../../src/main/task/recurrence) in /workspace/electron/tests/task/recurrence.test.ts. Does the file exist?
 ❯ loadAndTransform ...

 Test Files  1 failed (1)
      Tests  no tests
```

理由符合 brief 预期：模块不存在 → 测试无法加载（vitest 把整个 file 标 fail，0 个 test 收集）。

### RED（verbatim 模块，strict 兜底前）

```
src/main/task/recurrence.ts(21,24): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/main/task/recurrence.ts(28,24): error TS2345: ...
src/main/task/recurrence.ts(29,25): error TS2345: ...
src/main/task/recurrence.ts(38,25): error TS2345: ...
src/main/task/recurrence.ts(39,24): error TS2345: ...
src/main/task/recurrence.ts(40,25): error TS2345: ...
```

6 处全部是 `noUncheckedIndexedAccess` 下 RegExpMatchArray 索引的 `string | undefined`。

### GREEN（Step 4）

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  597ms
```

9 个用例：every:30m / every:2h+1d / daily 当天 / daily 次日 / weekly 同周 + 跨周 / weekly 跳日 / 非法 4 子项 / completed+rule spawn / failed+无规则 不 spawn。

## 自评

**完整性：** brief 列出 2 个文件 + 2 个函数 + 3 种规则编码 + 9 个测试用例，全部交付；无遗漏字段（recurrenceParentId / targetTeamId / targetSessionId / recurrenceRule 全部透传）；deadline 不复制（spec §7.2）。

**质量：**
- `nextRun` 是真正纯函数（无副作用、无 DB 访问、无 logger 调用），可在 scheduler / IPC handler / 测试中任意调用
- `spawnNextInstanceIfRecurring` 防御链清晰：null task / 无规则 / 非 completed → 静默 return；nextRun null → warn 日志 + return；合法 → insertTask + info 日志 + fire-and-forget 广播
- `void broadcastLocalTaskSnapshot()` 严格 fire-and-forget（return Promise<void>，调用方不 await）；deps 未装配（P2P 未启用）时静默 no-op（task-broadcast.ts:64 `if (!deps) return`）

**纪律：**
- 注释全部中文（brief 要求 + AGENTS.md 要求）
- 无 any / @ts-ignore / 魔术数字
- TS strict + noUncheckedIndexedAccess 全绿
- 单测 colocated 到 `electron/tests/task/`（vitest include 规则对齐 AGENTS.md）

**测试保真度（momo-test-rules 5 铁律核查）：**
1. Mock 仿真真实运行时语义：✅ 无 mock（业务逻辑全部真实实现：DB 真实 + insertTask 真实 + nextRun 真实），只走真 sqlite + 真 repo
2. 断言生产消费的字段：✅ id (T-001) / recurrenceParentId / recurrenceRule / assigneeAgentId / scheduledAt / title / deadlineAt 全部断言真实值
3. 错误路径与空输入专项用例：✅ 非法规则 4 子项（cron / every:0m / daily@25:00 / 空串）；failed / 无规则 双路径；非法不 spawn
4. 跨模块契约：✅ spawn 直接消费 listTasks 真实产出（不经手写构造的中间数据）；nextRun 用 `new Date(...).getTime()` 固定输入
5. Mock 收窄：✅ 不 mock IPC / DB / fetch；broadcastLocalTaskSnapshot 真实函数调用，deps 为 null → 静默 return

**时间注入防 flaky：** 所有 nextRun 测试用 `new Date(2026, 8, 7, 8, 30).getTime()` 固定输入（spec §7 时间逻辑纯函数，不依赖真实时钟）；spawn 测试中 `now = Date.now()` 一次性快照，`scheduledAt = now + 30*60_000` 同步断言，无 sleep / 无 setTimeout，无跨时钟边界。

## Concerns

1. **brief verbatim 与 strict TS 的张力**：brief 的 6 处 `parseInt(ev[1], 10)` 是「为测试用例写」的简洁形态，但 `noUncheckedIndexedAccess` 下必加兜底。我选择最小改动 `?? ''`（等价 + 与 `lsp-tools.ts` 既成模式对齐）+ 1 行注释（对齐 `loader.ts:25` 既成注释惯例），保留 brief 的全部语义不变。若任务评审坚持 verbatim，可改用 `const [, n, unit] = ev` 解构 + `if (!n || !unit) return null` 显式判空（更繁琐但更「显式」）。
2. **brief 测试文件未使用 `getTask` 导入**：保留 verbatim 导入以匹配 brief（lsp 报 hint TS6133，非 error），调用方仍可通过 `getTask` 在后续任务中复用。
3. **`every:Nm|Nh|Nd` 未限制 N 的上界**：brief 正则 `(\d+)` 不限位数，parseInt 后 `n * unitMs` 在 `every:999999999d` 等极端值下会溢出 JS number 上界（≈9e15 ms ≈ 285000 年）。当前业务场景（spec §7 短间隔续期）下不会触发；后续若要硬化，加 `if (n > 100_000) return null` 一行即可。
4. **vitest 同时跑两个 test 文件偶发 segfault**：连跑 `recurrence.test.ts + target-columns.test.ts` 在本次环境出现 native binding segfault（exit 139），分单跑均 GREEN；属 better-sqlite3 多进程 fd 关闭的预存问题（与本任务无关，AGENTS.md 常见陷阱节已有同类警告）。未作为本任务回归项处理。

## 后续任务前置条件（已就位）

- Task 3-11 调 `spawnNextInstanceIfRecurring` 的单点路径：
  - `electron/src/main/agent/agent-runner.ts` 的 task-end handler
  - `electron/src/main/task/ipc.handlers.ts` 的 completeTask
  - 调度器自动升级 pending→assigned 时不会触发（仅 completed 终态续期，符合 spec §7.2）
- broadcastLocalTaskSnapshot 已接好（deps 未装配 → 静默 no-op，P2P 模块 init 后自动装配）
