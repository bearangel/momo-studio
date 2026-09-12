# Spec #6 Orchestration 元语 — 子 agent 续接与异步派发

**版本**：v0.1（brainstorming 后落地）
**日期**：2026-09-12
**状态**：spec approved → plan → SDD

## 0. 背景与动机

Momo 的编排面现状是「两套心智 + 两个缺口」：会话内 `dispatch:<slug>`（同步阻塞，leader 等待 task_reply，渐进超时 3+6 分钟）与任务板委派（`create_task` 异步调度）并存；而对比 Claude Code / opencode / Cursor 的核心差距：

1. **子 agent 不可续接**——每次 dispatch 一次性 body 进 / reply 出，无法追问（opencode 的 `task(task_id=...)` 续接模式是高频刚需）
2. **无 fire-and-forget + gather**——leader dispatch 后必须当场等完，想先干别的再收结果做不到

本 spec 补这两族正交原语：**dispatch_followup（replay 续接）** + **dispatch_bg / gather / status / cancel（异步句柄族）**。

## 1. 目标与非目标

### 1.1 目标（In Scope）

| ID | 描述 |
|---|---|
| G1 | `dispatch_followup(taskId, question)`——replay 重建子会话历史后 re-spawn 续聊；复用 v2.6 turn-reconstructor 的重建语义（孤儿 tool_call 合成中断 result + 降级） |
| G2 | `dispatch_bg:<slug>(task)`——非阻塞派发，立即返回 `{ taskId }` 句柄（taskId 即句柄，不另造 ID 空间） |
| G3 | `dispatch_gather(handles, mode, timeoutMs?)`——`all`\|`any` 收割；迟到 reply 缓存命中；超时不判死（返回 done/pending 结构，句柄可再 gather） |
| G4 | `dispatch_status(handle)` 单句柄查询；`dispatch_cancel(handle)` 取消在途（复用 abort_dispatch 链路，幂等） |
| G5 | 5 个新工具全部走既有 leader 会话边界门（`getSessionDispatchScope`）；路由链 `routeDispatch → executeTask` **零改动复用** |
| G6 | 零新表零新迁移：followup 重建走 `message_events`（既有真相源）；bg 句柄纯内存；`TaskConfig` 加 1 可选字段 `historyPrefix` |

### 1.2 非目标（Out of Scope）

- ❌ **孙 agent 嵌套**——子 agent 非会话 leader 天然无 dispatch 工具，维持禁止（spec 明示边界）
- ❌ **followup_bg 组合**——followup 仅同步（YAGNI）
- ❌ **跨重启 bg 句柄持久化**——句柄生命周期 = PM runtime 子进程；重启后 status 报 not_found（明示边界）
- ❌ **结构化 reply schema**——reply 仍纯文本（Q1-D 已拒）
- ❌ **同链 chip 分组 UI**——每轮新 chip 独立渲染（YAGNI）
- ❌ **dispatch 统一糖重构**——既有同步 dispatch 原样保留；bg/gather 是新增正交面
- ❌ followup 轮数硬上限——无限（token 自然约束，工具描述教收敛）

## 2. 架构

### 2.1 分层

```
                    ┌─ 续接族 ─────────────────────────────────┐
                    │ dispatch_followup(taskId, question)      │
                    │   replay 重建 → re-spawn 续聊（同步等待） │
                    └──────────────────────────────────────────┘
Leader chat loop ───┤
                    └─ 异步族 ─────────────────────────────────┐
                     │ dispatch_bg:<slug>(task) → {taskId}     │
                     │ dispatch_gather / status / cancel       │
                     └─────────────────────────────────────────┘

复用不动：dispatch:<slug>（同步）/ dispatch-parallel 批处理 /
         routeDispatch → runner.executeTask 路由链 /
         handleTaskReply 单点收口 / abort_dispatch 级联
```

### 2.2 关键不变量

1. **taskId = 链 ID**——多轮 followup 沿用原 dispatch 的 task_id；历史查询 `WHERE task_id = ?` 天然聚合全部轮次；串行轮次下 `pendingReplies` 键安全（上轮已 settle 删除）
2. **historyPrefix ≠ resumeTurn**——resume 是「恢复中断」（messages 非空则不追加 body）；followup 是「续聊」（前缀 + 新 user 轮）。两个正交载荷字段，互不干扰
3. **每轮新 subStreamSessionId**——renderer DispatchChip 按它渲染，新轮次自然新 chip（v2.8.0 实现边界：followup chip 未实装——followup 分支不发 isDispatch chip，子流带 parentStreamSessionId 被 MessageList 过滤出顶层且无 chip 匹配，续聊答案仅经工具卡 result 文本可见；chip 实装与 bg chip 终态翻转同批排 v2.8.x）
4. **handleTaskReply 单点收口**——pendingReplies miss 时查 bgHandles（新分支），reply 路径不fork
5. **bg 句柄内存态**——`Map<taskId, BgHandle>`；in_flight → done 翻转后结果保留至回合结束
6. **全部新工具过会话边界门**——注入面（runChatLoop 的 sessionSubs 过滤）+ 执行面（assertSessionDispatchAllowed）双防线，与既有 dispatch 同标准

## 3. 续接族：dispatch_followup

### 3.1 数据流

```
LLM: dispatch_followup(T-xxx, "把结论展开成表格")
1. 校验
   a. 链存在：该 task_id 有 dispatch 消息事件且 dispatch_from === 自己
      （只能追问自己派出的链）
   b. 同链无在途轮次：pendingReplies / bgHandles 无该 taskId 的未 settle 条目
      （上轮 settle 后才可再 followup——防同键竞态，§13）
   c. 会话边界：目标 agent 仍是本会话成员（assertSessionDispatchAllowed）
2. rebuildSubConversation(taskId)
   从 message_events 重建该链全部轮次的 LLM messages：
   - 完整 assistant 文本 / 工具对 verbatim 保留
   - 孤儿 tool_call（被中断的轮次）合成 [执行中断] tool result
     （复用 turn-reconstructor 语义与常量）
   - 多轮追问：每轮的 user 追问即链内 user 消息
   - 重建抛错 → 降级：historyPrefix 为空 + 前缀提示注入 question
     （"（此前对话历史不可用）"——不阻断）
3. 派发：TaskConfig { taskId: 原 ID, body: question,
       historyPrefix: 重建 messages, streamSessionId: 新 UUID }
   → routeDispatch 既有链路 → 子 agent runChatLoop
4. 子 agent：messages = [system, ...historyPrefix, user(question)]
   （runChatLoop 新分支：historyPrefix 存在时拼接前缀 + currentBody 照常追加）
5. 同步等 task_reply（pendingReplies + 渐进超时，同既有 dispatch 语义）
```

### 3.2 runChatLoop 签名扩展

```typescript
// TaskConfig 新增（runtime-config.ts）：
historyPrefix?: LLMMessage[];  // followup 续聊前缀（重建的子会话历史）

// runChatLoop 拼接顺序（与 resumeTurn 分支互斥、优先级低于 resumeTurn）：
// messages = [system, ...(historyPrefix ?? []), ...convMessages,
//             ...turnMessages]
```

`historyPrefix` 仅 followup 路径设置；resumeTurn 仅恢复路径设置；两者不同时出现（派发侧互斥，runChatLoop 防御性处理：resumeTurn 优先）。

### 3.3 重建器（`electron/src/main/agent/sub-history-reconstructor.ts` 新建）

- 输入：`taskId`（链 ID）+ 会话边界（executionSessionId 过滤）
- 查询：该 task_id 关联的全部消息行（messages.task_id = 链 ID，createdAt 升序）+ 各行 message_events
- 聚合：与 turn-reconstructor 同构的事件聚合（text/tool_call/status 状态机），跨多轮拼接；孤儿 tool_call 合成中断 result
- 输出：`LLMMessage[]`（不含 system——system 由 runChatLoop 组装）+ `rounds: number`（统计信息）
- 降级：任何异常 catch → 返回 `{ messages: [], rounds: 0, degraded: true }`

## 4. 异步族：bg 句柄

### 4.1 句柄表（dispatch-wait.ts 内）

```typescript
interface BgHandle {
  slug: string;
  status: 'in_flight' | 'done' | 'cancelled';
  startedAt: number;
  /** settle 后填充 */
  body?: string;
  toolCallsUsed?: number;
  completedAt?: number;
}
const bgHandles = new Map<string, BgHandle>();  // taskId → 句柄
const BG_HANDLE_LIMIT = 8;  // 同 PM 在途上限
```

### 4.2 各工具语义

**`dispatch_bg:<slug>(task)`**
- 同 executeDispatch 派发链路（buildDispatchMessage + sendDispatchEvent）
- 差异：不注册 pendingReplies；注册 bgHandles（in_flight）
- 在途数 ≥ 8 → 工具报错（含在途句柄清单，教 LLM 先 gather/cancel）
- 返回 `{ taskId }`

**`handleTaskReply` 扩展（单点收口）**
```
pendingReplies 命中 → 既有逻辑不变
miss → 查 bgHandles：
  命中且 in_flight → 存 {status:'done', body, toolCallsUsed, completedAt}
  命中且非 in_flight（cancel 后迟到的 reply）→ 保留 cancelled 态，忽略 body
  未命中 → 既有「迟到 reply」warn 路径
```

**`dispatch_gather(handles[], mode, timeoutMs?)`**
- 已 done / cancelled 句柄视为终态立即收集（cancelled 收集为 `{taskId, status:'cancelled'}`，无 body——不算错误不阻塞 mode=all）；in_flight 句柄注册 Promise（复用 pendingReplies 机制——把 bg 句柄临时转入等待：reply 到达即 resolve）
  - 实现裁定：gather 等待不直接复用 pendingReplies 键空间（taskId 已被 bgHandles 占有语义）——用**独立 gatherWaiters: Map<taskId, Set<resolve>>**，handleTaskReply 的 bg 分支同时唤醒 waiter
- `mode='all'`：全部 settle 或超时；`mode='any'`：任一 settle 即返回
- 超时：返回 `{ done: [{taskId, body, toolCallsUsed}], pending: [taskId...] }`——**非错误**，句柄保留可再 gather
- 全部完成：返回 `{ done: [...], pending: [] }`
- gather 不删句柄（可重复 gather 已 done 句柄——幂等读）

**`dispatch_status(handle)`**
- 返回 `{ status, body?, toolCallsUsed?, elapsedMs }`；not_found → `{ status: 'not_found' }`（重启后/未知 ID）

**`dispatch_cancel(handle)`**
- in_flight → 发 abort_dispatch（既有 routeAbortDispatch 链路）+ 句柄标 cancelled；返回 `{ status: 'cancelled' }`
- 已 done/cancelled → 幂等 no-op 返回当前状态
- not_found → 同 status 语义

### 4.3 abort 级联

PM 自身 abort（用户停止）：既有 abortStream 链路杀 PM chat loop；**在途 bg 句柄不主动 cancel**（子 agent 继续跑完，句柄随进程生命周期消亡——PM 子进程结束时 bgHandles 自然丢）。此为明示边界：PM 停止后 bg 结果不可收。

## 5. 工具定义（5 个新面）

| # | 工具 | 输入 | 输出 | 注入条件 |
|---|---|---|---|---|
| 1 | `dispatch_followup` | `{ taskId: string, question: string }` | reply body 文本（同 dispatch） | leader 会话边界（同 dispatch:<slug>） |
| 2 | `dispatch_bg:<slug>` | `{ task: string, toolBudget?: number }` | `{ taskId }` | 同上 |
| 3 | `dispatch_gather` | `{ handles: string[], mode: 'all'\|'any', timeoutMs?: number }` | `{ done: [...], pending: [...] }` | 同上 |
| 4 | `dispatch_status` | `{ handle: string }` | `{ status, body?, ... }` | 同上 |
| 5 | `dispatch_cancel` | `{ handle: string }` | `{ status }` | 同上 |

工具描述（中文，LLM 视角）明确使用模式：
- followup：对已 dispatch 完成的任务追问；保留全部上下文
- bg：「派发后立即返回，可继续其他工作，稍后 gather 收割」
- gather：超时不是错误——pending 句柄仍可再等
- cancel：长任务止损

timeoutMs 钳制：1000–600000（1 秒到 10 分钟），缺省 120000。

## 6. 与既有系统的接缝

- **routeDispatch**：零改动（bg/followup 派发都用它；followup 经 TaskConfig.historyPrefix 携带前缀）
- **handleTaskReply**：+bgHandles 分支 + gatherWaiters 唤醒（单点收口不破）
- **dispatch-parallel**：execDispatchCall 的批处理仅作用于同步 `dispatch:<slug>`（isDispatch 判定不变）；bg 工具不参与批处理（各自独立 tool call）
- **TaskTools 任务板**：完全无关（两套心智并存维持）；工具描述不交叉引导
- **turn-reconstructor**：followup 重建器是新文件但复用其事件聚合语义与 INTERRUPTED_TOOL_RESULT 常量（import 共享，不复制）
- **WarmPool / resume**：followup 的 historyPrefix 与 v2.6 resumeTurn 互斥（§3.2）；任务断点续跑（任务板路径）不受 followup 影响

## 7. 生命周期

| 事件 | 行为 |
|---|---|
| bg 派发 | bgHandles.set（in_flight）；不注册 pendingReplies |
| reply 到达（无 gather 等待） | 句柄翻转 done + 结果缓存 |
| reply 到达（有 gather 等待） | 翻转 + 唤醒 waiter |
| gather 超时 | 句柄保留；waiter 清理 |
| PM 回合结束 | bgHandles 保留（跨回合可 gather——同子进程内） |
| PM runtime 重启 / app 重启 | 句柄全丢（status → not_found；spec 明示边界） |
| followup 轮次 | taskId 不变；每轮新 subStreamSessionId；上轮 settle 后才可再 followup（pendingReplies 键安全） |
| PM abort | 在途 bg 不主动 cancel（§4.3 边界） |

## 8. 错误处理

| 错误 | 信息（LLM 可见） |
|---|---|
| followup 链不存在 | `任务链 ${taskId} 不存在——仅可追问自己此前 dispatch 的任务` |
| followup 非自己派出 | 同上（统一文案，不区分以省探测） |
| 目标已离会话 | 既有跨会话委派错误文案 |
| 重建失败 | 降级非错误（historyPrefix 空 + question 前缀提示） |
| bg 超上限 | `在途后台任务已达上限（8）：[清单]——请先 gather 或 cancel` |
| gather 超时 | 非错误（done/pending 结构） |
| cancel 已终态 | 幂等返回当前状态 |
| status/cancel/gather 句柄不存在 | `{ status: 'not_found' }`（gather 对 not_found 句柄：单句柄忽略 + 结果 notes 列出，不整体失败） |
| bg 派发后会话边界失败 | 既有 assertSessionDispatchAllowed 错误（派发前校验，句柄不建） |

## 9. 测试策略

按 momo-test-rules（mock 仿真真实运行时语义；错误路径专项；接线锁红绿变异）：

| 类别 | 用例 |
|---|---|
| 重建器单元 | 完整链两轮 verbatim / 孤儿 tool_call 合成 / 多轮 user 追问聚合 / 降级空 messages / 会话过滤 |
| runChatLoop historyPrefix | 前缀拼接顺序 / 与 resumeTurn 互斥防御 / 无前缀行为逐字节不变 |
| bgHandles 单元 | in_flight→done 翻转 / cancel 后迟到 reply 忽略 / 超上限报错含清单 / 幂等读 |
| gather 语义 | all 全完成 / any 首个完成 / 超时 done+pending / 迟到缓存命中（reply 先于 gather）/ 重复 gather 幂等 / not_found 句柄 notes |
| followup 集成 | dispatch→reply→followup→子会话历史含首轮（taskId 链关联锁）/ 降级路径 |
| handleTaskReply 扩展 | pendingReplies 命中优先（既有不破）/ bg 分支翻转 / waiter 唤醒 |
| 工具注入面 | 会话边界过滤含 5 新工具（leader 注入 / 非 leader 不注入） |
| 契约锁 | routeDispatch 零改动（回归既有测试全绿即证） |
| dispatch-parallel | 既有批处理不受新工具干扰（isDispatch 判定不含 bg） |

## 10. 验收标准（DoD）

| # | 验收项 | 类型 |
|---|---|---|
| 1 | 5 工具 schema + 注入面 + 会话边界双防线 | 单测 |
| 2 | 重建器五场景（含降级） | 单测 |
| 3 | runChatLoop historyPrefix 三态 | 单测 |
| 4 | bg 句柄表全语义 + 上限 8 | 单测 |
| 5 | gather all/any/超时/迟到缓存/幂等 | 单测 |
| 6 | cancel 幂等 + abort 链路复用 | 单测 |
| 7 | followup 端到端（链历史聚合） | 集成 |
| 8 | handleTaskReply 单点收口不破（既有全绿） | 回归 |
| 9 | dispatch-parallel 不受扰 | 回归 |
| 10 | 主机实测：dispatch→followup 追问保留上下文；bg 三连派→干别的→gather 收割 | macOS |
| 11 | typecheck 双 Done / 双 workspace 全绿 / build exit 0 | 门禁 |
| 12 | README + engineering.md 条目 | docs |

## 11. 迁移与发布

- 零迁移（零新表零新列）
- 任务分组（预估 9-11 task）：T1 重建器 / T2 historyPrefix + runChatLoop / T3 bgHandles+handleTaskReply 扩展 / T4 gather 族 / T5 工具面 5 个 + 注入 / T6-7 集成与回归 / T8 四门+docs（按 plan 阶段定稿）

## 12. 已知边界（明示）

- 孙 agent 嵌套禁止 / followup 仅同步 / bg 句柄不跨重启 / PM abort 不级联 cancel bg / 结构化 reply 不做 / 同链 chip 不分组 / followup 子流暂不嵌套渲染（chip 未实装，答案经工具卡 result 文本可见；chip 实装排 v2.8.x）

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| followup 重建历史超长（多轮 + 工具重） | token 自然约束；工具描述教收敛；后续可复用 compaction 收缩（v2.9 候选） |
| bg 句柄泄漏（派了不收） | 上限 8 + 回合内工具描述引导 gather；泄漏影响仅为句柄表内存（微小） |
| gather waiter 与 handleTaskReply 竞态 | waiter 注册先于派发已由链路保证（reply 必经 handleTaskReply 单点）；测试锁竞态序 |
| pendingReplies 键复用（followup 同 taskId 串行） | 上轮 settle 才可再 followup（派发侧校验 in-flight 同链拒绝） |
| 与 resumeTurn 同时出现的防御 | runChatLoop 明确优先级 + 派发侧互斥（§3.2） |

## 14. 参考

- v2.6 断点续跑 spec（turn-reconstructor 语义来源）：`docs/specs/2026-09-10-task-resume-design.md`
- dispatch-parallel spec：`docs/specs/2026-08-25-dispatch-parallel-design.md`
- 实现锚点：`electron/src/main/agent/dispatch-wait.ts` / `dispatch.ts` / `router-service.ts` / `runtime-entry.ts` / `runtime-config.ts`
