# 任务断点续跑设计（v2.6.0 系列 · 工具防御第四期）

- **状态**：已批准（brainstorming 完成，2026-09-10）
- **上游**：工具体系对标分析 10 项改进之「会话持久化」线；经五轮用户澄清重塑（范围收窄为仅重启恢复）
- **前序**：v2.3.0 FileTools 防御硬化、v2.4.0 ShellTools OS 沙箱、v2.5.0 变更账本与撤销（均已合并）——本 spec 与 v2.5 账本联动（恢复卡显示半程变更统计 + 放弃可撤回）
- **债务清偿**：README 自 v1.3 起连续四版列出的「重启自动恢复 agent runtime（持久化运行状态）」

## 1. 背景与动机

现状持久化基座已强：消息/事件全落库（`message_events` 自增 seq = 全序，50ms 批）；`runChatLoop` 每轮从 DB 拉会话上下文（最近 20 条回放）——重启后在旧会话发新消息上下文已延续；压缩体系成熟（auto 阈值 + compact 工具 + coveredUntil 游标）。

**真实缺口**：app 重启（崩溃/关机/更新）时，task 域**运行中任务的执行**丢失——子进程被杀，任务停在 in_progress 悬死，长任务跑到一半 = 白跑。会话闲聊流与回放保真（fork / tool 事件重建进上下文 / 窗口扩展）经裁定不在本期范围。

**关键洞察**：「断点续跑」不需要新建 checkpoint 机制——`message_events` 本来就是流式事件的持久化真相源，回合中间态的素材已在 DB 里。半截状态的协议问题有标准解法：孤儿 tool_call（有调用无结果）合成 `[执行中断]` tool result 补齐协议对；中断瞬间的半截 assistant 文本收尾为完整 assistant 消息——两者都是合法 messages 序列。丢失仅 kill 瞬间未 flush 的 ≤50ms delta。

## 2. 目标

1. 重启后 in-flight 任务（in_progress / assigned）经启动恢复卡确认，**从中断点继续执行**（事件重建式断点续跑）
2. 已完成工具对 verbatim 保留不重跑；孤儿工具（含 dispatch）以合成中断 result 呈现事实，LLM 自决重试
3. 恢复卡与 v2.5 变更账本联动：半程变更统计 + 放弃时可先撤回
4. 恢复走既有 executor 派发路径——并发闸 / 预算 / 压缩游标全部天然生效

## 3. 非目标（明确不做）

- 会话闲聊流恢复（中断即定格，用户重发——裁定 Q3-A）
- dispatch 嵌套自动续跑（父恢复时子流不自动续；合成中断 result 后 LLM 自决重派，重派 = 全新子流——裁定 Q5-A；嵌套两阶段编排留 v2.6 观察）
- 自动恢复设置项 / 恢复策略三态（恢复卡落地后的 v2.6.x 增强）
- 断点跨版本兼容保证（事件 schema 变更时旧中断任务经「未知事件跳过 + 重建失败降级 degenerate」安全退化为全新回合——**降级本身是设计要求**）
- 崩溃 vs 正常退出区分（统一「中断」语义）
- fork / 回放保真 / 窗口扩展（原分析的其他缺口，后续 spec）

## 4. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 仅做重启恢复（fork / 回放保真不做） | 用户裁定 Q1-A：「长任务白跑」是实打实损失，其余锦上添花 |
| D2 | **事件重建式断点续跑**（非 re-run / 非回合边界重跑） | 用户裁定 Q2-A2；技术推演确认可行——message_events 即真相源 + 孤儿合成 result 技巧 |
| D3 | 仅 task 域（闲聊流不恢复） | Q3-A：闲聊有任务终态语义缺失 + 启动 LLM 调用突刺问题；半截闲聊损失 = 一句话重发 |
| D4 | 启动恢复卡确认（非全自动/非设置三态） | Q4-B：用户重启可能正为「跑歪了想停」；复用 v2.4/v2.5 卡片基建 + 账本咬合自然 |
| D5 | dispatch 视作普通被中断工具 | Q5-A：恢复语义统一交 LLM 决策；嵌套编排器价值真实但代价≈半个 spec |
| D6 | 检测时不改任务状态（卡片是唯一闸门） | 恢复无缝（in_progress 保持）；scheduler 不碰 in_progress 的现状边界用回归锁固化 |

## 5. 架构设计

### 5.1 模块形态

```
electron/src/main/agent/turn-reconstructor.ts   — 重建器（纯函数核心 + 事件读取）
electron/src/main/task/resume.ts                — 启动检测 + 恢复编排（task 域）
renderer/src/components/task/ResumeNotice.tsx   — 启动恢复卡
```

不新建持久化机制、不新建表、无 migration。

### 5.2 数据流

```
boot → resume.detectInterrupted()
     → SELECT * FROM tasks WHERE status IN ('in_progress','assigned')
     → renderer 恢复卡（逐任务：摘要 + agent 名 + journalCount）
     → [恢复] → resumeTask(id)：
         rebuildTurn(taskId) → 既有 executor 派发（并发闸生效）+ resume 载荷
         → task-config IPC 扩展：resume?: { messages; toolCallsUsed; steers }
         → 子进程 runTaskChatLoop → runChatLoop(resumeTurn) 从中断点继续
      → [放弃] → 内联二选一：直接 transition('cancelled') / 先 journal:revert 全条目再 cancelled
```

实施精化：detectInterrupted 含 session_queued（executor 放行池语义——与 assigned
同走 notifyExecutor 全新执行路径，恢复卡一并呈现）。

### 5.3 重建器语义（§2 核心纯函数）

```typescript
interface RebuiltTurn {
  messages: LLMMessage[];   // 本轮重建段（不含 system / 前轮 convCtx）；首条 = 原 user 消息
  toolCallsUsed: number;    // 已消耗工具预算（= 已发出 tool_call 事件数）
  steers: string[];         // 中断前未消费的中途补充
  degenerate: boolean;      // true = 本轮尚无任何 assistant 输出（等价全新回合）
}
```

按 seq 序聚合事件（聚合语义对齐 renderer stream-aggregator；主进程侧独立实现，不共享代码防 renderer 依赖倒灌）：

| 事件形态 | 重建为 | 说明 |
|---|---|---|
| 回合内累积 text_delta | `assistant` 消息 | 半截文本收尾为完整消息（协议合法） |
| tool_call + tool_result 成对 | `assistant(toolCalls)` + `tool` 消息对 | verbatim 保真（截断口径与 LLM 实际所见一致，无损） |
| **孤儿 tool_call**（含 dispatch） | 补 `tool` 消息：`[执行中断：进程重启，该工具未完成或结果未知。请自行判断是否重试]` | 断点核心技巧——LLM 看到事实自行决策 |
| steer 已 drain | 随消息重建 | 需实现首步验证 steer 是否已落库；无则补落（小改） |
| steer 未 drain | 进 `steers[]` 随载荷重放 | |
| thinking / message_roll | 跳过 | 不进 LLM 上下文 |
| **未知事件类型** | 跳过 | 前向兼容（schema 演进时旧中断任务安全退化） |

**降级阶梯**：degenerate（首 LLM 调用前中断）→ 重建段仅 user 消息，等价全新回合；`assigned` 状态（从未执行）→ 无事件纯重派；**重建任何抛错 → catch 降级 degenerate**（安全方向）。

### 5.4 恢复链

- `runChatLoop` 新增可选参数 `resumeTurn?: RebuiltTurn`（最小侵入，不动既有 11 个调用点语义）：messages = system（照常组装：staticSystem + mandate 重建——userBody 取重建段首条 user 消息）+ convCtx（照常拉，coveredUntil 游标零改动生效）+ 重建段；**不重发 currentBody**（已在重建段内）
- 预算：`budgetRemaining = max − toolCallsUsed`（`-1` 无限语义保留）；steers 重放进 pendingSteers + mandate.steers
- 并发：经既有 executor 派发路径，maxConcurrentTasks 天然生效
- scheduler 边界回归锁：boot 后 scheduler 仍只提升 pending→assigned，不抢 in_progress（防未来改动与恢复链竞争）

### 5.5 放弃链

既有 `task:transition(id, 'cancelled')`（验证 in_progress→cancelled 状态机合法性）；撤回 = 既有 `journal:revert(workspaceId, 全部条目 ids, {})`，行内呈现撤回结果摘要。

### 5.6 IPC 面（仅两个新通道）

`task:listInterrupted` → `Array<{ taskId; title; status; agentName; journalCount }>`；`task:resume(taskId)` → 派发结果。放弃 / 撤回复用既有通道。preload + types.d.ts 双端同步（boundary-rules）。

## 6. 恢复卡 UI（ResumeNotice）

- Boot 现查现示（瞬态，无 kv 标记）；右下角非模态卡（SandboxNotice 同款基建）
- 逐任务行：标题 / 描述 / agent 名 + 「半程变更 M 处」+ [恢复] [放弃]
- [放弃] 展开内联二选一：[直接放弃] / [撤回变更后放弃]（撤回结果行内摘要 → cancelled）
- 全部决策完卡片消散；设计系统合规（语义 token / lucide 16px / 无 emoji）

## 7. 测试策略

| 层 | 手段 |
|---|---|
| 重建器矩阵 | 完整对 / 孤儿工具（含 dispatch）/ 半截文本 / 纯 user（degenerate）/ assigned 无事件 / steer 已 drain 与未 drain / seq 乱序健壮性 / 未知事件跳过 / 重建抛错降级 degenerate |
| 恢复链集成 | 真实迁移建库 + 真实 message_events fixture → rebuildTurn 形状断言；fake LLM 确定流跑 runChatLoop(resumeTurn) → 断言已完成工具不重跑 / 新输出追加 / 任务终态 |
| boot 检测 | fixture 三态任务集 → listInterrupted 只命中 in_progress/assigned；scheduler 不抢 in_progress 回归锁 |
| **接线锁**（v2.5 C1 教训） | 生产形态：真实 executor 派发断言 resume 载荷**真实到达子进程 task-config**（不 mock 中间层；摘掉载荷注入该锁必红） |
| UI | 恢复卡 colocated（mock ipc：列表渲染 / 恢复 / 放弃二选一 / 撤回结果呈现 / 空态不渲染） |

## 8. 验收清单

1. 中断任务重启后卡片可见，变更统计与 v2.5 账本一致
2. 恢复后从中断点继续——已完成工具对不重跑（事件断言）
3. 孤儿工具的合成 result 让 LLM 可见中断事实并可决定重试
4. 放弃 → cancelled；撤回变更后放弃 → 文件恢复 + 任务 cancelled
5. assigned 任务恢复 = 全新执行（无重建段）
6. 多任务同时恢复，并发闸生效
7. steer 重放进 mandate（system 提示段含补充）
8. 恢复的回合继续受工具预算约束（续扣不重置）
9. 主机真机：流式中途杀进程重启 → 卡片 → 恢复 → 气泡从中断点继续呈现

## 9. 风险与开放问题

1. **steer 事件落库现状待验证**（实现首步）：若 steer 注入未产生事件，需补落（改 runChatLoop steer drain 处追加事件写入——小改，注意只补「中断恢复可见性」所需，不扩 scope）
2. runChatLoop 可选参数对 11 个调用点的影响面——typecheck 兜底 + 既有 runtime 测试零改动为验收线
3. 中断恰逢压缩请求 in-flight：coveredUntil upsert 可能未发生——重建按当前游标走，最坏是下轮多拉已摘要消息（被合成摘要条过滤），语义安全
4. 子进程事件读取：rebuildTurn 在主进程执行（resume.ts），读 DB 无跨进程问题；恢复载荷经既有 task-config IPC 通道传递
