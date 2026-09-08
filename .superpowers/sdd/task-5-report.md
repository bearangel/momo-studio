# Task 5 报告：K7-3 精确中止接线

**状态**：✅ 已交付
**BASE**：0a289f3（T3 回归修复后）
**HEAD**：109ef46
**任务计划位置**：6 任务计划第 5 个（T5 精确中止接线，依赖 T2 abortTaskStreamByLane + T4 steer）

---

## 交付内容

按 brief 4 步执行——两处改动均逐字采用 brief 内文，仅 `abortTaskExecutionIfAny` 函数体追加 `if (abortTaskStreamByLane(taskId)) return;` 短路守卫 + 函数注释更新为 K7-4 + v2.3 双标。

### 修改文件（2）

1. **`electron/src/main/task/ipc.handlers.ts`**
   - import 区补 `import { abortTaskStreamByLane } from '../agent/session-lane';`（紧邻 `runtime-registry` 同源）
   - `abortTaskExecutionIfAny`（原 :77-81）函数体重写——先按 taskId 精确反查车道命中即返回；车道无记录（流未注册的窗口 / 旧数据 / dispatch 子流）回退原 K7-4 行为按 `executionSessionId` 广播
   - 注释更新为「K7-4 + v2.3 精确中止（spec §6）」，明确双语义并标注 fallback 触发场景

2. **`electron/tests/agent/session-lane.test.ts`**
   - 「K7-3 精确中止」describe 追加第 3 用例——同会话另一任务的车道流不被误中止（双车道场景）：注册 T-1/s-a 到 room-1 + T-2/s-b 到 room-2 → `abortTaskStreamByLane('T-2')` → 断言只命中 `s-b`、调用 1 次

### 关键设计点

- **优先级反转**：从「DB 优先 + 全会话广播」改为「车道优先 + DB 兜底广播」。T2 已交付的 `abortTaskStreamByLane(taskId) → boolean` 是单一入口——true 短路返回；false 走原 K7-4 兜底（spec §6 双语义设计）
- **误杀根因消除**：v2.3 前 `abortTasksBySessionEverywhere(executionSessionId)` 按会话全量广播，同会话的 PM 主流 + dispatch 派生的多个子流被一并 abort。dispatch 子流未注册车道（spec §4.1），现在不会被精确分支误伤；旧数据（执行中但 lane 未注册的窗口）兜底广播兜住
- **T2 审查裁决（M-5）语义对齐**：abortTaskStreamByLane 的 false = 「车道无记录」∪「resolver 未注入」，回退广播是安全方向——注释「车道无记录（流未注册的窗口 / 旧数据）」措辞沿用此裁决

### 非改动文件

- `electron/src/main/agent/session-lane.ts` — 仅消费 T2 已交付的 `abortTaskStreamByLane`，本任务不触碰
- `electron/src/main/agent/runtime-registry.ts` — `abortTasksBySessionEverywhere` 仍保留作为兜底调用方
- `electron/src/main/agent/stream-relay.ts` — 真实签名经 `tests/agent/session-lane.test.ts` 的 vi.mock 保持形状

---

## 验证结果

### 1. 单元测试（electron 任务域 + agent 域）

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/session-lane.test.ts tests/task
```

| 项 | 数值 |
|---|---|
| Test Files | **17 passed (17)** |
| Tests | **113 passed (113)** |
| Duration | 2.41s |

- session-lane.test.ts 5 用例全绿（含新增双车道用例）
- task 域 108 用例零回归（含 `task:create / task:transition` 等既有覆盖）

### 2. 类型检查（electron + renderer 双 workspace）

```bash
npx pnpm@9.0.0 typecheck
```

```
electron typecheck: Done
renderer typecheck: Done
```

零错误，strict mode 通过（无 `any`、无 `@ts-ignore`、无 `as any`）。

---

## Commit

```
109ef46 fix: 任务暂停/取消按 taskId 精确中止执行流（K7-3 不再误杀 dispatch 子流）
```

- 修改文件：2（ipc.handlers.ts、session-lane.test.ts）
- Diff：+14 / -3

---

## 风险与边界

- **execution_session_id 为 NULL 的旧任务**：原代码直接 return，新代码走 abortTaskStreamByLane → false → 再判 row.executionSessionId 为 NULL → return。行为不变（保守兼容）
- **lane 注册后又被 runtime-registry 清理的窗口**：abortTaskStreamByLane 返回 false（resolver 不可见），触发兜底广播——T2 M-5 裁决认定这是安全方向，不回归
- **dispatch 子流场景**（PM 主流 + 多个并行子流）：主流注册车道，子流未注册；中止 PM 任务 → abortTaskStreamByLane 命中主流短路；中止某个子任务 → 子任务本身无 taskId 关联的车道，回退广播把同会话全部流 abort——这是已知 trade-off，子流本身有自己的 taskId 后才能精细化，本任务不触及（spec D7 + §6 双语义兜底）
- **运行时未注入 resolver**（startup 早期窗口）：abortTaskStreamByLane 返回 false，回退广播兜住
- **T4 steer 链路无影响**：steer 走 child.send 不经 abort 路径，正交设计（已在 T4 报告 §关键设计点明示）

---

## Next / Open

- **T6**（计划第 6 个任务，依赖 T5）：建议作用域 = 主路径端到端验证 + renderer 暂停/取消按钮接线联调 + macOS 主机验收清单对齐
- **遗留观察项**（非本任务）：dispatch 子流的 taskId 透传 + 独立车道注册若 PM 编排需要，可作为 v2.4+ 增强——本任务明确不实现（brief MUST NOT DO 第 2 条）

---

## 与上四任务的关系

| 任务 | 状态 | 关联 |
|---|---|---|
| T1 TaskStatus 'session_queued' | ✅ 已交付 | 状态机扩展，K1 调度链路前置 |
| T2 session-lane 模块 | ✅ 已交付 | `abortTaskStreamByLane` 本任务的消费依赖 |
| T3 车道接线 | ✅ 已交付 | executor 放行 gate，本任务的同主线支撑 |
| T4 steer 链路 | ✅ 已交付 | 与本任务正交（abort vs steer） |
| **T5 精确中止接线（本任务）** | **✅ 已交付** | **K7-3 误杀修复，按 taskId 精确中止 + 兜底广播** |
