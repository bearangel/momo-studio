# Dispatch 同轮并发执行设计

- 日期：2026-08-25
- 状态：Approved（用户已批准方向与方案 B1）
- 影响版本：v2.0.x（小版本）
- 上游设计：`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（§dispatch / task-driven runtime）

## 1. 背景与问题

### 1.1 症状

用户测试 PM 派发场景时明确要求「并行启动子 agent」，但观察到的现象是：每个子 agent 严格串行执行——前一个完成（task_reply 到达）后，下一个才开始。

### 1.2 根因（证据链）

三层逐层断言，串行瓶颈唯一锁定在 PM 子进程的 chat loop 工具执行段：

| 层 | 结论 | 证据 |
|---|---|---|
| 主进程路由 | 支持并行 | `RouterService.routeDispatch`（router-service.ts:154）逐事件独立路由，无队列无互斥 |
| AgentRunner 执行 | 支持并行 | `activeTasks` 是 Map（keyed by streamSessionId），`activeTaskCount()` 本为并发检查设计；`WarmPool.acquire` 池空冷启动兜底（warm-pool.ts:111），K=2 仅是延迟优化非并发上限 |
| **PM chat loop** | **严格串行** | runtime-entry.ts:409 `for (const tc of toolCalls)` + :608 逐个 `await executeTool`；`executeDispatch`（dispatch-wait.ts:72-163）发出 dispatch 事件后阻塞等待 task_reply（渐进式超时 3+6 分钟） |

即：无论 LLM 怎么发（同轮 N 个 dispatch 调用、还是跨多轮），runtime 都逐个 await，串行是实现的必然。

### 1.3 矛盾点

PM 的 prompt（pm-agent.yaml:25）写着「多个子 agent 可以并行调度」，`formatDispatchHint`（prompt-hints.ts:23）也声称「任务可并行」——运行时不兑现 prompt 的承诺。用户测试时遇到的正是这个落差。

### 1.4 已就绪的基础设施

等待侧本来就按并发设计，改造只需聚焦 chat loop：

- `pendingReplies` Map 按 task_id 多路复用，可同时挂起多个等待（dispatch-wait.ts:62）
- 每 dispatch 独立 abort 监听器 + settle 清理（minor-10）
- `notifyTaskReply` 广播转发全部活跃子进程
- renderer DispatchChip 多 chip 纵向堆叠 + 各自独立状态（v1.4 并行委派展示已就绪）
- Provider 层同轮多工具调用解析已支持（OpenAI `toolCallMap` / Anthropic `toolUseMap` 按 index 合并 fragments，runChatLoop:366 逐个 push）

## 2. 目标与非目标

**目标**：PM 的 LLM 在同一次回复中发出 N 个 `dispatch:*` 工具调用时，这 N 个子 agent 并发执行；全部回执到齐后按原顺序回填 LLM 继续对话。

**非目标**（明确排除，防 scope 蔓延）：

- 跨轮并行（PM 拿 A 结果再决定派 B——存在决策依赖，串行是正确语义）
- 异步协议（dispatch 立即返回 task_id + `wait_for_replies` 收集工具）→ 留 v2.1，与已有「Agent 并发多任务（内部 task queue）」规划合并考虑
- 非 dispatch 工具的并发执行（文件 / bash / git 有副作用与顺序依赖，保持串行）
- 主进程路由 / AgentRunner / WarmPool / 内部事件桥 / renderer 的任何改动

## 3. 方案对比与决策

| 方案 | 机制 | 裁决 |
|---|---|---|
| **B1：连续段并发** | 扫描 `toolCalls`，把极大连续 dispatch 段作为一个批次 `Promise.allSettled` 并发；非 dispatch 工具原地串行，全局顺序不变 | ✅ **采纳** |
| B2：两阶段 | 先串行跑完所有非 dispatch，再并发所有 dispatch | ❌ 改变同轮 read→dispatch 的信息流；与 task_complete/compact 混排时行为怪异 |
| B3：全工具并发 | 每轮所有工具调用并发 | ❌ bash+write 冲突、审计乱序、GitPolicy 语义复杂化 |

**B1 的关键性质**：LLM 一轮输出 `[dispatch:A, read_file, dispatch:B]` 时，A、B 分属两个段各自执行，read_file 保持原位——与今天的串行语义逐位一致，唯一变化是「连续多个 dispatch」并发。

决策记录：

- **D1（范围）**：同轮并发，不做异步协议。理由：改动集中（3-4 倍工作量差距）、覆盖真实痛点（PM 同轮拆分多任务）、跨轮依赖本就不该并行。
- **D2（机制）**：B1 连续段并发。理由：语义完全保序，对混排 toolCalls 的行为可逐位对比串行实现。
- **D3（预算）**：并发批次 sub-budget 均分（见 §5.3），接受与串行「先到先得」的语义差异。
- **D4（教学）**：prompt 双点修正（builtin PM YAML + formatDispatchHint），教 LLM「同轮连发」这个可执行动作。

## 4. 核心机制：runChatLoop 工具循环重构

现状（runtime-entry.ts:409-660）`for (const tc of toolCalls)` 逐个 await。改为**三段式游标推进**：

```
i = 0
while i < toolCalls.length:
  ① 预检（对 toolCalls[i]，保持原顺序逐位）：
     - 重复检测（同名+同参 连续 MAX_DUPLICATE_TOOLS 次强制终止）
     - budgetRemaining <= 0 → end(budget_exhausted) 退出
     - task_complete / compact → 内联处理（不变），i++，continue
  ② 段识别：
     - toolCalls[i] 非 dispatch → 原路径串行执行（零行为差异），i++
     - toolCalls[i] 是 dispatch → 向后扫描极大连续 dispatch 段 [i, j)
  ③ 段执行：
     - 段长 1 → 走原路径（零行为差异）
     - 段长 K > 1 → 并发批次（见下）
     i = j
```

### 4.1 并发批次执行体

把现循环体内 dispatch 分支提取为 `execDispatchCall(tc)` 闭包（返回 settle 后的 result 信息），每个成员独立完成：

1. 预生成 `subStreamSessionId = randomUUID()`（现 :573 逻辑）
2. 发增强 `tool_call` chunk（isDispatch/subStreamSessionId/subAgentName，现 :577-587）——**K 个 chip 在批次启动时即刻全部出现**
3. `await executeTool(...)`（内部走 doExecuteTool → executeDispatch，不变）
4. settle 时各自发 `tool_result` chunk（成功 `subStatus:'completed'`；失败按错误文本区分 `timeout`/`failed`，现 :609-649 语义）

批次用 `Promise.allSettled` 等全部成员 settle。

### 4.2 消息回填顺序

批次全部 settle 后，`messages.push({ role:'tool', ... })` **按原 toolCalls 顺序**回填（不按完成顺序）。OpenAI / Anthropic 协议均要求 assistant.toolCalls 与后续 tool 消息按 id 一一对应，乱序回填会破坏下一轮请求体。

### 4.3 段内预检的截断规则

段扫描时按原顺序对段成员做重复检测与预算检查，可能截断段长：

- 重复检测在第 m 个成员命中 → 段截断为 [i, m)，执行后走重复终止路径（end + 终止文案）
- `budgetRemaining < K` → 段截断为前 `budgetRemaining` 个；被截断的成员不发 tool_call chunk（与串行实现「预算耗尽在预检退出、不发 chunk」逐位一致）；执行完已发成员后 end(budget_exhausted) 退出
- `budgetRemaining <= 0`（段首即耗尽）→ 直接 end(budget_exhausted) 退出
- 预算无限（Infinity）→ 不截断

## 5. 预算语义

### 5.1 现状（串行）

每次 dispatch 执行后 `budgetRemaining--`（自身占 1），再按回执 `toolCallsUsed` 追扣（runtime-entry.ts:652-656）。子 agent 的 sub-budget = 执行时刻的 `budgetRemaining - 1`——先执行的子 agent 拿到更多预算（先到先得）。

### 5.2 新语义（并发批次）

- **段开始时一次性预扣**：`budgetRemaining -= K_actual`（实际执行的段长）
- **sub-budget 均分**：每个并发成员的 dispatchToolBudget = `max(0, budgetRemaining_段前 - K_actual)`。串行时后发者拿到更少；并发无法预知各成员消耗，改为均等——**这是唯一有意的语义变化**（D3）
- **段结束后追扣**：按各成员回执 `toolCallsUsed` 逐个扣减
- `toolCallCount` 在各成员 settle 时递增（与串行「执行完成后计数」一致；abort 路径不计入未完成的）

## 6. 中断与错误语义

### 6.1 中断（abort）

- 批次全部成员共享同一 `ctx.abortSignal`；abort 时 executeDispatch 的 per-pending onAbort 全部触发（minor-10 清理已就绪），各自 reject `AbortError`
- allSettled 收齐后，批次边界检测任一成员 AbortError / `abortController.signal.aborted` → 走现有中断退出路径（process.off + end(interrupted) + return），不向 LLM 回填 tool result——与串行 catch 分支（现 :622-631）语义一致，防「中断-重试」死循环
- 子进程收到的 `task-reply` / 主进程 `abortStream` 广播路径零改动

### 6.2 单个成员失败

某成员超时（executeDispatch 渐进式计时器 reject）/ 子 agent 回 failed/needs_input → 仅该成员 tool_result 标 `subStatus:'timeout' | 'failed'`，其余成员不受影响（allSettled 不短路）。LLM 在下一轮看到全部成员结果（含失败）自行决策——与串行语义一致。

### 6.3 dispatchInfo 竞态防护

每个成员持独立 `dispatchInfo = { toolCallsUsed: 0 }` 对象（现循环体逐次创建的模式保留），回填时从各自对象读取——禁止跨成员共享对象（否则追扣错乱）。

## 7. Prompt 教学（两处）

### 7.1 pm-agent.yaml（builtin PM）

第 25 行「多个子 agent 可以并行调度。」改为可执行指令：

> 需要并行调度多个子 agent 时，在**同一次回复中连续发出多个 dispatch 工具调用**，它们会被并发执行；全部回执到齐后你会一起收到结果。

### 7.2 formatDispatchHint（prompt-hints.ts，对全部自定义 main agent 生效）

「主动拆分原则」新增一条：

> 子任务相互独立时，在同一次回复中连续发出多个 dispatch 调用并行执行，不要拆到多轮（多轮 = 串行等待）

同时修正注释中「任务可并行」的表述与实现一致。

## 8. 契约影响面（momo-boundary-rules 自查）

**零协议改动**。逐契约面核对：

| 契约面 | 影响 | 核对 |
|---|---|---|
| `StreamChunk`（runtime → stream-relay） | 无改动 | tool_call / tool_result 形状不变；仅同 streamSessionId 下多个 chip 并存，renderer v1.4 已支持 |
| `DispatchContent` / `TaskReplyContent` | 无改动 | 字段、生产点（executeDispatch）、消费点（handleTaskReply）全不动 |
| `sub_stream_session_id` 查找键 | 无改动 | 每成员仍独立预生成（:573 逻辑迁入闭包），P0-7 修复保持 |
| 内部事件桥 / RouterService / AgentRunner | 无改动 | 并发 dispatch = 多条独立事件，路由层本就并发安全 |
| preload / renderer | 无改动 | 无新 IPC 通道、无类型变更；两 workspace typecheck 照常跑 |
| pm-agent.yaml | 文案改动 | builtin YAML 文案，非协议；启动加载路径不变 |

## 9. 测试策略

新文件 `electron/tests/agent/dispatch-parallel.test.ts`，沿用现有 dispatch 测试驱动方式（mock chatStream + 真实 internal-event 通道 + 真实 `handleTaskReplyIpc` 驱动回执，不 mock executeDispatch 内部）：

1. **并发性回归锁（核心）**：同轮 2 个 dispatch；A 的 dispatch 事件发出后安排 50ms 延迟回执，B 发出后 10ms 回执。断言 B 的 dispatch 事件在 A 回执到达**之前**已发出（串行实现下 B 根本不会在 A 回执前发出——此断言红→绿即本设计的回归锁），且 B 的 tool_result chunk 先于 A 到达
2. **消息回填顺序**：B 先完成，`messages` 中 tool 消息仍按原 toolCalls 顺序（A 前 B 后）
3. **预算**：budget=5、2 个 dispatch 各报 toolCallsUsed=3 → 段后余 0；budget=1、段长 2 → 只发 1 个 + end(budget_exhausted) + 未发成员无 tool_call chunk；sub-budget 均分断言（两成员拿到相同的 dispatchToolBudget）
4. **中断**：批次中途 abort → end(interrupted)、pendingReplies 清空、无 tool result 回填
5. **段长 1 回归**：单 dispatch 路径行为与现状逐位一致
6. **混排**：`[dispatch:A, read_file, dispatch:B]` → read_file 原位串行、A/B 各自成段
7. **重复检测 / task_complete / compact**：与 dispatch 混排时预检顺序与截断规则（§4.3）

现有测试全绿保持：`dispatch-fresh-session` / `runtime-stream` / `runtime-segment` / `runtime-entry-routing` 等不得回归。

## 10. 风险与边界

| 风险 | 评估 |
|---|---|
| trace 日志交错（dev 模式） | 可接受，仅诊断输出 |
| 同一子 agent 同轮被 dispatch 两次 | 执行层支持（activeTasks Map 多活跃 + WarmPool 冷启动兜底）；两个 chip 各自独立流 |
| 嵌套场景（子 agent 自身也是 main，再并发 dispatch 孙 agent） | 机制递归成立，无需特判 |
| LLM 不配合同轮连发 | prompt 教学引导；不发则退化为现状串行，无害 |
| 均分预算 vs 先到先得 | 有意语义变化（D3），spec 明示；极端场景（总预算仅够 1 个）由截断规则保护 |

## 11. 影响文件清单

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/runtime-entry.ts` | 核心：工具循环三段式重构 + execDispatchCall 闭包 + 预算预扣 |
| `electron/src/main/agent/prompt-hints.ts` | formatDispatchHint 教学新增 + 注释修正 |
| `electron/resources/agents/pm-agent.yaml` | prompt 文案修正 |
| `electron/tests/agent/dispatch-parallel.test.ts` | 新增：并发回归锁 + 预算/中断/顺序用例 |
| `CHANGELOG.md` | 发布时补记（非本设计交付物） |

## 12. 验收标准

1. 同轮 N 个 dispatch：N 个子 agent 子进程并发运行（消息时间线重叠），chip 同时显示「执行中」
2. 全部回执后 LLM 收到按原顺序回填的 N 条 tool result，对话正常继续
3. 单个成员失败 / 超时不影响其余成员
4. 停止按钮在并发批次期间有效（全部成员立即中断）
5. 预算截断 / 耗尽行为与串行逐位一致（截断规则 §4.3）
6. 既有 dispatch / runtime 测试套件全绿；新增 dispatch-parallel 测试全绿；typecheck 双 clean
