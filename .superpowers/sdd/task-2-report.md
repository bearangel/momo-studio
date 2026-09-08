# Task 2 Report — create_task 描述纠偏 + 无指派 warning

**Status**: DONE
**Commit**: `4a2e2bfc8caab6db5fd239711f20bb8fb0a71271` (short: `4a2e2bf`)
**Date**: 2026-09-08

## What was done

Eliminated the "scheduler hallucination" in the `create_task` agent tool. The old description lied "不指定则由调度器决定" (no dispatcher mechanism exists in the system — it was reserved for v2.1 wiring). Agents took the lie at face value and created no-target tasks that silently landed in `draft` and waited forever.

Two coordinated changes to `electron/src/main/agent/tools/task-tools.ts`:

1. **Truth in description** — `create_task` main description now states the K1 落态 truth (K1 决策表: 有目标 assigned / 有计划 pending / 否则 draft), `assigneeAgentId`/`targetTeamId`/`targetSessionId` sub-descriptions point to `list_delegation_targets` as the source of truth for real IDs.
2. **K1 decision alignment** — `createTask` now applies the same K1 ternary used by IPC handler `task:create` (`task/ipc.handlers.ts:97-98`):
   - `scheduledAt != null` → `'pending'`
   - else `hasTarget` → `'assigned'` + `notifyExecutor()`
   - else `undefined` (repo defaults to `'draft'`)
3. **Inline warning when no target** — `execute()` `create_task` branch attaches `NO_ASSIGNMENT_WARNING` to top of TaskRow when no委派 target is provided. Shape is backward-compatible: with target, returns pure `TaskRow`; without target, returns `TaskRow & { warning }`.

The IPC handler `task:create` was already correct (K1 applied + `notifyExecutor()`). This change brings the tool entry point into parity.

Test file `electron/tests/agent/tools/task-tools-delegation.test.ts` had 3 Task-1 cases; appended 2 Task-2 cases (reuse existing `makeDef` / `seedCtx` helpers per brief):

- **无指派创建 → 返回 TaskRow 字段仍在顶层 + warning 字段说明死局与出路** — asserts `id` matches `^T-`, `status='draft'`, `warning` contains "没有自动指派机制" / "list_delegation_targets" / "draft".
- **有指派创建 → 无 warning 字段 + 落 assigned** — asserts `status='assigned'`, `warning` undefined.

## Test results

### Red — Step 2 verification (expected failures before fix)

Command:
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
```

Output (excerpt):
```
 ❯ tests/agent/tools/task-tools-delegation.test.ts > create_task 无指派 warning（委派信息闭环） > 无指派创建 → ...
   → the given combination of arguments (undefined and string) is invalid ...
   (expect(result.warning).toContain('没有自动指派机制') — warning was undefined)
 ❯ tests/agent/tools/task-tools-delegation.test.ts > create_task 无指派 warning（委派信息闭环） > 有指派创建 → ...
   → expected 'draft' to be 'assigned' // Object.is equality

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
```

Both new cases failed exactly as predicted (red reproducible before fix).

### Green — Step 4 verification

Same command after fix:
```
 ✓ tests/agent/tools/task-tools-delegation.test.ts  (5 tests) 879ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

5/5 passed (3 Task-1 + 2 Task-2).

### Full regression — Step 5

Command:
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/
```

Output:
```
 Test Files  75 passed (75)
      Tests  656 passed (656)
```

All 656 tests across `tests/agent/` passed. `task-tools.test.ts` (low-level unit tests of `createTask`/`completeTask`/`failTask`) and `task-tools-context.test.ts` (Bug-1 FK regression lock) both still green — `warning` only ADDS an optional top-level field for the no-target path, never removes existing TaskRow fields.

### Typecheck

Command:
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace && npx pnpm@9.0.0 typecheck
```

Output:
```
electron typecheck: Done
renderer typecheck: Done
```

Both clean.

### Commit

```
4a2e2bf fix: create_task 描述纠偏 + 无指派返回 warning——消除调度器幻觉
 electron/src/main/agent/tools/task-tools.ts        | 38 ++++++++++++++++----
 .../agent/tools/task-tools-delegation.test.ts      | 42 ++++++++++++++++++++++
 2 files changed, 73 insertions(+), 7 deletions(-)
```

Staged only the two files specified in the brief; left `.superpowers/sdd/progress.md`, `task-1-report.md`, and the new `docs/specs/` + `docs/plans/` files untouched (owned by other tracks).

## Self-review / concerns

- **Existing test compatibility** — Verified pre-implementation that the change is backward-compatible with all three shapes asserted by existing tests: `task-tools-context.test.ts:93` (no assignee → `status='draft'`, K1 still produces `undefined` → repo defaults `draft`), `task-tools.test.ts:170` (direct `createTask` no assignee/scheduledAt → `draft`, unchanged), `task-tools.test.ts:185` (with `scheduledAt` → `pending`, K1 ternary still routes scheduledAt-first). No assertion changes were needed.
- **NO_ASSIGNMENT_WARNING constants** — String is verbatim per brief spec; intentionally surfaces the "状态机不允许 draft 用工具取消" fact (drives agent toward right action instead of trying `cancel_task` on a draft and getting rejected).
- **`notifyExecutor()` placement** — Only fires on `status === 'assigned'`, not on `pending`/`draft`. Mirrors IPC handler behavior (it always calls `notifyExecutor()` after create regardless of status, but that handler doesn't gate on status — the K1 branch where it would matter is `assigned`, which both handlers now cover). Tool entry has a stricter gate; spec says `notifyExecutor` is idempotent (100ms debounce) so over-calling is harmless. Decision: tool path only notifies on `assigned` because that's the only transition that needs executor re-evaluation (scheduled → pending goes through scheduler, draft goes nowhere).
- **Renderer-side impact** — The `warning` field is a new optional top-level key on `create_task` tool output. Existing renderer consumers parse TaskRow top-level fields (`id`/`status`/`workspaceId`/etc.) which are all still present; extra `warning` key is harmless. No renderer code change required for this task.
- **Comment discipline** — Two comments added to source file are verbatim from the brief's spec (K1 decision rationale pointing at the IPC handler source-of-truth, and warning backward-compat contract). All four comments flagged by the auto-comment-hook are necessary contract documentation, not narration.
- **Scope discipline** — Did not modify `task/ipc.handlers.ts` (already correct), did not touch `renderer/` (no consumer shape break), did not amend `task-tools.ts` description for tools other than `create_task` (out of scope). Only the two files in the brief's commit command were staged.
- **Note on this report file** — The path `/workspace/.superpowers/sdd/task-2-report.md` already contained a prior report from a different milestone (recurrence rules, commit `41ceece`, Sep 7). The directory is gitignored scratch storage; the brief explicitly directs write to this path so I overwrote. If the previous recurrence report is needed for reference, it remains available in any session storage that wrote it (it's not committed to git).

## 终审 fix

**Status**: DONE  
**Branch**: main (HEAD was `4a2e2bf`; one follow-up commit added)  
**Scope**: 终审对「任务委派信息闭环」分支给出 3 个 must-fix,一次性修完

### What was done

**Must-fix 1（核心）: hasDelegationTarget 四处分叉 + 空串边缘 case**

终审 N1/M6 锁定的事实: 同一语义「委派目标三列任一非空」在四处分别实现 (`!= null` / `Boolean()` / 内联 + 私有化), 谓词语义漂移即 bug. LLM 传 `assigneeAgentId=''` 时:
- `createTask` (`!= null`): 判有目标 → 落 assigned + `notifyExecutor()`
- executor `validateTarget`: 判空 → 转 failed
- `execute()` warning (`Boolean()`): 判无目标 → 返回体带 warning 谎称「停留 draft」

任务同时落 assigned (executor 转 failed) + 返回体带 warning (谎称 draft) = **双重新话**. LLM 收到带 warning 的失败任务不知该信哪边.

收敛为单点:
1. `electron/src/main/task/starter.ts` — 私有函数 `hasDelegationTarget(task: TaskRow): boolean` 改为导出的宽签名 `hasDelegationTarget(target: { assigneeAgentId?: string | null; targetTeamId?: string | null; targetSessionId?: string | null }): boolean`. 内部 `startTask` 的 K2 草稿资格判定 `hasDelegationTarget(task)` 调用点不动 (TaskRow 结构兼容, TS 结构性子类型接受).
2. `electron/src/main/task/ipc.handlers.ts` — `task:create` handler 的内联 `const hasTarget = ...` 删除, 改 `hasDelegationTarget(input)`. 函数内 K1 决策表注释保留 (即「无目标 + 无 scheduledAt → draft」/「有目标 + 无 scheduledAt → assigned」/「有 scheduledAt → pending」).
3. `electron/src/main/agent/tools/task-tools.ts`:
   - `createTask` 内联 `const hasTarget = ...` 换 `hasDelegationTarget(input)`. import 行新增 `import { hasDelegationTarget } from '../../task/starter';`.
   - `execute()` `create_task` 分支: 三个目标字段入参构造加 `|| undefined` 边界归一, 让 `parseStringArgOptional('')` 返回 `''` 时归一为 `undefined`, 两处谓词天然一致. `Boolean(...)` 谓词换 `hasDelegationTarget(input)`.

**Must-fix 2: createTask 外层 JSDoc 陈旧**

`task-tools.ts` 的 `createTask` JSDoc 原本写「(不带 scheduledAt 时 status 走 repo 默认 draft / description 默认 '' / priority 默认 0; 带 scheduledAt 时落 pending)」, 与新 K1 三分支漂移. 更新为:
- 有委派目标 → assigned (即时评估放行)
- 有 scheduledAt → pending (到点 scheduler 接管)
- 两者皆无 → draft (repo 默认)

**Must-fix 3: 文件头 repo 枚举**

`task-tools.ts` 文件头注释「所有数据库读写都走已有的 tasks repo / messages repo / events repo / SQLiteMemoryProvider」补上 `agent crud / team / sessions repo` 三源 (新加的 list_delegation_targets 用了这三个 repo, 维持「本文件不含 SQL」不变式).

### Regression lock

`electron/tests/agent/tools/task-tools-delegation.test.ts` 的 `create_task 无指派 warning` describe 里追加 1 例:
- `空串 assigneeAgentId="" 归一为无目标 → draft + warning` — 锁定空串边缘 case 回归. 复现终审 N1 双重新话: 不归一时会落 assigned + executor 转 failed, 归一后正确落 draft + warning.

### Test results

- `vitest run tests/agent/tools/ tests/task/` (spec 指定范围): 29 files / 258 tests passed
- `pnpm --filter momo-studio-electron test` (全量回归): 186 files / **1554 tests passed** (前 1553 + 本次新增 1 = 1554)
- `pnpm --filter momo-studio-renderer test`: 108 files / 987 tests passed (renderer 无相关改动)
- `pnpm typecheck` (双 workspace): electron + renderer 双 clean

### Files changed

任务 brief 列出 4 个核心文件: `task-tools.ts` / `starter.ts` / `ipc.handlers.ts` / `task-tools-delegation.test.ts`. 全部按 spec 修改.

**追加 1 个必要的下游文件**: `electron/tests/p2p/task-broadcast.test.ts` — 该测试用 `vi.mock('../../src/main/task/starter', () => starterMocks)` 桩 starter 模块 (原枚举只有 `startTask`); 导出新增 `hasDelegationTarget` 后 vi.mock 在模块加载时因「missing export」抛错, 改用 `importOriginal` 透传真实 `hasDelegationTarget` 实现 (测试不关心谓词语义). 这是导出新函数的机械必然结果, 不是范围扩张.

```
 electron/src/main/agent/tools/task-tools.ts                 | 49 +++---
 electron/src/main/task/ipc.handlers.ts                      |  7 +-
 electron/src/main/task/starter.ts                           | 11 +-
 electron/tests/agent/tools/task-tools-delegation.test.ts    | 13 ++
 electron/tests/p2p/task-broadcast.test.ts                   |  8 +-  (下游客械适配)
```

### Self-review / concerns

- **谓词签名宽窄** — 新 `hasDelegationTarget` 接受 `{ assigneeAgentId?: string | null; ... }` 而非 `TaskRow`. 这是有意的: IPC handler 的 `CreateInput` / tool 的 `CreateTaskInput` / starter 内部 `TaskRow` 三种类型, 宽签名只挑出三列, 调用方不用先 `Pick` 或做类型断言, 谓词纯函数无副作用. 内部调用点 `hasDelegationTarget(task)` (TaskRow) 仍然合法: TS 结构性子类型让 `string | null` 满足 `string | null | undefined`.
- **空串归一处** — 只在 tool `execute()` 入参构造时归一 (`|| undefined`), 不在底层 `parseStringArgOptional` 加. 后者职责单一「字符串解析」, 边界归一是 tool 层语义边界 (「LLM 探针」), 不污染共享 util.
- **task-broadcast.test.ts 改动** — 不在 brief 列出的 4 文件, 但 vi.mock 枚举模块导出是 mock factory 的反模式 (任何 export 变更都改 mock); 用 `importOriginal` 透传是次优解, 更彻底的方案是 mock factory 自动 `importOriginal` 兜底所有未列出的导出. 留作后续清理项 (本任务不做).
- **覆盖完整性** — 已加测试只锁 `execute()` 入口的空串归一. `createTask()` 函数级空串防御测试缺 (内部函数被 `execute()` 包了一层, 实际无暴露面). 决策: 不加冗余测试, 测试应反映实际暴露面.
- **commit message** — 严格按 brief 提供的字符串, 不修改.
