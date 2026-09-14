# 会话连续性修复设计（A 止血 + B 结构性主修）

- 日期：2026-09-14
- 状态：已实施（分支 fix/session-continuity；终审修复 C1/I1 已回写本节——excludeFamilySsi 见 §4.1，族时间戳 endTs 见 §4.2-8）
- 范围：electron 主进程（`storage/messages` / `memory` / `agent`），不改 IPC、不改 renderer
- 上游分析：2026-09-14 会话连续性架构审计（本文件 §1 摘录）

## 1. 背景与问题

### 1.1 触发案例

用户在会话中指示「帮我使用bash访问一下bing」，agent 执行 bash 工具成功后被用户中断；用户随后发「访问百度」，agent 改用 browser 工具，未延续 bash 口径。

根因（非模型问题）：Momo 是 task-driven runtime，**每轮用户消息 = 新 task = WarmPool 新子进程**，跨轮上下文完全从 DB 重建。重建链路：

```
runtime-entry.ts:434  getConversationContext(roomId, { limit: 20 })
  → sqlite-provider.ts:161  listMessagesBySession（只读 messages 表，ASC+LIMIT）
  → context-map.ts:30       messageToContext（sender 启发式，仅 user/assistant 两角色）
```

- 工具调用与结果只落 `message_events`（`stream-relay.ts:318-355`），该表**从不进入**跨轮 LLM 上下文；
- 中断轮次终态 body = `aggregateTextDeltas()` = 空字符串（只聚合 `text_delta`，模型中断前未产出文字，`stream-relay.ts:466-469`）。

第二轮模型实际收到：

```
user:      帮我使用bash访问一下bing
assistant: ""                    ← 中断行：空正文，零工具痕迹
user:      访问百度               ← convCtx 行（消息先落库后派发）
user:      访问百度               ← turnMessages 再拼一次（双拼）
```

### 1.2 系统性断点清单

| 编号 | 断点 | 证据坐标 |
|---|---|---|
| B0 | convCtx 取「最早 20 条」而非「最近 20 条」：`listMessagesBySession` 是 ASC+LIMIT（repo.ts:217-222 注释自证）；`session-service.ts:248` 注释「ASC+LIMIT 是最早 N 条，勿换」——/compact 已避坑，主链路没避 | 长会话最近上下文整段丢失，且 20 行封顶使 auto-compact 难以被 DB 拉取结果触发 |
| B1 | 工具层（tool_call/tool_result）全程不进跨轮上下文 | 本案例根因；UI 保真度 > 模型保真度，倒挂 |
| B2 | 中断轮次 = 空 assistant 消息，无中断语义；空正文对 Anthropic 系 provider 有 400 风险 | `INTERRUPTED_TOOL_RESULT` 合成机制已存在但只在 resume 用 |
| B3 | 「先中断再说话」比「直接补充（steer）」连续性更差 | steer 注入进程内数组（全保真），中断后新轮走低保真路径 |
| B4 | `limit: 20` 按行数硬编码：segment/#roll/dispatch 子流行都计数 | runtime-entry.ts:434 |
| B5 | 能力不对称：`rebuildTurn`（断点续跑）与 `rebuildSubConversation`（dispatch_followup）均为 events 级重建，主会话常规轮次反而是最低保真 | 高保真构件已存在，未接主路径 |
| B6 | 当前 user 消息双拼（先落库 + turnMessages 再拼） | session-service.ts:157 / runtime-entry.ts:612-615 |

### 1.3 设计原则

`message_events` 是既定设计的事件溯源单一真相源（AGENTS.md）。修复 = 让**最高频路径（同会话下一轮）**也消费它，对齐已有的 resume / followup 重建语义，而不是新造机制。

## 2. 目标 / 非目标

**目标**

1. 修复 B0：上下文窗口改为「最近 N 单位」语义。
2. 消除 B1/B2/B3/B6：跨轮上下文携带完整工具对（assistant toolCalls + tool result），中断轮次自动获得合成结果与可见标记。
3. 兼容既有压缩体系：`session_compactions` 游标收缩、摘要头注入、旧轮工具结果截断（prune）语义原样保留。

**非目标**

- 不做方案 C（session 级 standing mandate / 指令性约束提炼）——记入路线图，依赖本设计打底。
- 不改 `MemoryProvider` 接口形状（`ContextMessage` 不加 tool 角色）；不改任何 IPC 通道 / renderer。
- 不动 steer 分流逻辑、断点续跑（resume）、dispatch followup 三条既有链路的行为。

## 3. 方案 A：止血修复（可独立合入）

### A1 — 窗口语义：最早 N 条 → 最近 N 条

- `repo.ts`：`listRecentMessagesBySession(sessionId, limit)` 增加可选 `opts?: { afterTs?: number; beforeTs?: number }`（DESC 取数 + WHERE 过滤 + 反转，语义与 `listMessagesBySession` 的组合条件一致）。**加法扩展**，现有调用方（`session.ipc.handlers.ts:176` 导出、`session-service.ts:268` /compact）行为不变。
- `sqlite-provider.getConversationContext`：改调 `listRecentMessagesBySession(sessionId, opts.limit ?? 20, { afterTs: compaction?.coveredUntil })`，其余逻辑（摘要头注入、prune）不动。
- 修复后 `beforeTs` 参数失去调用方，保留接口参数（MemoryProvider 公共接口，向前兼容）。

### A2 — 终态空 body 行的合成标记

`getConversationContext` 映射后：`status` 为 `aborted`/`failed` 且 `body === ''` 的行，content 替换为合成文案：

- aborted → `[本轮已被用户中断，未产生正文]`
- failed → `[本轮执行失败，未产生正文：见消息流详情]`

作用：(a) 给模型可见的中断/失败信号；(b) 消除空 assistant 正文导致的 provider 400 风险。`done` 且空 body 的行不替换（正常终态空文极少见，替换语义不成立则跳过渲染由 B 兜底）。

> A2 是过渡防御：B 落地后主链路消费重建器，provider 侧标记保留作接口层防御（MemoryProvider 注释明示是 agent runtime 统一入口，未来可能有新调用方）。

### A 的验证

先写红测试锁行为再改（momo-debug-rules 规则 6）：

1. **B0 复现锁**：seed 25 行 → `getConversationContext(sessionId, { limit: 20 })` 断言返回**最新** 20 条（修复前红：返回最早 20 条）。
2. compaction 交互：有 `session_compactions` 行时返回 cursor 之后最近 N 条 + 头部摘要条。
3. A2：aborted 空 body 行 → 合成文案；done 空 body 行不替换。
4. 既有 `electron/tests/memory/**` 全绿。

## 4. 方案 B：主会话上下文 events 级重建（结构性主修）

### 4.1 核心变更

`turn-reconstructor.ts` 新增导出 `rebuildSessionContext`（与 `rebuildTurn` 同文件，复用其模块私有件 `createAssistantRoundAggregator` / `collectStreamEvents` / `findTurnUserBody`）：

```ts
export interface SessionContextOptions {
  /** 窗口内「回合单位」数上限，默认 20 */
  limitTurns?: number;
  /** 丢弃末尾 owner 行（= 当前轮输入，turnMessages 已含；顶层/resume 路径恒 true） */
  excludeTrailingOwnerRow?: boolean;
  /**
   * 排除指定流族的完整展开（终审 C1 修复）：resume 断点续跑复用原 streamSessionId
   * 且不插新 owner 行，被中断族若仍在 convCtx 展开一次、resumeTurn 再拼接一次
   * = 工具对整段双拼。runtime-entry 在 resumeTurn 非空时传 streamSessionIdOverride。
   * 被排除族仍注册 seenFamilies（防 #roll 行复活）并保留时间窗参与 steer 行去重。
   */
  excludeFamilySsi?: string;
}

export interface RebuiltSessionContext {
  /** LLM 消息序列（含 tool 角色），可直接拼进 LLM 请求 */
  messages: LLMMessage[];
  /** 与 messages 平行的 DB createdAt（合成消息取语义等价值）；供 compaction coveredUntil 精确化 */
  timestamps: number[];
}

export function rebuildSessionContext(
  sessionId: string,
  opts?: SessionContextOptions,
): RebuiltSessionContext
```

`runtime-entry.ts` 顶层路径（`parentStreamSessionId == null`）的 `memory.getConversationContext(roomId, { limit: 20 })` 替换为 `rebuildSessionContext(roomId, { limitTurns: 20, excludeTrailingOwnerRow: true })`；`convTimes` WeakMap 由平行数组 zip 构建（`runCompaction` 不动）。子 agent fresh-session、dispatch followup（historyPrefix）两条路径行为不变。resume 路径的 convCtx 同样换成重建器，并在 `resumeTurn` 非空时额外传 `excludeFamilySsi: streamSessionIdOverride`（C1：被中断族由 resumeTurn 重建段唯一承载，convCtx 不再重复展开；`excludeTrailingOwnerRow` 同时消解其 user 行重复）。

### 4.2 重建算法

输入：`session_id`。数据源：`messages`（结构/时序）+ `message_events`（内容保真）。

1. **拉行**：`listRecentMessagesBySession(sessionId, ROW_FETCH_MARGIN)`（默认 200 行，给分组留余量；cursor：`session_compactions.covered_until` 存在时过滤 `created_at > coveredUntil`）。
2. **分「回合单位」（unit）**，ASC 遍历：
   - **owner 行**（`sender='owner'` 且 `stream_session_id IS NULL`）：候选 user 单位；
   - **族首行**（agent 流 base 行：`parent_stream_session_id IS NULL` 且 `segment_of IS NULL` 且非族内重复）：一个族单位，族 = base + `#roll{n}` 行（`collectStreamEvents` 既有口径，`#seg` 行排除）；
   - **跳过**：`#seg` 快照行、`#roll` 非首行、子 agent 流行（`parent_stream_session_id` 非空——其内容经父流 `dispatch tool_call_result` 事件进入父回合，保真且防双渲染）。
3. **owner 行归属判定**（walk 层单点决定，族展开不再包含 user）：
   - 落在某族时间窗 `[族首行 created_at, 族末事件 created_at]` 内的 owner 行 = steer 消息行——**跳过**（族内 steer 事件会渲染 `[用户中途补充]`；时间窗用事件时刻是因为 steer 行落库先于 steer 事件 flush ≤50ms，且 steer 行必然晚于族首行）。未被 drain 的 steer（无事件）只剩 owner 行，此时该行就是唯一记录，正常渲染为 user 消息；
   - 其余 owner 行（回合起始指令、族间/末尾未应答消息）一律由 walk 按行序渲染为 user 单位。回合时序天然正确：walk ASC 序下，回合起始 owner 单位恰好位于其族单位之前（等价于 `findTurnUserBody` 的「最近在前」语义，但无需逐族反查）。
4. **族展开**：复用 `rebuildTurn` 内部逻辑并参数化（重构为共享内部函数）：
   - `includeUser: false`（user 已由 walk 决定归属；steer 行去重后由事件渲染）；
   - steer 事件全部渲染为 `[用户中途补充]` user 消息（含流末未 drain 的——区别于 resume 的 `steers[]` 数组形态，会话重建不存在「重放进 pendingSteers」的消费者）；
   - 孤儿 tool_call 合成 `INTERRUPTED_TOOL_RESULT`；半截文本收尾为完整 assistant 消息；空轮（零输出事件）展开为空 → 该族单位整体跳过（消灭空 assistant 消息，B2 在主路径根除）。
5. **窗口裁剪**：取最后 `limitTurns` 个单位（owner 单位与族单位同权计数）。
6. **摘要注入**：存在 compaction 行时，头部插入 `user: [此前对话压缩摘要]\n{summary}`，timestamp 取 `coveredUntil`（与 provider 现行为同构）。
7. **prune 移植**：最后一条 user 消息之前的 `role:'tool'` 消息，content 超 `TOOL_RESULT_MAX_LEN` 截断并附 `TRUNCATED_MARKER`（常量从 `compaction/serialize` 共享导入，防双份漂移）。
8. **timestamps**：owner 单位取行 `created_at`；**族单位消息取族末事件时刻 `endTs`（= max(族首行 created_at, 全部事件 created_at)，终审 I1 修正，原定族首行时刻）**——理由：compaction 游标 `covered_until` 取 head 末条消息时刻后，下一轮 `created_at > coveredUntil` 严格大于才排除；若族时间戳是首行时刻，则该族的 `#roll` 行 / 窗口内 steer 行（时刻均晚于首行）会幸存游标、经事件级重建**整族复活**与摘要头双内容。endTs ≥ 全部族行时刻，整族干净出局（多排除不少排除，方向安全）；`runCompaction` 的 fallback `turnStart-1` 兜底语义不变；合成条取 `coveredUntil`。

### 4.3 契约影响评估（boundary-rules 自查）

- **无跨模块契约变更**：新增导出函数 + 既有函数加可选参数，全部加法式。`MemoryProvider`/`ContextMessage`/IPC `StreamChunk`/`MessageEventRow` 均不动。
- **生产者/消费者**：`rebuildSessionContext` 消费 `messages`/`message_events`/`session_compactions` 三表现有生产者（stream-relay、sendUserMessage、compaction service），不新增事件类型。
- **一义一名**：`limitTurns`（单位数）vs 原 `limit`（行数）显式区分，不复用旧名换义。
- **行为漂移点（有意）**：convCtx 从「行级 body 拼接」变「事件级重建」——正是本设计目的；用回归测试锁新形状。

### 4.4 token 与性能

- 单位窗口 20 ≈ 20 个回合（原 20 行 ≈ 10 轮且含 segment/roll 噪声行），单回合内容变厚（工具结果进入）。控制：prune 截断旧轮工具结果 + 既有 auto-compact 不变。首版不做 token 预算动态窗口（记入后续优化，先拿正确性）。
- 查询成本：每族一次 events 查询（≤20 次）+ 一次行拉取，本地 SQLite 同步读，与 resume 单流重建同量级。

### 4.5 B 的验证

1. **案例回归锁（本案例的最小仿真）**：seed「user(bash 指令) + agent 流（bash tool_call_start/result + 无 text + aborted 终态）+ user(当前指令)」→ 单元级断言 `rebuildSessionContext` 输出恰为 `[user(bash 指令), assistant(toolCalls=[bash]), tool(result)]` 三类消息（当前指令行被 `excludeTrailingOwnerRow` 剔除）；集成级断言 runtime-entry 最终 messages 数组中当前指令恰好出现一次且工具对完整。
2. 孤儿 call：中断发生在 tool_call_start 后无 result → 合成 `INTERRUPTED_TOOL_RESULT`。
3. steer 双记录去重：族时间窗内 owner 行被跳过、drained steer 事件渲染为 `[用户中途补充]`；未 drain steer（无事件）由 owner 行渲染。
4. 子流行/#seg/#roll：跳过/排除/并族。
5. compaction：cursor 收缩 + 摘要头条 + prune 截断。
6. 空轮流：零事件族不产生空 assistant。
7. 集成：runtime-entry 上下文组装形状（既有 `runtime-*.test.ts` 扩展断言）。
8. 全量：`pnpm typecheck` + 双 workspace `pnpm test`。

## 5. 实施顺序与里程碑

1. **M1（= 方案 A）**：红测试（B0 复现）→ A1 → A2 → provider 测试全绿。可独立合入发布。
2. **M2（= 方案 B）**：`rebuildSessionContext` + `rebuildTurn` 参数化重构 → runtime-entry 接线 → §4.5 测试集。
3. **M3 收尾**：全量 typecheck/test + CHANGELOG 研发账本条目（不动版本号，按 2026-09-13 版本号纪律）。

## 6. 风险与开放问题

- **token 增长**：工具结果进入跨轮上下文，长工具输出轮次变贵。缓解：prune 已内置；若实测超预期，后续把 `limitTurns` 降档或引入 token 预算窗口（非本期）。
- **steer 时间窗启发式**：以「事件 createdAt」划族窗存在 ≤50ms flush 边界；跨该边界的双渲染/漏渲染概率极低且有 §4.5-3 测试锁常见形态。若未来出现歧义案例，正确出路是给 steer owner 行加显式标记列（boundary-rules 一义一名），本期不做。
- **Anthropic 空 assistant 400**：B 路径消灭空 assistant；A2 在 provider 路径防御。该风险本身尚未真机复现（审计推断），M1 顺带在容器 harness 验证一次。
- **`ROW_FETCH_MARGIN=200`**：两次 compaction 之间行数超 200 的超长未压缩会话，窗口退化（仍取最近 200 行内分组）。auto-compact 阈值下罕见，文档化即可。
