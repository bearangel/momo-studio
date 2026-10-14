# dispatch 回执系统化与中断级联设计（system 角色 · 投递幂等 · 三级中断 · 计数聚合）

- 状态：待评审
- 日期：2026-10-13
- 上游实证：会话 `spring-mcp`（d2163577，2026-10-12 真实工作事项测试）深度分析
- 关联 spec：`2026-09-24-v2.9-event-driven-dispatch.md`（回执自动送达机制引入方）、`2026-08-31-agent-team-session-redesign.md`（agent/会话域）

---

## 1. 背景与实证

用户以真实工作事项（Spring AI MCP 微服务搭建）驱动 PM + researcher + coder 协作，暴露三个问题。全部经 SQLite 直查（`~/.momo-studio/state.db`）+ 代码链路交叉验证定位，证据索引见附录 A。

| # | 现象 | 根因定位 | 定级 |
|---|------|---------|------|
| P-1 | agent 回合的工具调用计数不含子 agent | 计数取 `stream.toolCalls.length`（本流行事件聚合）；子 agent 事件挂在被顶层过滤的子行上，从不参与求和；`message_roll` 换行后计数归零 | P1 |
| P-2 | 子 agent 执行中无法中断 | 停止按钮只 abort 单个 streamSessionId；PM 被停后 `onPmIdle(forcedExit)` 触发补投积压链 → 回执连发 → 打地鼠循环；子链不级联中断（实测子 agent 在 PM 停止后继续运行 22 分钟至自然完成） | **P0** |
| P-3 | 【dispatch 回执自动送达】发送者漂移 + 重复轰炸 | 回执行以 `sender='owner'` 伪装用户消息落库（PM 上下文重建需要）；实时路径不推送该行（repo 级 insert 无 push），重启后才以"用户消息"身份现身；`markPmIdle(deliverSettledUndelivered)` 把全部历史 done-未投递链（含 PM 已同步消费的）重投——PM 原话证实"重复送达（第三次）" | **P0** |

### 1.1 三问题的共同病理

**「模型视角的身份」与「UI 视角的身份」被同一字段 `sender` 绑架**，且**链的生命周期事件缺乏单一真相源**（消费/投递状态分离于两个进程）。这是 8 个主机验收 P0 中「契约漂移」病理在 dispatch 域的再现。

---

## 2. 目标与非目标

### 目标

1. **G1 系统事件一等公民**：新增 `sender='system'` 角色；回执/followup 追问等系统生成行不再伪装用户；渲染为系统事件卡；LLM 上下文重建显式解耦（UI sender → LLM role 单点映射）。
2. **G2 投递幂等**：PM 已内联消费的链永不重投；任一链至多产生一条回执行（DB 级查重兜底）。
3. **G3 三级中断**：回合级（气泡停止）/ 链级（chip 停止）/ 会话级（停止全部），全部级联到子 agent 流与 dispatch 注册表，中断后不产生新唤醒。
4. **G4 计数聚合**：工具调用计数 = 本流（含 roll 族）+ 子链求和，流式与终态均可见。
5. **G5 在途透明**：会话内在途链面板（列表 + 单链取消）。

### 非目标

- 不改 dispatch//task_reply 线协议载荷本体（仅新增 `task_reply_ack` 一个内部事件）。
- 不重构 WarmPool / 会话车道（session-lane）仲裁机制；中断级联在现有车道语义之上实现。
- 不做子 agent 运行树的可视化重构（DispatchChip 嵌套形态保留，仅补停止按钮）。
- 不引入持久化 dispatch 注册表（仍为内存态 + 心跳判死；持久化留待真实需求）。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| 链（chain） | 一次 dispatch 派发的任务链，taskId 标识，多轮 followup 复用同一 ID |
| PM | 会话接待 agent（leader），dispatch 的发起方 |
| 回执行 | `deliverChainResult` 落库的【dispatch 回执自动送达】消息行 |
| 唤醒流 | 回执触发的 PM 新回合流（systemKickoff=true），与回执行共享 streamSessionId（回合标识语义，见 §5.6） |
| 同步消费 | PM 子进程 `waitForTaskReply` resolve / gather 收割——结果内联进入 PM 上下文 |
| 投递 | `deliverChainResult` 落回执行 + 唤醒 PM 新回合 |

---

## 4. 现状链路与缺陷机理（摘要）

```
PM chat loop ──dispatch──► 子 agent runner ──task_reply──► 路由层
    │                          (独立流/独立 lane)              │
    │◄── 同步消费（waitForTaskReply resolve）                   ├─ applyRegistryReply.settle()   ← 每条终态都翻转
    │                                                          └─ deliverChainResult（PM 空闲时）
    │                                                                ① insertMessage(sender='owner')  ← 伪用户行，无推送
    │                                                                ② routeUserChat(systemKickoff)   ← 唤醒新回合
    └─ 用户停止 ──► abortStream(PM 流) ──► forcedExit ──► markPmIdle
                                              └─ 把全部 done-未投递链翻 awaitWake ──► 补投风暴
```

缺陷四要点：

1. **D-A 身份绑架**：`deliverChainResult` 与 `chain-writer.appendFollowupQuestionRow` 写 `sender='owner'`；渲染层以 `sender==='owner'` 判 isSelf/回合锚点/记忆提取，系统行全面污染。
2. **D-B 实时/重启不对称**：回执行走 repo 级 `insertMessage`（无 `session:message` 推送），实时不可见；PM 唤醒回复（agent 行，stream-relay 推送）可见——实时"agent 对隐形输入回复"，重启后"凭空多出用户消息"。
3. **D-C 消费/投递状态断链**：`settle()` 不区分结果是否已被 PM 内联消费（`delivered` 仅投递路径标记）；`markPmIdle(deliverSettledUndelivered)` 全量重投历史链。
4. **D-D 中断无级联**：`agent:abortStream` 单流作用域；registry `cancel()` 存在但仅由 PM 主动 `abort_dispatch`/`dispatch_cancel` 工具触发；用户侧无任何入口；子进程 chat loop 对 abort 的检查语义待插桩确认（附录 A-4）。

---

## 5. D1 系统角色 `sender='system'`

### 5.1 数据模型

- `messages.sender` 列为 TEXT 无 CHECK 约束——**无需表结构变更**，仅扩展语义枚举。
- TS 类型：electron 侧 `MessageRow` 与 renderer 侧 `ImMessage.sender: string`（p2p remote: 前缀要求保持 string），新增语义文档 + 类型守卫：

```ts
/** 本地 sender 语义枚举（p2p 远端行带 remote: 前缀，类型保持 string） */
export type LocalSender = 'owner' | 'system' | `agent-${string}`;
export function isSystemSender(s: string): boolean { return s === 'system'; }
```

- 一义一名（boundary 规则 3）：`system` = 本地系统进程生成行（回执、followup 追问、未来的授权/系统通知）。远端系统行经 p2p 命名空间化后为 `remote:<node>:system`，`isSystemSender` 不命中（远端行只读镜像，按远端用户行渲染，可接受降级）。

### 5.2 写入方收敛（生产者清单）

| 写入点 | 现值 | 改为 |
|---|---|---|
| `router-service.deliverChainResult`（回执行） | `'owner'` | **`'system'`** |
| `chain-writer.appendFollowupQuestionRow`（followup 追问行） | `'owner'` | **`'system'`**（PM 代发的追问，非用户手输；行带 parent_ssi 不进顶层） |
| `session-service.sendUserMessage` 等 4 处（真实用户行） | `'owner'` | 不变 |
| `stream-relay` start 分支（agent 行） | `agent-*` | 不变 |
| `router-service.ts:92` sender 校验（agent 身份反查） | 拒 `'owner'` | 同时拒 `'system'`（系统身份不可作为 agent 发送者） |

### 5.3 渲染层

1. **`isTopLevelMessage`**：system 行放行（现逻辑天然放行，补契约测试锁死）。
2. **气泡归属**：`isSelf = sender === 'owner'`——system 行 `isSelf=false`，不落 MessageBubble 的 owner 分支（右侧气泡/输入上下文 chips 均不命中）。
3. **新组件 `SystemEventCard`**（`renderer/src/components/im/SystemEventCard.tsx`，遵守设计系统：语义 token、lucide 图标 16px/1.75、禁 emoji）：
   - 居中窄卡形态（非气泡）：图标 + 单行摘要（"子任务回执 · 已完成 · 15 次工具调用"）+ 可展开正文（details 折叠）。
   - 解析回执 body 首行结构化摘要；解析失败降级为纯文本前 80 字符（错误路径有专项用例，test 规则 3）。
   - 显示子 agent 名与链短 ID（taskId 前 8 位）；点击滚动定位到对应 DispatchChip（复用 `revealMessage` 链路，目标为子 agent 首个子行锚点；定位失败 toast 如实提示）。
4. **`turn-segment.latestTurn`**：回合锚点从 `sender === 'owner'` 扩为 `owner || system`（`ownerMessageId` 更名 `anchorMessageId`，一义一名）。撤回删除面语义不变：锚点行 + 其后全部 agent 行。system 行作为锚点使「回执唤醒回合」成为独立撤回组。
5. **`MessageList` 滚动**：`isNewOwnMessage` 判定扩为 owner || system（新回执唤醒回合出现时贴底）。
6. **`TaskProgressButton`**：扫描跳过 owner 行处同步跳过 system 行。

### 5.4 LLM 视角解耦（单一映射函数）

新增单点映射（electron 侧 `turn-reconstructor` 与 `sub-history-reconstructor` 共用）：

```
UI sender                →  LLM role
'owner'                  →  user
'system'                 →  user（正文已含【dispatch 回执自动送达】等自明标记，不另加前缀）
'agent-*'                →  assistant
'remote:<node>[:<s>]'    →  user（远端用户）
```

- `turn-reconstructor.ts:597` `isOwnerRow` → `mapsToUserRole(row.sender)`。
- `sub-history-reconstructor.ts:94` 同改（followup 追问行改 system 后链内 user 轮识别不回归）。
- 契约测试锁映射表全行（含未知 sender 降级 user 的行）。

### 5.5 消费方逐点处置（消费者清单）

| 消费点 | 处置 |
|---|---|
| `memory/context-map.ts`（记忆提取 sender 映射） | `'system'` → **跳过提取**（系统管道噪声不入记忆）；会话重建照常包含 |
| `agent/tools/session-tools.ts:160`（展示命名） | `'system'` → `'系统'` |
| `im/session-naming.ts:98`（首条用户消息自动命名） | 跳过 system 行（防【dispatch…】成为会话标题） |
| `p2p/sync.ts`（出站镜像/入站命名空间化） | 出站照带 `sender='system'`；入站旧节点收未知 sender 按远端行渲染（左气泡 + 原始串），可接受；新版节点 `isSystemSender` 命中 `remote:…:system` 不做特殊处理 |
| `storage/messages/repo.getLatestMessageByStreamSessionId` | 加固：流当前行查询限定 `sender LIKE 'agent-%'`（回执行/owner 行不再进入流行解析候选，消除双行同 ssi 的顺序依赖；现靠 created_at DESC + rowid 决胜，属隐性契约） |
| `im/session-service.ts:304`（isOwn 判定族） | 逐一核对不把 system 行当用户输入处理（撤回/编辑入口不适用于 system 行） |

### 5.6 回执行与唤醒流的 ssi 共享（保留 + 显式化）

回执行与唤醒流共享 streamSessionId 的语义 = **回合标识**（input 行 + output 行同属一回合）。保留该设计（turn-reconstructor 按流聚合依赖它），但：

- `deliverChainResult` 注释显式声明回合标识语义；
- 契约测试：同一 ssi 下「至多一条 system 行 + 至多一条 agent 流行」，`getLatestMessageByStreamSessionId` 恒返回 agent 行。

### 5.7 存量迁移

新增 migration（编号顺延）：

```sql
-- 回执行：owner 伪装行 → system（生产库实测 10 条）
UPDATE messages SET sender='system'
WHERE sender='owner' AND task_id IS NOT NULL
  AND body LIKE '【dispatch 回执自动送达】%';
-- followup 追问行（带 parent 的 PM 代发行）
UPDATE messages SET sender='system'
WHERE sender='owner' AND task_id IS NOT NULL
  AND parent_stream_session_id IS NOT NULL;
```

用户真实输入行（session-service 写入）不带 task_id + 前缀/parent 特征，不命中。迁移自带回归断言（迁移后计数对账）。

---

## 6. D2 回执投递幂等

### 6.1 消费确认事件 `task_reply_ack`（本 spec 唯一新增的子进程→主进程内部事件；renderer↔main 的 IPC 通道见 §7.2/§9）

- **生产者**：PM 子进程 `dispatch-wait.handleTaskReply`——resolve `pendingReplies`（同步消费）或唤醒 gather waiter（收割消费）后，fire-and-forget 发 `task_reply_ack { task_id }` 内部事件（经既有内部事件桥）。
- **消费者**：`RouterService.applyRegistryAck` → `dispatchRegistry.markConsumed(taskId)`（置 `delivered=true`——已内联消费等同已投递）。
- 防竞态：ack 与 settle 的到达顺序无关（markConsumed 幂等；settle 前到达的 ack 缓存在 registry 的 `ackedIds` 集合，settle 时吸收）。
- 契约测试按 boundary 规则 4 锁事件类型与 payload 形状。

### 6.2 registry 状态机扩展

```
markConsumed(taskId): 幂等；任意状态可调（in_flight 时记 acked，settle 时吸收为 delivered=true）
settle(): 吸收 acked → delivered；返回快照带 consumed 标志
markPmIdle(pm, {deliverSettledUndelivered, roundStartedAt}):  ← 新增第二参数
    补投条件收紧：done && !delivered && !isFollowupRound
                 && completedAt >= roundStartedAt        ← 只补投「本回合窗口内」翻转的链
```

- `roundStartedAt` 由 `AgentRunner` 在回合启动（executeTask）时记录，`onIdle` 回调透传（`opts.onIdle(assignmentId, forcedExit, roundStartedAt)`）。
- 双保险：ack（精确，覆盖 99% 场景）+ 窗口（兜底 ack 丢失，如子进程 resolve 后瞬崩）。

### 6.3 投递前 DB 查重（终极兜底）

`deliverChainResult` insert 前查同 `task_id` 的既有 system 回执行：

```ts
hasReceiptRow(sessionId, taskId): boolean  // messages repo 新增查询
```

命中则**跳过整条投递**（不落行、不唤醒），记 warn 日志。防任何上游状态机缺陷再次污染会话。

### 6.4 deliverChainResult 改造汇总

1. `sender: 'system'`（§5.2）。
2. 落库成功后**经 `pushSessionMessage` 推送**（复用 stream-relay 导出，或将推送 helper 提为共享模块）——修复实时不可见（D-B）。renderer `receiveMessage` 收 system 行 → MessageList 即时渲染系统卡。
3. 投递前查重（§6.3）。

---

## 7. D3 三级中断

### 7.1 中断模型

| 级别 | 入口 | 作用域 | 语义 |
|---|---|---|---|
| 回合级 | PM 气泡停止按钮（`BubbleToolbar`） | PM 当前流 + 本回合派生的全部在途链 | "停下这一轮"——含子任务 |
| 链级 | DispatchChip 停止按钮 / 在途面板 | 单条链 + 其子 agent 流 | "只停这个子任务" |
| 会话级 | 会话头部「停止全部」 | 本会话全部活跃流 + 全部在途链 + 待投递队列 | 紧急刹车 |

现有 `agent:abortStream`（精确单流）保留（任务板等既有调用方不变）。

### 7.2 新 IPC 通道（boundary 规则 4：双端 + 契约测试）

| 通道 | 方向 | 载荷 | 行为 |
|---|---|---|---|
| `agent:abortTurn` | renderer→main | `{ sessionId }` | §7.3 回合级级联 |
| `dispatch:cancelChain` | renderer→main | `{ taskId }` | registry.cancel + abort_dispatch 广播（复用 `routeAbortDispatch`） |
| `session:stopAll` | renderer→main | `{ sessionId }` | §7.5 会话级级联 |
| `dispatch:listInFlight` | renderer→main（invoke） | `{ sessionId? }` | → 在途链视图数组（§9） |

preload + `renderer/src/ipc/types.d.ts` 同步；双 workspace typecheck。

### 7.3 回合级实现（`agent:abortTurn`）

执行序（顺序关键——先断链再断流，迟到回执落进 cancelled 幂等忽略）：

1. 解析车道：`getLane(sessionId)` 取当前占用流的 streamSessionId（PM 本回合流）。
2. `dispatchRegistry.cancelByPmStream(pmStreamSessionId)` → 被取消 taskId 清单。
3. 逐链发 abort_dispatch（复用 `routeAbortDispatch`：广播 `abortStream(subStreamSessionId)` 至全部 runner）。
4. `abortStreamBySessionId(pmStreamSessionId)` 停 PM 本流。
5. PM 收尾触发 `onPmIdle(forcedExit=true)` → `markPmIdle(deliverSettledUndelivered, roundStartedAt)`——本回合链已 cancelled（不满足 done 条件），历史链不属本回合窗口 → **零补投**。

registry 新增：`cancelByPmStream(pmStreamSessionId): string[]`。

### 7.4 子进程 abort 语义补全

**T0 插桩调查（P0-B 首任务，按 momo-debug-rules 规则 1 先复现）**：spring-mcp 实测中子 agent（researcher，7804639b）在 PM 停止后运行 22 分钟至自然完成。三个待证假设：

- H1：`routeAbortDispatch` 广播的 `subStreamSessionId` 与子 runner `activeTasks` 键不匹配（ID 透传断点——routeDispatch 侧是否沿用 PM 预生成 ID）；
- H2：abort 消息到达子进程，但 chat loop 仅取消当前 LLM fetch，工具循环不检查 abort 标志，下一轮迭代继续；
- H3：该链为 `dispatch_bg` 派发（fire-and-forget，PM 中止时根本不产生 abort_dispatch）。

验收：L2 复现（seed SQLite → 真实链路 → 停止 → 断言子流 ≤2s aborted），按命中假设修复：

- H1 命中 → 修 ID 透传（单点生成沿线传递，禁止中途回收再生成）；
- H2 命中 → runtime chat loop 在**每次工具执行前**检查 abortFlag（工具执行中不强杀——沙箱/bash 已在途的等自然返回后停）；
- H3 命中 → 本 spec §7.2/§7.3 的级联已覆盖（cancelChain/abortTurn 显式取消 bg 链），无需子进程改动。

### 7.5 会话级实现（`session:stopAll`）

1. 遍历 runners：`abortTasksBySession(sessionId)`（已存在，K7-3）。
2. `dispatchRegistry.cancelBySession(sessionId)` → 逐链 abort_dispatch 广播。
3. 清空该会话 PM 的 `pendingDeliveries` 队列。
4. 抑制后续唤醒：cancelled 链 settle 幂等忽略 + §6.2 窗口收紧双保险。

### 7.6 DispatchChip 停止按钮

`executing/queued` 态显示停止图标按钮（lucide `Square`，12px）→ `dispatch:cancelChain(taskId)`；乐观置 `aborted`（chip 状态映射已有 aborted 态）。`dispatches` 段聚合数据流（stream-aggregator）已带 subStreamSessionId，chip 回调经 bubble 透传 taskId（dispatch 段 payload 需含 taskId——核对 `DispatchContent` 线载荷，缺则随 tool_call 事件 payload 透传，双端契约锁）。

---

## 8. D4 工具调用计数聚合（纯 renderer）

### 8.1 数据口径

- **本流计数 X**：base streamSessionId 全族（`ssi` 与 `ssi#roll{n}` 行）的 `tool_call_start` 事件数之和（对齐 repo `listMessagesByStreamSessionId` 前缀口径）。
- **子链计数 Y**：`parentStreamSessionId ∈ 本流族` 的全部子行 `tool_call_start` 之和。
- **在途子任务 Z**：`stream.dispatches` 中非终态数（现有 dispatchTotal/dispatchCompleted 逻辑复用）。

### 8.2 展示

- 流式态：`处理中 · 已调用工具 X 次（含子链 Y）`；Z>0 时追加 `· Z 个子任务在途`。
- 终态：状态行保留 `工具 X 次（含子链 Y）` 摘要（现状终态即消失）。
- 实现落点：`AgentStreamBubble`（`streamIdToMessageId` 反查表已备）+ `stream-aggregator`（roll 族聚合 helper）。无新 IPC、无 DB 变更。
- 降级：历史行事件被裁剪（hydrate 仅结构事件）时计数显示本行可见值，不伪造合计（如实降级，test 规则 3）。

---

## 9. D5 在途任务面板

- 入口：会话头部（输入框上方工具条）按钮 + 在途数徽标（>0 显示）。
- 形态：Popover 列表，每行 = 子 agent 名 + 链短 ID + 轮次 + 状态 + 已运行时长（复用 `ElapsedTimer` 模式）+ 停止按钮（→ `dispatch:cancelChain`）。
- 数据：`dispatch:listInFlight { sessionId }` → `Array<{ taskId, round, status, startedAt, subAgentName, pmStreamSessionId }>`（registry `listInFlight` 扩展：含 sync dispatch 链，`subAssignmentId` → agent 名在主进程解析，与既有 bot 名映射同源）。
- 刷新：面板打开时拉取 + 订阅既有 `session:listChanged` 级别的轻量推送（复用 `agent:runtimeChanged` 通道附加链变更通知，不新建推送通道；实现期核实该通道语义，若载荷耦合则允许新增 `dispatch:chainsChanged` 推送，双端契约锁）。

---

## 10. 兼容与迁移

| 面 | 影响与处置 |
|---|---|
| 存量回执行 | migration 翻 `sender='system'`（§5.7），重启后渲染为系统卡 |
| 旧版读新库 | 旧代码读 system 行：`isSelf=false` 左侧显示，sender 原样展示——无崩溃面（sender 无 CHECK、类型 string） |
| p2p 跨版本 | 对端未知 sender 降级显示（§5.5） |
| `agent:abortStream` 既有调用方 | 保留不动（BubbleToolbar 改调 abortTurn，其余调用方语义不变） |
| 双 workspace | IPC 类型改动跑双 typecheck（preload 三层 `../../../` 引用 renderer 类型） |
| 版本号 | 按 `docs/dev/release.md` 研发期策略：特性 commit 不动版本号 |

---

## 11. 测试与验收（回归锁清单，按 momo-test-rules 保真度）

每条先红后绿；mock 只收窄到进程/网络/DB 边界；跨模块对接面用契约测试（真实生产者产出 → 真实消费者消费）。

### 11.1 D1 契约与单元

1. **sender 映射契约**：映射函数全表断言（owner/system/agent-*/remote:* /未知值降级）。
2. **SystemEventCard**：正常回执解析 / 畸形 body 降级 / 空 body 专项用例。
3. **turn-segment**：system 行作为锚点成组；owner 锚点组不被 system 行吞并。
4. **getLatestMessageByStreamSessionId 加固**：同 ssi 双行（system + agent）恒返 agent 行。
5. **migration**：10 条 owner 回执行 → system；真实用户行零误伤（构造同库种子断言）。
6. **session-naming / context-map / TaskProgressButton**：system 行跳过的专项用例。

### 11.2 D2 幂等（L1 harness → L2 e2e）

7. **ack 路径**：同步消费（executeDispatch resolve）→ ack → markConsumed；后续 forcedExit 补投零命中（断言 deliverChainResult 未调用）。
8. **窗口兜底**：ack 丢失（子进程崩）+ completedAt ∈ 本回合窗口 → 补投恰一次；completedAt < 窗口 → 零补投。
9. **DB 查重**：预置同 taskId 回执行 → 第二次投递整条跳过（无新行、无 routeUserChat 调用）。
10. **L2 真 e2e**（spring-mcp 场景仿真）：两条链，其一同步消费、其一后台终态，强制中断一次 → 断言：后台链恰送达一次、同步链零重复、回执行 sender='system'、无第二次唤醒。

### 11.3 D3 中断（L2 为主）

11. **回合级**：PM 派发子 agent（子进入 executing）→ abortTurn → 断言：PM 流 aborted、子流 ≤2s aborted、registry 无本回合链残留 in_flight/awaitWake、**无新唤醒流产生**（routeUserChat 调用计数）。
12. **链级**：executing 态 DispatchChip 停止 → 单链 aborted，PM 流与兄弟链不受影响。
13. **会话级**：多链并发 → stopAll → 全部 aborted、pendingDeliveries 清空。
14. **T0 复现锁**：按 §7.4 命中假设固化对应回归测试（修复前红、后绿）。
15. **错误路径**：abortTurn 时车道空 / runner 缺失 / 链已终态——幂等 no-op 不抛错。

### 11.4 D4/D5

16. 计数聚合：含子链 + roll 族合成回合 → 断言 X/Y/Z 三值（对照 DB tool_call_start 计数）；事件裁剪行降级显示。
17. 面板：listInFlight 形状契约（主进程真实 registry → renderer 类型）；取消按钮 → cancelChain → 列表刷新。

### 11.5 App 级验收

18. 全链路走 `momo-acceptance` 技能（隔离实例 + CDP 接管）：spring-mcp 场景回放——派发 → 停止 → 重启 → 断言三问题症状全部消失（计数含子链 / 停止即静默 / 回执为系统卡且不重复）。

---

## 12. 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **P0-A**（先行） | D1 全部 + D2 全部（§5、§6）：system 角色、投递幂等、实时推送、migration | 无 |
| **P0-B** | D3 全部（§7）：含 T0 插桩调查首任务 | P0-A 的 registry 扩展 |
| **P1-C** | D4（§8）计数聚合 | 无（可与 P0-B 并行） |
| **P2-D** | D5（§9）在途面板 | P0-B 的 cancelChain 通道 |

每期独立可验收、独立合入；P0-A 合入后 spring-mcp 的"重复轰炸 + 身份漂移"症状即消失。

---

## 13. 风险与开放问题

1. **T0 假设未定**（§7.4）：H1/H2/H3 修复面差异大——故列为 P0-B 首任务，先复现后修复，禁止盲改。
2. **markPmIdle 签名变更**（加 roundStartedAt）：`AgentRunner.onIdle` 回调链（maybeFireIdle → notifyRunnerIdle → onPmIdle）沿线透传，属跨模块接口变更——按 boundary 规则 1 单点记录回合起点，禁止各层自取时间戳。
3. **回执实时推送的模块边界**：pushSessionMessage 现居 stream-relay（私有），deliverChainResult 在 router-service——提出共享推送 helper 时防循环依赖（router → relay → session-naming → … 已有先例注释，遵循注册反转模式或上提到 session-service）。
4. **dispatch 段 taskId 透传**（§7.6）：若现有 `tool_call_start(isDispatch)` payload 不含 taskId，需从 dispatch 事件链补——双端契约测试先行，防 renderer 侧等一个不存在的生产者（P0-6 病理）。
5. **远端旧节点对 system 行的显示降级**未做专门兼容——只读镜像语义下可接受；若 P2P 协作场景真实出现混淆，后续按 `remote:…:system` 加识别（非本期）。

---

## 附录 A：spring-mcp 证据索引

| 证据 | 位置 |
|---|---|
| 10 条回执行全 sender='owner' | `messages` 表 session=d2163577，body LIKE '【dispatch 回执自动送达】%' |
| 16:27:34-38 四连回执（4 条 14:52-15:58 老链） | messages 9397e3fd/ffe5e0da/892c6a2f/5d3aab56 + 配对 aborted 唤醒流 fc31dd18/e4630beb/41ce7014/0f228d2f |
| PM 自证重复送达 | c0e7ea16"已处理结果的重复送达"、bc2e0b17"重复送达（第三次）"、722ba011"内容与上轮已处理的完全相同" |
| 子 agent 无视中断运行 22 分钟 | researcher 流 7804639b：16:26:51 启动 → 16:47:07/16:48:02 交付（b4461fbd/27c708ab），PM 流 1f30b8c4 于 ~16:27 aborted |
| 计数缺口实测 | PM 回合 bb683fbe 自身 171 次工具调用（95+6+70，3 个 roll 行归零重计），同期子 coder 116 次不可见；回合 33fe170a PM 53 次 vs 子 researcher 618 次 |
| 回执行零事件、唤醒流事件挂 agent 行 | message_events：07f8deb7 族仅 fc31dd18 有 final+status_change；578d4389 族 1803 text_delta 全挂 722ba011 |
| 回执文本从不流经事件通道 | message_events payload_json 全库 LIKE '回执自动送达' 零命中 |
| 实时不可见（无推送） | router-service 无 webContents.send；session:message 生产者仅 stream-relay:127 / session-service:264 / p2p:217 |
