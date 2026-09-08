# Task 5 报告：持久副作用软门禁

- **状态**：DONE
- **Commit**：`6b9bada` — `feat: create_task/memory_save 软门禁——无 user 挂靠附 warning 不阻断（spec §5.3）`
- **分支**：`feat/turn-mandate`（未 push，未 rebase）
- **BASE**：f52eab7（T4 之后）

## 一、改动内容

### `electron/src/main/agent/tools/shared/mandate-warning.ts`（新建，11 行）

持久副作用软门禁文案常量 `SIDEEFFECT_UNLINKED_WARNING`——task-tools 与 memory-tools 共享避免双份漂移。文案包含三要素：未挂靠事实 + 修复路径（先建 user todo 或先获用户同意）+ 不阻断明示。

### `electron/src/main/agent/tools/task-tools.ts`（+13/−1）

1. **顶部 imports**：`hasPendingUserTodos` from `./todo-tools`、`SIDEEFFECT_UNLINKED_WARNING` from `./shared/mandate-warning`。
2. **create_task 分支尾部**（原有 `if (!hasDelegationTarget(input))` 之后追加）：`if (!hasPendingUserTodos(ctx.streamSessionId)) return JSON.stringify({ ...result, warning: SIDEEFFECT_UNLINKED_WARNING })`。两条 warning 互斥——无指派走 NO_ASSIGNMENT_WARNING 优先，此处只覆盖「有指派但失挂靠」。

### `electron/src/main/agent/tools/memory-tools.ts`（+9/−1）

1. **顶部 imports**：新增 `hasPendingUserTodos` + `SIDEEFFECT_UNLINKED_WARNING`。
2. **executeSave 返回处**：拆 `base = 已保存记忆...` 文本，软门禁触发时返回 `${base}\n${SIDEEFFECT_UNLINKED_WARNING}`——主路径文本保持「已保存记忆」开头，便于消费方按前缀判定成功路径。

### `electron/tests/agent/tools/scope-gate.test.ts`（新建，107 行）

**两组测试共 6 用例**：
- **副作用软门禁（2）**：create_task 无挂靠 → TaskRow 顶层附 warning（id 仍 'T-900' 验证未阻断）；memory_save 无挂靠 → 返回串追加警告行（断言 `已保存记忆` 前缀与 `⚠` 标记）。
- **谓词一致性（4，T4 审查遗留项）**：四项种子 [pending user, in_progress user, completed user, pending agent] → true；改种子为 [completed user, pending agent] → false；空种子 → false；[completed agent, pending agent] → false（边界）。同时把 T1 导出的谓词 `hasPendingUserTodos` 锁定为生产行为——与 runtime-entry `pendingUserItems()` 闭包共用同谓词（`status !== 'completed' && source === 'user'`），防谓词分叉漂移。

**Mock 设计**（遵循 momo-test-rules）：
- `storage/tasks/repo`：insertTask 返回 `{id:'T-900', status:'assigned', recurrenceRule:null, ...input}`；transitionTaskStatus 用 vi.fn()
- `task/executor`：notifyExecutor 用 vi.fn()
- `memory`：getMemoryProvider 返回仅含 saveMemory 的桩

未实际接触 DB（无 runMigrations），保证速度与隔离。

### `electron/tests/agent/tools/task-tools-delegation.test.ts`（+6/−2）

T5 引入的新行为对原「有指派创建 → 无 warning 字段」测试产生影响——soft gate 触发条件是有指派 + 无 user 挂靠，与原测试的「无挂靠」假设冲突。修复方案：
1. **测试用例改造**：标题改为「有指派创建 + 有 user 挂靠 → 无 warning 字段」（声明式表达前置条件）；调用 create_task 前 `__setTodosForTest('ss-1', [{...source:'user'}])` 模拟用户挂靠，验证无 soft gate 路径。
2. **跨测试隔离**：`beforeEach` 与 `afterEach` 都 `__setTodosForTest('ss-1', [])`——todoStore 是模块级单例，前序测试残留会污染后续断言。

## 二、验证结果

| 测试范围 | 结果 |
|---|---|
| `tests/agent/tools/scope-gate.test.ts`（6 用例） | ✓ 6 passed |
| `tests/agent/tools/task-tools-delegation.test.ts`（6 用例） | ✓ 6 passed（回归绿） |
| `tests/agent/tools/` 全量（167 用例） | ✓ 167 passed |
| `--filter momo-studio-electron test` 全量（1644 用例） | ✓ 1644 passed |
| `npx pnpm@9.0.0 typecheck`（electron + renderer） | ✓ 双 clean |

## 三、关键设计取舍

1. **warning 不阻断操作**——brief 明示契约：create_task 返回体仍含真实 TaskRow 字段；memory_save 返回串仍以「已保存记忆」开头。两处实现都遵循此点：create_task 用 `{...result, warning}` 字段合并（TaskRow 字段全在顶层），memory_save 用 `\n` 拼接警告行（主文本前缀不变）。

2. **两条 warning 互斥而非叠加**——无指派走 NO_ASSIGNMENT_WARNING 优先（spec 已定义），有指派但失挂靠走 SIDEEFFECT_UNLINKED_WARNING。代码层面用 `if/if` 顺序实现（前者已 return，后者在 hasDelegationTarget=true 时才进入）。

3. **mock 收窄**——只 mock 进程/数据/异步边界（insertTask / getMemoryProvider / notifyExecutor），业务逻辑用真实实现（createTask 函数本体、hasPendingUserTodos 公共 API、JSON 序列化路径均未被 mock）。

4. **共享文案 vs 单点定义**——把警告文案提到 `shared/mandate-warning.ts` 是为了避免 task-tools 与 memory-tools 双份定义漂移（task-tools 已有 NO_ASSIGNMENT_WARNING 私人定义是历史债，本次不动）。

## 四、风险与遗留

- **未触碰 NO_ASSIGNMENT_WARNING**——既有 draft 死局警告文案仍独占于 task-tools.ts，未统一到 shared 层。范围控制决定不重构；后续可一并收敛。
- **谓词一致性已锁**——T4 闭包 `pendingUserItems`（runtime-entry.ts:317-320）与 T1 导出 `hasPendingUserTodos`（todo-tools.ts:49-53）共用同谓词表达式 `status !== 'completed' && source === 'user'`。scope-gate.test.ts 的 4 个用例覆盖了真值表关键拐点，但未来若引入新 status（如 `cancelled`）或新 source（如 `system`），需同步更新两处谓词+4 测试。