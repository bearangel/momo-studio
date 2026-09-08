# Task 4 报告：TaskExecutor 队列放行模块

## 实施摘要

按 brief TDD 五步执行（失败测试 → RED → 实现 → GREEN → 提交）。6 个用例全绿，全仓 1485 测试零回归。executor 主体逐字采用 brief 代码，另有 **6 处必要偏差**（2 处任务指示预先批准的 DDL 修正、1 处 brief 笔误、1 处 strict 类型必要兜底、1 处 brief 自身注释声明但未实现的防热循环补全、1 处 spec 与现状冲突的调停），全部在下文逐条列出依据。

## TDD 证据

### RED（两轮）

1. **executor 模块不存在**（brief Step 2 预期失败形态）：
   ```
   FAIL tests/task/executor.test.ts
   Error: Failed to load url ../../src/main/task/executor ... Does the file exist?
   ```
2. **状态机 assigned→failed 先红**（独立 TDD 回归锁，见「偏差 6」）：
   ```
   FAIL task-state-machine.test.ts > assigned → failed（executor 目标校验失败路径，spec §5.1/§9）
   AssertionError: expected false to be true
   ```

### GREEN

```
Test Files  2 passed (2)
     Tests  31 passed (31)      # executor 6 用例 + 状态机 25 用例
```

### 全量验证

- `npx pnpm@9.0.0 test`（electron 全仓）：**178 文件 / 1485 测试全绿**，状态机扩展零回归
- `npx pnpm@9.0.0 typecheck`：clean（strict + noUncheckedIndexedAccess）
- `npx eslint src/main/task/executor.ts src/main/storage/tasks/state-machine.ts`：clean
- lsp_diagnostics：两文件零诊断

## 文件变更（4 个）

| 文件 | 变更 | 关键内容 |
|---|---|---|
| `electron/src/main/task/executor.ts` | 新建 262 行 | TaskExecutor：admitOnce 并发 gate + 放行排序 + validateTarget + startTask + kickoff 注入；notify 100ms 去抖（timer unref）；start/stop 30s 兜底扫描；模块级单例 `taskExecutor` + `notifyExecutor()` |
| `electron/tests/task/executor.test.ts` | 新建 141 行 | brief 逐字 6 用例 + DDL 修正后的 seedAgentMember + kind 修正 |
| `electron/src/main/storage/tasks/state-machine.ts` | +3/-1 行 | `assigned` 合法转换集加 `'failed'` + 头注释同步（偏差 6） |
| `electron/tests/storage/task-state-machine.test.ts` | +5 行 | `assigned → failed` 正向用例（RED→GREEN 回归锁） |

## 与 brief 的偏差（6 处，均有依据）

1. **seedAgentMember 按当前 DDL 修正**（任务指示预先批准，Task 3 同款）：brief 原始 INSERT 缺 NOT NULL 列且列名过期——`agent_definitions` 实际 NOT NULL 为 id/name/slug/version/system_prompt/model_name（`model_provider` 已于 v13 DROP，表无 `updated_at` 列）；`workspace_agent_members` 实际 NOT NULL 含 `agent_user_id`，时间列是 `created_at`（带 DEFAULT）而非 `added_at`。
2. **insertSession kind 'quick' → 'chat'**（任务指示预先批准）：sessions DDL `CHECK (kind IN ('chat','task_execution'))` + repo TS 联合类型均不容 'quick'（v25 会话双类型是概念层用语，未落 DDL）。
3. **`export class TaskExecutor`**：brief 源码漏写 `export`，但其自身测试 `import { TaskExecutor }`——笔误，必须导出。
4. **`getGlobalSettings().maxConcurrentTasks ?? 3`**：`GlobalSettings` 类型上该字段可选（`number | undefined`），裸相减在 strict 下编译错误；末位 `?? 3` 与 `settings/crud.ts` 读侧默认值对齐。
5. **admitOnce 增加 round 级 `skipped` 集合**（补全 brief 自己声明的语义）：brief 的 `peekNextAssigned` 注释写明「排除本轮已处理过的失败候选」、startTask 抛错分支注释写明「本轮跳过」，但其实现 `continue` 后会再次 peek 到**同一个仍处于 assigned 的候选**——validate 失败/kickoff 失败者已转 failed 自然出队，但 **startTask 持续抛错者（如磁盘满导致事务恒败）会无限热循环**（admitting 标志使 notify/sweep 全部失效，事件循环空转 + 日志洪水）。skipped 集合以占位符参数绑定拼入 `NOT IN`，候选本轮跳过、留给兜底扫描重试——正是注释声明的行为。
6. **状态机 `assigned` 转换集加 `'failed'`**（spec 调停，最重要的一处）：spec §5.1 算法第 1 步「无效 → transition failed + errorMessage 明示」、§9 边界表「目标已删 → 转 failed 带明示 errorMessage」、§10 测试清单「目标校验失败→failed」三处规范性要求 assigned→failed；但现行状态机 `assigned: {in_progress, cancelled}` 不含 failed，且 plan 头部写「状态机零改动」——二者直接冲突。不做调停的后果不是测试失败而是**测试挂死**（failQuietly 抛错被吞 → 任务滞留 assigned → peek 反复选中同一候选 → 死循环）。裁定依据：spec 算法节是规范性的，而「状态机零改动」两处出处各自语境是「不新增 queued 状态」（D3 决策）与「paused 恢复队列化留待后续」（§228 范围外清单），均不针对 assigned→failed；且已确认既有状态机测试无 assigned→failed 非法断言、全仓 1485 测试无回归。独立提交（f1405a2）先行，含自己的 RED→GREEN 用例。

## 自审（任务指示的三个重点）

- **while 循环 + slots 重查（防超放）**：每次成功放行后 `slots = max - countInProgress()` 以 DB 为准重查（不信任内存计数）；`!launched` 路径不消耗槽位（validate 失败者已出队、startTask 抛错者跳过）；`admitting` 互斥使并发的 notify/sweep 调用直接 no-op。放行前 count、放行后 re-count，单轮内不可能超放。
- **peekNextAssigned 竞态防御**：SELECT 与 getTask 读取之间逐条复查 `status === 'assigned'`；排除子句只拼接占位符（skip 内容是内部生成的任务 id，仍全程参数绑定，无注入面）。
- **notify 去抖 timer unref**：已带 `this.notifyTimer.unref?.()`，不会挂住事件循环。注：`start()` 的兜底扫描 interval 按 brief 原样**未** unref——主进程常驻语义下无害，但 Task 5 接线时若在非常驻上下文调用 `taskExecutor.start()` 需配对 `stop()`。

## 测试保真度自查（momo-test-rules）

- kickoff fake 挂在生产注入缝（`deps.sendKickoff`）而非 mock 内部模块——mock 收窄铁律 ✓
- 全程真实 better-sqlite3（tmp 目录 + runMigrations），无 DB mock ✓
- 断言生产消费字段（status / errorMessage / executionSessionId / sessionId / mentionedInstanceIds / body）✓
- 错误路径专项：并发满 / 目标无效 / kickoff 抛错 / pending+draft 不参与 ✓

## 顾虑 / 后续提示

1. **lint 存量债务（非本任务）**：`src/main/agent/ipc.handlers.ts:58` 有一个预先存在的 `no-unused-vars` error（`'AgentDefinition' is defined but never used`），非本任务文件、brief 未授权，未处置——全量 `pnpm lint` 会红，建议后续任务顺手清或单独 chore。
2. **偏差 6 请 plan owner 知悉**：若后续任务发现「状态机零改动」的其它依赖（目前全仓测试无冲突），spec/plan 文档宜补一句勘误说明 assigned→failed 的开放。
3. Task 5（runtime-init 接线）将注入真实 sendKickoff 并调用 `taskExecutor.start()`——注意上面自审第 3 点的 stop() 配对。

## 提交

- `f1405a2` feat: 状态机新增 assigned→failed 转换——executor 目标校验失败路径前置（spec §5.1/§9）
- `2875a27` feat: TaskExecutor 队列放行模块——全局并发 gate + kickoff 注入 + 写触发去抖（brief 指定的精确 message 与文件清单）
