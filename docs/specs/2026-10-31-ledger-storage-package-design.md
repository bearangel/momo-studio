# 账本与存储包设计（dispatch 子任务入账 + 思考流全文并档）

- 日期：2026-10-31
- 状态：已批准（用户 2026-10-31 设计评审通过）
- 来源：真实用户验收报告 `.omo/qa-reports/2026-10-31-game-designer-rpg/report.md` 的 D4（任务两套账）与 D5（thinking_delta 逐 token 落行 186MB/4.3h）
- 前置：可信执行包（PR #19，alpha.53）已合入；本包为验收报告分解的包②

## 1. 背景与问题定性

**D4**：看板任务（tasks 表）与编排子任务（dispatchRegistry，内存态）两套账——看板并发 0/3 而会话内在跑 5 个子任务（T22）；leader 的 read_task/list_tasks/read_task_progress 三个工具对 dispatch 链零命中（链 id 从不写表）。registry 纯内存（`dispatch-registry.ts:19-20`），重启全丢。

**D5**：`message_events` 逐 token 落行——4.3h 会话 542,014 行中 thinking_delta 530,721 行（97.8%），state.db 186MB。构成：行开销 ~115B/行 + 三棵 B-tree（含 042 thinking 部分索引全量 530k 行）+ `message_compact_events` 快照表**双份**存 thinking 全文。表零生命周期管理（无 DELETE / retention / VACUUM），单调增长。

## 2. 现状实锤（设计依据，全部 file:line 已核实）

### D4 面

| 面 | 事实 | 锚点 |
|---|---|---|
| tasks 状态机 | 9 态；`in_progress→completed/failed/cancelled` 全合法；终态不可逆 | `state-machine.ts:23-54` |
| 来源判别列 | **不存在**（仅 source_session_id/source_message_id/creator_user_id） | `migrations/index.ts:502-535` |
| executor 放行 | 只认 `status IN ('assigned','session_queued')` | `executor.ts:187-211` |
| 全局并发槽 | `countInProgress` 全表数 in_progress，上限 maxConcurrentTasks | `executor.ts:174-179,101` |
| 看板 | 全量 tasks 快照（limit 500）+ 本地派生并发徽标（active=in_progress 计数） | `TaskBoardView.tsx:167-193`、`task.store.ts:105` |
| registry 钩子 | register(:577)/settle(:862)/cancel×3(:734,:786,:814)/sweepDead(:1007)/heartbeat(:855)/markConsumed(:875) | `router-service.ts` |
| agent 工具 | read_task(:90)/read_task_progress(:134 查 messages.task_id——回执行已带 taskId :954-961)/list_tasks(:268) | `task-tools.ts` |
| 链 id | randomUUID（`dispatch.ts:107`）；tasks.id TEXT PK 无格式约束 | — |

### D5 面

| 面 | 事实 | 锚点 |
|---|---|---|
| 写入链 | 1 thinking delta chunk = 1 pending = 1 行，纯透传 | `stream-relay.ts:401-410` |
| 批落盘 | 50ms/30 条单事务逐行 INSERT（批量≠合并） | `event-buffer.ts:36-94` |
| 游程合并算法 | compactEventDeltas：连续同类 delta 拼接、首行锚 seq——**已现成** | `event-compaction.ts:31-51` |
| 终态钩子 | snapshotAtFinalize 四触发点（end/roll/segment/崩溃） | `stream-relay.ts:59-68,513,530,595` |
| 读路径 ×4 | 实时流(append)/历史回放(seq 归并)/展开思考(runs 锚 seq)/wire 投影(字符预算)——全部**与行粒度无关** | `stream-aggregator.ts:145-149` 等 |
| 等价性契约 | aggregateEvents(全量) ≡ aggregateEvents(压缩) 已有测试锁 | `tests/storage/event-compaction.test.ts` |

## 3. D4 方案：dispatch 子任务入 tasks 账本

**核心原则**：registry 仍是运行时真相源；tasks 行是它的**单向持久化投影**（registry → DB），永不反向驱动。

### 3.1 判别列与行形状

- Migration 新增 `tasks.origin TEXT NOT NULL DEFAULT 'user'`（取值 `'user'|'dispatch'`）；TaskRow / `renderer/src/ipc/types.d.ts` / 预载 IPC 载荷同步扩列（boundary 规则 4：两端同 commit + 双 typecheck）
- 行 id = 链 taskId **原样沿用**（单点生成沿线透传——禁造第二 id；tasks.id 为 TEXT PK，UUID 直接合法）
- 行字段：`origin='dispatch'`、`status='in_progress'`（直插，绕开 draft→assigned 放行面）、`title`=子任务描述截断（≤80 字）、`workspace_id`、`assignee_agent_id`=子 agent instanceId、`execution_session_id`=链 sessionId、`source_session_id`=PM 会话

### 3.2 生命周期同步（五钩子 + 复用删插）

| registry 事件 | tasks 动作 | 锚点 |
|---|---|---|
| register（新链） | insertTask（in_progress） | router-service.ts:577 |
| settle outcome=completed | transitionTaskStatus → completed | :862 |
| settle outcome=failed | transitionTaskStatus → failed | :862 |
| settle outcome=needs_input | transitionTaskStatus → **paused**（HITL 等待用户代答——failed 会把「等待人工」误报为失败；paused 语义准确且 in_progress→paused 合法） | :862 |
| cancel（routeAbortDispatch/stopAll/cancelChain） | transitionTaskStatus → cancelled | :734/:786/:814 |
| sweepDead 判死 | transitionTaskStatus → failed（errorMessage=判死原因） | :1007 |
| register（followup 链复用 → round+1 重置在途） | **updateTask 权威复位**（status→in_progress + title 更新；completed 终态不可逆转换——registry 复用是权威重置。禁 DELETE：迁移 555 触发器在 tasks 行删除时把挂链 messages.task_id 置 NULL，followup 断链——orchestration-e2e 实证修正） | :577 |

状态映射全部落在既有 LEGAL_TRANSITIONS 内（in_progress→completed/failed/cancelled 均合法）——**零状态机改动**。heartbeat/markConsumed 不投影（行状态无对应变化）。

### 3.3 executor 隔离

- dispatch 行永不落 assigned/session_queued → 放行面天然隔离
- `countInProgress`（executor.ts:174）SQL 增 `AND origin <> 'dispatch'`——全局并发槽语义保持「任务板任务专属」，编排子任务不挤占

### 3.4 启动对账

boot 序列（index.ts，sweepStaleStreaming 旁）扫 `origin='dispatch' AND status IN ('in_progress','paused')` → registry 必空（内存态）→ 统一转 failed（errorMessage=「应用重启，编排链丢失」）。in_progress 行走 transitionTaskStatus；paused 行越过状态机直接 updateTask（paused→failed 非法转换——启动对账是权威复位而非生命周期转换）。孤儿行不复存在（paused 覆盖 needs_input 落态的行）。

### 3.5 看板与工具

- TaskCard 加「编排」小徽标（Badge violet tone）——**走预览门禁**（P1 新视觉元素）
- 并发徽标 `active` 计数排除 dispatch 行（`并发 N/M` 仍是任务板语义）；子任务以卡片形态进泳道可见（group_id NULL → 未分组道）
- dispatch 行**看板只读**：task:update/move 类 IPC 对 origin='dispatch' 行拒绝手动改态与编辑（registry 是真相源；从看板取消子任务留后续）
- InFlightPanel 不动（registry 实时操作视图，语义正交）
- agent 三工具（read_task/list_tasks/read_task_progress）**零改动自动复活**——行入账 + 回执行已带 taskId

## 4. D5 方案：思考流全文保留两段式

### 4.1 flush 时合并（live 段）

`MessageEventBuffer.flush()` 构造落库行时，同 message 的**连续 thinking_delta** pending 游程合并为单行：delta 拼接全文、seq 取游程首条 pending 的落库 seq；结构事件（非 thinking_delta）断游程；跨 message 不合并。onFlush 的 wire 推送批随之变大块（aggregator 纯 append，兼容已锁）。text_delta 不合并（占 2%，且已有 messages.body 终态聚合先例——scope 纪律）。

### 4.2 终态并档（settled 段）

在 `snapshotAtFinalize` 四触发点**之前**插并档步（新函数 `compactThinkingEventsInPlace(messageId, tx)`）：

1. 读该 message 全部 thinking_delta 行（走 042 部分索引，范围读）
2. `compactEventDeltas` 游程合并（现成算法）
3. **单事务**：删原 thinking 行 + 插合并行（id 新生成、seq=游程锚、delta=全文、created_at=锚行值）
4. 而后照旧 writeCompactSnapshot（快照读到的是已并档行——内容等价、体积更小）

不变量：合并行继承游程首行 seq（保序）；(message_id, seq) 唯一性由删除先行保证；seq 空洞合法。

### 4.3 兼容性依据与契约

- 四条读路径（实时流 append / 历史回放 seq 归并 / 展开思考 runs / wire 投影字符预算）全部与行粒度无关——探查逐一核实
- 等价性契约测试扩为**三态锁**：aggregateEvents(全量) ≡ aggregateEvents(flush 合并) ≡ aggregateEvents(终态并档)
- turn-reconstructor（断点续跑）消费 steer/status 事件——thinking 行并档无影响（spec 复核项，实施时以测试证实）
- **零 schema 变更、零读路径代码改动**

### 4.4 不动项

`message_compact_events` 快照表语义不碰（服务老消息裁剪路径；双份问题留观察——若并档后体积仍不达标再立项）。清理策略/保留窗口/降采样：用户已裁定不做（2026-10-31）。

## 5. 裁定记录

| # | 裁定 | 日期 |
|---|---|---|
| 1 | D4 = dispatch 子任务入 tasks 账本（否决看板虚拟泳道：重启即空、历史不可见、进度工具仍哑） | 2026-10-31 |
| 2 | D5 = 全文保留两段式（flush 合并 + 终态并档；否决降采样与清理策略） | 2026-10-31 |
| 3 | 设计 5 节整体批准 | 2026-10-31 |

## 6. 测试与验收

- **D4 红测先行**：五钩子行投影（register/settle×2/cancel×3/sweepDead）+ followup 删插 + countInProgress 排除 + 启动对账 + task:update 拒改 dispatch 行 + read_task 工具级复活 + TaskRow.origin 透传；electron `tests/task/` 与 `tests/agent/` 归位
- **D5 红测先行**：flush 合并（含结构事件断游程、跨 message 不合并）+ 终态并档（删插原子性、崩溃收尾路径、空集幂等）+ 等价性三态契约 + 体积断言（万级 delta → 行数 << delta 数）
- **回归**：electron 全量 + renderer（若 TaskCard 徽标改渲染层）+ e2e 14 场景零回归
- **真机验收**：A 派发团队任务 → B 看板见「编排」卡并随链终态翻色；leader read_task 查到子任务；长会话 thinking 行数比（DB 行数对比即体积证明）
- **流水线**：spec → .omo/plans 副本 → Momus → D4 看板徽标预览门禁 → 实施 → oracle 终审（零必修）→ PR → CI 终态 SUCCESS → main CI 绿 → 台账 → A/B 重启复验
- **版本**：`2.1.0-alpha.54`（三处 package.json + CHANGELOG）

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| followup 删插丢消息行关联 | messages.task_id 无 FK 指向 tasks；read_task_progress 回执行查询不受影响——测试断言保持 |
| 并档事务大（超长思考回合万行级） | 042 部分索引范围读 + better-sqlite3 同步事务毫秒级；finalize 本就在落盘路径，无新增延迟面 |
| flush 合并改 wire 批粒度 | 大块 delta 减少 IPC 消息数；aggregator 既有测试锁 append；三态等价契约 |
| 行投影与 registry 漂移（漏钩子） | 单向投影 + 五钩子全覆盖红测 + 启动对账兜底——最坏形态 = 行停 in_progress 被对账收编为 failed |
| 直插 in_progress 绕过状态机的隐含依赖 | 全仓无「tasks 行必然经 draft 创建」的假设消费方（探查确认状态机只约束转换不约束插入）；红测锁 executor 不放行 |

## 8. 明确不做（后续）

- 快照表双份消除（体积观察后议）；text_delta 合并；清理/保留策略（已裁定不做）；看板对 dispatch 行的编辑/取消（后续交互）；看板虚拟泳道（已否决）
