# 会话车道与 steer 注入设计（v2.3）

- 日期：2026-09-08
- 状态：已批准（设计对话定稿）
- 上游讨论：会话内连续消息行为分析 + 业内调研（锁输入 / 排队 / steer / 取消替换四模式）
- 关联代码：`electron/src/main/task/executor.ts`、`electron/src/main/agent/router-service.ts`、`electron/src/main/agent/agent-runner.ts`、`electron/src/main/agent/runtime-entry.ts`、`electron/src/main/storage/tasks/state-machine.ts`、`renderer/src/lib/task-status.ts`

## 1. 背景与问题

### 1.1 现状链路（已逐一验证）

看板任务 → 执行会话的完整链路：

```
TaskExecutor.admitOnce()
  ├─ 全局槽位：count(in_progress) < maxConcurrentTasks（默认 3，无 per-session 限制）
  ├─ launch(A)：startTask(A, {executionSessionId: 目标会话}) → in_progress
  └─ sendKickoff(A)：sendUserMessage(【任务启动】#A, systemKickoff: true)
        ↓
  接待路由（非 @ 消息由 leader 接待）→ routeUserChat → executeTask(taskId=null)
        ↓
  WarmPool.acquire → 独立子进程 chat loop（ephemeral 流）
```

用户手输消息同样走 `routeUserChat` 无条件 `executeTask`——**不排队、不打断、不合并**。

### 1.2 三个问题

| # | 问题 | 机制 |
|---|---|---|
| P1 | **同会话多流互盲并行** | 两个子进程各自建历史，前者回复尚未终态落库（stream-relay 在 end 后回写 body），后者看不见；token 双倍、流式输出交错 |
| P2 | **K7-3 暂停误杀**（现存 bug） | `abortTasksBySessionEverywhere(executionSessionId)` 按会话杀**全部**活跃流——含 dispatch 子流（其 executionSessionId 同为团队会话）。暂停任务 A 会杀死 PM 正在进行的委派子流 |
| P3 | **steer 前提不成立** | steer 语义 = 二次输入在工具边界注入「当前运行」，隐含会话单活跃流前提；多流并行时注入目标歧义 |

## 2. 目标与非目标

**目标**：

1. 会话车道：同一会话同一时刻至多一条**顶层**活跃流；看板任务 kickoff 在车道被占时排队（新状态 `session_queued`）
2. steer：活跃流期间用户手输在下一个工具边界注入当前流，不打断进行中的工作
3. 新状态看板可见（文案、状态色、过滤器、详情面板）
4. 修复 P2：任务暂停/取消按 taskId 精确中止关联流，不再按会话广播

**非目标**：

- dispatch 并行委派不变（dispatch 子流不进车道、不被车道阻塞）
- 全局并发槽位机制不变（跨会话并行不受影响）
- 不做「多条排队消息合并为一轮」的 queue 语义（已选 steer 路线）
- LAN 远端任务只读镜像不改动
- 重启自动恢复 agent runtime 不在本期范围（既有债务，车道仅做 DB 兜底占道）

## 3. 状态机扩展：session_queued（第 9 状态）

### 3.1 转换表新增

```
assigned        → session_queued   （executor 放行时车道被占）
session_queued  → in_progress      （车道放行，经 startTask）
session_queued  → cancelled        （用户取消）
session_queued  → failed           （放行时 validateTarget 失败，带 errorMessage）
```

禁止：`session_queued → completed`（未执行不可完成）；`session_queued → paused`（未运行无暂停语义）。

状态机文件 `state-machine.ts`：`TaskStatus` 联合类型 + `LEGAL_TRANSITIONS` 同步扩展；renderer `types.d.ts` 的 `TaskStatus` 镜像同步（IPC 契约，双 workspace typecheck）。

### 3.2 与全局槽位的关系

- `countInProgress()` 只数 `in_progress`——session_queued **不占全局槽位**
- 放行条件 = 全局槽位有余 **且** 车道空闲（两条件同时满足）

### 3.3 renderer 适配

- `task-status.ts`：新 `TaskStatusKey`，文案「排队中」，Badge 中性色（与 assigned 视觉区分）
- `TaskFilters` 状态筛选选项、看板分组（`task-filter.ts` 的 `ALL_STATUSES`）同步新增
- `MentionInput` 的 #T 激活菜单（`MENU_STATUSES = ['draft','pending','assigned']`）**有意不收录** `session_queued`——排队任务已在等车道，#T 激活到其他会话会绕过排队语义
- 排队卡片不额外显示等待原因（YAGNI：「排队中」label 已达意；如需增强由后续版本从 task store 推导「同会话存在 in_progress 任务」即可，不加 IPC）

## 4. 会话执行车道（session lane）

### 4.1 车道注册表

位置：`runtime-registry.ts`（与 agentRunners Map 同层）。

```typescript
/** sessionId → 活跃顶层流登记（车道） */
const sessionLane = new Map<string, {
  taskId: string | null;      // kickoff 来源任务；手输流为 null
  streamSessionId: string;
  assignmentId: string;
}>();
```

- **注册**：`routeUserChat` 每次派发顶层流时 upsert（它是唯一同时具备 sessionId / assignmentId / streamSessionId 的点）。taskId 经 sendKickoff 链路透传（见 4.4）
- **清除**：流的收尾事件（end→release / task-end / child exit / destroy）触发，**校验 streamSessionId 匹配**后才清除（防迟到收尾清掉新注册——abort 回退重派发场景）
- **查询**：`isLaneOccupied(sessionId)`（executor 占道判定 + routeUserChat 分流判定共用）

### 4.2 占道判定（内存 + DB 双层）

```
occupied(sessionId) = sessionLane.has(sessionId)
                   OR 该会话存在 status='in_progress' 的任务行（DB 兜底）
```

DB 兜底的语义：重启后内存车道为空，但 A 的 in_progress 孤儿行（流已死）继续占道，B 不插队造成双 in_progress 并存；用户将 A 手动终态化（暂停/取消/失败）后 B 放行。与现有重启处置语义一致。

### 4.3 executor 放行 gate

`launch()` 内顺序调整：

```
validateTarget（不变，失败 → failed）
  ↓
车道检查：targetSessionId 非空 且 occupied(targetSessionId)
  → transitionTaskStatus(task.id, 'session_queued')，return false（不占全局槽）
  ↓
startTask（需接受 assigned 与 session_queued 两种起点 → in_progress）
  ↓
sendKickoff（携带 taskId，见 4.4）
  ↓
注册车道（routeUserChat 派发时，见 4.1）
```

- `peekNextAssigned` 查询扩展为 `status IN ('assigned', 'session_queued')`，排序不变（`priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC`）——车道队列天然按此序放行
- 无目标会话的任务（`targetSessionId` 为空，startTask 新建会话）永不撞车道，行为不变

### 4.4 taskId 透传链（IPC 契约变更）

```
ExecutorDeps.sendKickoff 入参加 taskId
  → session-service sendUserMessage 扩展可选 sourceTaskId（仅 systemKickoff 消息携带）
  → routeUserChat 注册车道时写入 lane.taskId
```

涉及跨模块签名变更，遵守 momo-boundary-rules：主进程内部链路（不经 preload/renderer），electron workspace typecheck 覆盖。

### 4.5 放行触发

复用既有 `notifyExecutor()` 触发点：流的收尾（`finalizeActiveTask` / `handleChildExit` / abort 收尾）清车道后调用。30s 兜底扫描继续作为丢失通知的自愈。

## 5. steer 注入链路

### 5.1 分流规则（routeUserChat 内判定）

```
消息到达（已落库，落库路径不变）
  ├─ systemKickoff 消息 → 无条件派发（executor 已保证车道空闲；极端竞态下
  │   车道被手输流占用 → 覆盖注册 + warn 日志，退化为并行——可接受的窄窗口）
  ├─ 用户手输 且 (sessionId, assignmentId) 命中车道 → steer 注入
  └─ 用户手输 且车道空闲 → 正常 executeTask（现有行为）
```

- @ 其他成员的消息：目标 assignmentId ≠ 车道 assignmentId → 不 steer，正常派发（多成员会话灵活性保留）
- 分流键 = `(sessionId, assignmentId)`，非纯 sessionId

### 5.2 注入协议（wire format）

主进程 → 子进程（复用 abort 消息模式）：

```typescript
child.send({ type: 'steer', streamSessionId, body })
```

runtime-entry `process.on('message')` 新增分支：按 streamSessionId 匹配当前 chat loop，push 进 `pendingSteers[]`（FIFO）。

chat loop 注入点：**每次构建 LLM 请求前 drain**（即每个工具执行后的下一次迭代自然携带）。多条 steer 每条独立成一条 user message：

```
{ role: 'user', content: `[用户中途补充] ${body}` }
```

steer **不触发** AbortController（停止按钮语义不变；steer 与 abort 正交）。

### 5.3 行为变更说明（重要）

会话内连发消息的行为从「并行各答」变为「注入当前轮合并处理」：

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 任务 A 执行中，看板任务 B 指向同会话 | 双流并行互盲 | B 排队（session_queued），A 收尾后放行且可见 A 产出 |
| 流活跃中用户手输补充 | 又一条并行流 | steer 注入当前流的下一轮 |
| 流活跃中用户 @ 其他成员 | 并行流 | 不变（正常派发给目标成员） |
| 车道空闲时用户手输 | 正常派发 | 不变 |

### 5.4 steer 未消费边界

steer 到达时流恰好结束（`ERR_IPC_CHANNEL_CLOSED`）：catch 后回退为正常 `executeTask` 派发，消息不丢。

steer 已入 `pendingSteers` 但 chat loop 在最后一轮（无后续 LLM 请求）自然结束：**不重派发**——消息已在会话历史（落库于发送时），agent 下一轮对话自然可见。接受此边界（实现零成本，语义可解释：「补充已入档，下次回答会考虑」）。

## 6. K7-3 精确中止修复

任务暂停/取消联动中止（`task/ipc.handlers.ts` 的 `abortTasksBySessionEverywhere` 调用点）改为：

```
按 taskId 反查车道注册表 → 拿 streamSessionId → runner.abortStream(streamSessionId) 精确中止
```

- 保留「按 executionSessionId 广播」作为车道无记录时的兜底（任务行在但流未注册的窗口）
- 收益：暂停任务 A 不再误杀同会话的 dispatch 子流（回归锁覆盖）
- 车道串行化后同会话顶层流唯一，但 dispatch 子流仍并行——精确映射是唯一不误杀的方案

## 7. 边界与错误处理

| 场景 | 行为 |
|---|---|
| steer 到已死通道 | `ERR_IPC_CHANNEL_CLOSED` catch → 回退正常派发 |
| 车道流崩溃（child exit） | exit 收尾清车道 → `notifyExecutor()` 放行下一个 |
| 排队中目标会话被删 | 放行时 `validateTarget` 失败 → failed（复用现有链路） |
| 排队中修改任务目标会话 | 下轮 `admitOnce` 按新目标查车道 |
| 排队中用户直接取消 | `session_queued → cancelled`（合法转换） |
| 重启恢复 | session_queued 行 = 持久队列，兜底扫描放行队首；in_progress 孤儿行占道直至用户处置 |
| kickoff 极端竞态（车道被手输流占用） | 覆盖注册 + warn，退化为并行（窄窗口可接受） |
| 活跃流中手输 #T 激活语法 | 按「用户手输」分流 → steer（不解析内容绕过车道语义） |
| session_queued 任务所在会话的 in_progress 任务被手动完成 | notifyExecutor → 车道空闲 → 放行 |

## 8. 测试策略

**electron 主进程**：

- state-machine：4 条新转换合法 + `session_queued → completed/paused` 禁止
- executor：双任务同会话第二个转 session_queued；前一个收尾后按序放行；全局槽位与车道两条件独立生效；无目标会话任务不受影响；session_queued 不占全局槽
- 车道注册表：注册 / 收尾清除（streamSessionId 校验）/ 崩溃清除 / DB 兜底占道（in_progress 行）/ 迟到收尾不清新注册
- routeUserChat 分流：活跃手输 → steer；空闲手输 → 正常派发；@ 他成员 → 正常派发；systemKickoff → 无条件派发
- steer 注入：pendingSteers FIFO；注入消息格式（`[用户中途补充]` 前缀 user message）；多条独立注入；不触发 abort；死通道回退重派发
- K7-3 回归锁：暂停任务 A 不中止 dispatch 子流；无车道记录时回退广播
- runtime-entry：chat loop 每轮构建请求前 drain pendingSteers；最后一轮结束后未消费 steer 自然沉淀（不重派发）

**renderer**：

- task-status：新 key 的文案/色调
- TaskFilters / task-filter（all 过滤保留新状态）：新状态出现在筛选
- 看板排队卡片正常显示（等待原因增强第一版不做，见 §3.3）

## 9. 验收标准

1. 看板建两个任务指向同一会话同时激活：第二个显示「排队中·等待会话」；第一个完成后第二个自动开始，且其上下文包含第一个的产出（同会话历史可见）
2. 任务执行中在会话手输补充：不产生新流；agent 后续输出体现补充内容；会话历史中该消息正常显示
3. 暂停正在执行的任务：仅该任务的流中止；同会话进行中的 dispatch 子流不受影响
4. 不同会话的任务并行不受影响（全局槽位语义不变）
5. typecheck 双 clean；全部单测绿；既有行为回归无破坏（空闲手输、dispatch 并行、abort 按钮）

## 10. 实施切片建议（供 writing-plans 参考）

1. **T1 状态机**：session_queued 转换 + renderer 类型/状态色/过滤器（两端同 commit，契约完整）
2. **T2 车道注册表**：runtime-registry 内存结构 + 注册/清除/查询 + DB 兜底占道
3. **T3 executor gate**：launch 顺序调整 + peekNextAssigned 双状态 + taskId 透传链（sendKickoff → sendUserMessage → routeUserChat 注册）
4. **T4 steer 链路**：分流判定 + wire format + runtime-entry pendingSteers 注入 + 死通道回退
5. **T5 K7-3 修复**：精确中止 + 兜底广播 + 回归锁
6. **T6 验收门禁**：全量 typecheck/test + 冒烟清单

依赖序：T1、T2 独立可并行；T3 依赖 T1+T2；T4 依赖 T2；T5 依赖 T2；T6 收尾。
