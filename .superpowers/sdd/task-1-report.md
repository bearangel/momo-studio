# Task 1 报告 — todo `source` 挂靠字段与 `hasPendingUserTodos` 判定

**状态：DONE** | **Commit：`0cc7a9e`** | 分支：`feat/turn-mandate`
**Base：`e9ef4de`**（实施计划 doc commit 前一提交）

## 做了什么

按 brief 严格 TDD 执行五步，落地三个后续任务（turn mandate plan）依赖的精确签名：

1. **`TodoItem.source: 'user' | 'agent'`**（必填，解析层缺省 `'agent'`）——`electron/src/main/agent/tools/todo-types.ts`
2. **`hasPendingUserTodos(streamSessionId: string): boolean`**（mandate 判定，spec §5.2）——`electron/src/main/agent/tools/todo-tools.ts` 顶层导出
3. **`__setTodosForTest(streamSessionId: string, items: TodoItem[]): void`**（测试种子钩子，绕过 execute 全量替换协议）——同上文件顶层导出

辅助改动（同一文件内）：
- `execute()` 在 status 校验之后、长度校验之前注入 source 解析（缺省 `'agent'`）+ 非法值抛错（沿 status 错误风格：`todos[${i}].source 必须是 user/agent，实际: ${String(rawSource)}`）
- `formatSummary()` 行尾追加 `[u]/[a]` 标注（user 挂靠 = u，agent 挂靠 = a）
- `getDefs().todowrite.description` 改写为 spec §5.6 #8a 原文；`inputSchema.todos.items.properties.source: { type: 'string', enum: ['user', 'agent'], description: '挂靠来源（缺省 agent）' }`；`required` 仍为 `['subject', 'status']`（spec 缺省语义）

## 测试命令与输出摘要

**单文件（Step 2 / 4）：**
```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/todo-tools.test.ts
```

**RED 输出（Step 2）**：
```
❯ tests/agent/tools/todo-tools.test.ts > todo source 挂靠 > ... (4 failed)
   → TypeError: __setTodosForTest is not a function
   at todo-tools.test.ts:169:20

 Test Files  1 failed (1)
      Tests  4 failed | 8 passed (12)
```
旧 8 用例全绿（未触动）；新 4 用例因 `__setTodosForTest` 导出缺失而红。✓ 符合预期。

**GREEN 输出（Step 4）**：
```
✓ tests/agent/tools/todo-tools.test.ts  (12 tests) 4ms
Test Files  1 passed (1)
     Tests  12 passed (12)
```

**完整 `tests/agent/tools/` 目录（防回归）**：
```
Test Files  14 passed (14)
     Tests  161 passed (161)
```

**完整 electron workspace（防 `TodoItem` 必填化破坏消费者）**：
```
Test Files  195 passed (195)
     Tests  1625 passed (1625)
```

**Typecheck（双 workspace 严格）**：
```
> momo-studio@2.0.0 typecheck /workspace
electron typecheck: Done
renderer typecheck: Done
```

## 额外验证

- **lsp_diagnostics** 未单独跑（`typecheck` 双 workspace 全 clean 等价覆盖）
- **未改 brief 之外的任何文件**——`git status` 干净，仅三文件变更
- **未引入新依赖**
- **Node 版本**：v20.20.2（brief 要求 Node 20）
- **未 push、未 rebase**

## 自查发现

### Completeness ✓
- 三个 Produces 签名（`TodoItem.source` / `hasPendingUserTodos` / `__setTodosForTest`）与 brief 文字一字不差
- 测试覆盖四要点：缺省回落 / 挂靠判定（pending/in_progress 计入，completed 不计）/ 非法值 / 回显 `[u]/[a]` 标注
- `getDefs` description 与 schema 同步更新（spec §5.6 #8a），LLM 端可看到 source 语义

### Quality ✓
- `TodoItem.source` 必填化但解析层永远兜底——写入路径无 `undefined` 风险
- `__setTodosForTest` 用 `__` 前缀约定（仓库惯例）
- 错误信息格式与既有 status 校验保持一致
- 单测断言精确字符串（`[ ] [u] U项` / `[ ] [a] A项`）而非模糊 `toMatch`

### Discipline ✓
- 全程 TDD：先红 → 最小实现 → 绿 → 范围目录回归 → typecheck → 提交
- Conventional Commits `feat:` 前缀 + 中文描述
- 分支 `feat/turn-mandate`，未 push、未 rebase
- `permissionConfig.allowedTools` / `deniedTools` 用 `[]` 而非 brief 中 `undefined`——`ToolPermissionConfig` 类型要求 `string[]`；`wsFs` / `skillRegistry` 沿用既有 `as never` 风格（brief 注释明确允许）

### Test realism (per momo-test-rules) ✓
- `mkCtx` 桩以 `electron/src/main/agent/tools/types.ts` 为准补齐
- 测试断言覆盖正常 / 边界 / 错误三种路径
- `__setTodosForTest` 通过唯一 sid（`'stream-source-test'`）隔离，与既有 `tools.getTodos('ssn-1')` 不冲突；`beforeEach(__setTodosForTest)` 显式清理避免污染

## 关键设计点（与 brief 严丝合缝）

- **`TodoItem.source` 必填化但解析层永远兜底**——下游 stream-chunk 消费者若消费旧 chunk（无 source 字段），按可选字段处理（已在 TodoItem.source 的 docstring 中明确此降级路径）
- **`__setTodosForTest` 直接写 `todoStore.set` 而非走 execute**——按 brief 设计的"测试种子"语义，与既有 `TodoTools.getTodos` 测试钩子风格一致
- **`hasPendingUserTodos` 读 store 视图**——`status !== 'completed' && source === 'user'` 双条件精确对应 spec §5.2 语义

## 文件变更

```
 electron/src/main/agent/tools/todo-tools.ts   | 39 ++++++++++--
 electron/src/main/agent/tools/todo-types.ts   |  6 ++
 electron/tests/agent/tools/todo-tools.test.ts | 87 ++++++++++++++++++++++++++-
 3 files changed, 127 insertions(+), 5 deletions(-)
```
—— 完全等于 brief 列出的三个目标文件，无意外扩散。

## Concerns

无实质 concerns。一点值得记录：

1. **`TodoItem.source` 必填化的渲染器兼容**——理论上 renderer 端 chunk 处理器可能消费旧 todo 字段（无 source）。当前 electron 1625 用例 + typecheck 双 clean 均通过；若后续接入真实 LLM 流发现 renderer 报错，由 renderer 端按可选字段消费即可（docstring 已说明降级路径）。

2. **`todoStore` 单例无 `clearAllForTest`**——测试间无强清理。本任务新 4 用例通过 `beforeEach(__setTodosForTest(sid, []))` 显式清理 sid 隔离态，避免跨用例污染。如未来引入 resetAll 类钩子，可考虑收敛到一处。
