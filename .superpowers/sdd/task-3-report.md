# Task 3 Report: Prompt 同轮连发教学（dispatch 并行化的 LLM 教学层）

**Status: COMPLETE** · Commit `3a6750e` · Branch `main`

## 1. TDD 证据

| 步骤 | 证据 |
|---|---|
| RED | `tests/agent/dispatch-parallel.test.ts` 首跑（10 用例）：`Tests 1 failed \| 9 passed (10)`——新加的 `formatDispatchHint 并行教学（spec §7.2） > main + 有 subAgents → 含同轮连发并行教学` 失败，断言 `expected '...' to contain '同一次回复中连续发出多个 dispatch'`；其余 9 用例（含「非 main → 空串」——已天然通过；8 个 dispatch 并发回归锁）全绿 |
| GREEN | 改 `prompt-hints.ts`（主动拆分原则加第 5 条）+ `pm-agent.yaml:25` 后：`Tests 10 passed (10)`，231ms |

新加的 2 用例（brief Step 1）：

- `formatDispatchHint 并行教学（spec §7.2） > main + 有 subAgents → 含同轮连发并行教学`——断言 hint 同时包含「同一次回复中连续发出多个 dispatch」和「并行执行」
- `formatDispatchHint 并行教学（spec §7.2） > 非 main / 无 subAgents → 空串（standalone 不受影响）`——断言 `formatDispatchHint(makeConfig()) === ''`（makeConfig 默认 `role: 'standalone'` + `subAgents: []`，与原实现早退分支命中）

### RED 阶段 vitest 输出（节选）

```
❯ tests/agent/dispatch-parallel.test.ts  (10 tests | 1 failed) 231ms
  ❯ formatDispatchHint 并行教学（spec §7.2） > main + 有 subAgents → 含同轮连发并行教学
     → expected '...' to contain '同一次回复中连续发出多个 dispatch'

FAIL  tests/agent/dispatch-parallel.test.ts > ... > main + 有 subAgents → 含同轮连发并行教学
AssertionError: expected '\n\n## 任务拆分指南（PM 角色）\n你是主 agent（PM），有…' to contain '同一次回复中连续发出多个 dispatch'

Test Files  1 failed (1)
     Tests  1 failed | 9 passed (10)
```

### GREEN 阶段 vitest 输出（节选）

```
✓ tests/agent/dispatch-parallel.test.ts  (10 tests) 228ms

Test Files  1 passed (1)
     Tests  10 passed (10)
```

## 2. 交付内容

### 修改文件

- `electron/src/main/agent/prompt-hints.ts` — `formatDispatchHint` 的「主动拆分原则」列表在原第 4 条之后追加第 5 条（spec §7.2 文案）
- `electron/resources/agents/pm-agent.yaml` — 第 25 行「多个子 agent 可以并行调度。」改写为同轮连发教学文案（保留前后两条原文不动）
- `electron/tests/agent/dispatch-parallel.test.ts` — 顶部 import 加 `formatDispatchHint`；末尾追加第 2 个 describe 块（2 用例）

### 关键实现决策

- **YAML 改写保持 1 行换 1 行**：brief 要求 pm-agent.yaml:25 一处替换，其余逐字不动——避免误伤 builtin 加载链（builtin.ts 两阶段注册依赖原行上下文连贯性）
- **prompt-hints.ts 第 5 条插在第 4 条与 `**长任务自身管理**` 之间**：brief 明确指定位置；不调整注释「任务可并行」——因为该注释在「**主动拆分原则**」第 1 条已存在且与新加第 5 条自洽（注释泛指第 1 条「可并行子任务时优先 dispatch」，新加第 5 条进一步教「如何并行」）
- **测试 import 复用模块级 `makeConfig` / `makeMainConfig`**：与 brief「重要上下文」对齐，未在 describe 块内重新定义；直接利用 Task 1 已有的 harness，零冗余
- **第 2 个新用例天然 GREEN**：原 `formatDispatchHint` 已有 `config.role !== 'main' || config.subAgents.length === 0` 早退分支——非 main 即返空串；RED 阶段即通过，加这用例是「锁行为」防止后续重构退化

## 3. 验证

- `lsp_diagnostics` on `prompt-hints.ts`：`No diagnostics found`
- `lsp_diagnostics` on `dispatch-parallel.test.ts`：`No diagnostics found`
- `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts`：`Tests 10 passed (10)`，228ms
- 改动量：3 files changed, 15 insertions(+), 1 deletion(-)

## 4. Concerns / 边界

- **YAML 第 25 行替换 ≠ 列表加一条**：prompt-hints.ts 是「主动拆分原则」列表第 5 条（与已有 4 条平级），pm-agent.yaml 是「使用 dispatch 工具调度子 agent」段后的独立一句。两处文案都指向同一种行为，但读者不同——pm-agent.yaml 是 builtin PM 直读、formatDispatchHint 对所有自定义 main agent 生效，符合 brief「对全部自定义 main agent 生效」的诉求
- **未触及 builtin.ts / runtime-entry.ts**：本任务纯教学层（prompt 字符串），不动 dispatch 执行路径——runtime 已在 Task 2 实现同轮并发执行
- **未跑 typecheck 双 workspace**：brief Step 5 只要求 `dispatch-parallel.test.ts` 全绿；本任务改动仅 prompt-hints.ts（一行字符串）+ test（一行 import + 13 行 describe），lsp_diagnostics 已确认无错误。完整 typecheck 留给后续集成任务（与 Task 1/2 一致）
- **未触及 `coder.yaml` / `requirement-analyst.yaml`**：两个 sub agent 不需要并行教学（它们是 sub 角色，无 dispatch 能力）；只有 main agent 教学有意义

## 5. Commit

```
3a6750e feat(agent): PM prompt 同轮连发教学——pm-agent.yaml 与 formatDispatchHint 教 LLM 并行派发
```

3 files changed, 15 insertions(+), 1 deletion(-)
