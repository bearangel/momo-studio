# 会话导出富信息设计（rich export，v2.3.2）

- 日期：2026-09-08
- 状态：已批准（设计对话三问三 A + 架构方案 1）
- 上游：`2026-08-23-v2.0.0-platform-refactor-design.md`（message_events 单一真相源）；`2026-09-08-session-lane-steer-design.md` / `2026-09-08-steer-message-roll-design.md`（消息行结构，本 spec 消费其产物）

## 1. 背景与目标

当前会话导出（`session:exportMessages` → `formatRoomToMarkdown`）只输出 sender + body + 时间戳，`content: {}` 空对象（markdown-exporter 头注释自认「富信息导出留 v2 后续增强」）。富信息全在 `message_events` 表，导出侧从未消费。

目标：**除思考（thinking）外的所有会话信息进导出**——工具调用+结果、子 agent 委派及其回复、todo 快照、失败/中断状态。三项用户裁定：

| 决策点 | 裁定 |
|---|---|
| 呈现方式 | **时间线交错**：段序列按事件实际发生顺序内嵌每条消息（贴合 UI 显示语义，延续 2026-09-06「导出/显示对齐」先例） |
| 子 agent 回复 | **嵌套展开**：dispatch 块下递归渲染子 agent 消息（同规则，再除思考） |
| 工具结果截断 | **固定 2000 字符**，尾部标注 `（已截断，原文 N 字符）`；参数（args）全量保留 |

## 2. 现状与差距

```
导出链：session:exportMessages（session.ipc.handlers.ts:148）
  → listRecentMessagesBySession（最近 N 条）
  → 显示对齐过滤（dispatch/task_reply/parentStreamSessionId 剔除 + segment 归组）  ← 保留
  → botName 反查 → ExportMessage{content:{}} → formatRoomToMarkdown（纯 body）      ← 本 spec 改造点
```

可用数据：`message_events`（seq 全序）经 renderer `aggregateEvents` 可重建时间线——但 electron `rootDir: src` 封死主进程 import renderer 源码（测试经 vitest 可，`restart-consistency.test.ts` 先例仅限测试）。主进程已有 `events-repo.aggregateTextDeltas`（纯文本聚合）先例。

子 agent 关联：子消息行 `parentStreamSessionId` = PM 流 id（多子共享），dispatch 段携带 `subStreamSessionId`（子流自身 id）——精确展开以 `streamSessionId = subStreamSessionId` 取数，多子 agent 不混淆。

## 3. 架构方案

**主进程导出专用聚合器**（方案 1，已裁定）：`electron/src/main/im/export-aggregator.ts` 纯函数，事件流 → 导出段序列。镜像 renderer `aggregateEvents` 的配对规则（callId 配对 / isDispatch 分流 / 终态收敛），注释声明镜像关系，单测锁语义。备选否决记录：共享模块搬迁（双侧构建连锁改动过大）、渲染侧聚合（renderer 无全量数据）。

**数据流**：

```
session:exportMessages
  → 消息取数 + 显示对齐（不动）
  → 每条消息 listEventsByMessage → exportAggregator → ExportSegment[]
  → formatRoomToMarkdown 增强：段序列交错渲染
  → dispatch 段 → 按 subStreamSessionId 查子消息行 → 递归同规则渲染（嵌套）
```

## 4. 导出段类型与渲染

```typescript
// electron/src/main/im/export-aggregator.ts
export type ExportSegment =
  | { kind: 'text'; text: string }                                    // text_delta 聚合
  | { kind: 'tool'; callId: string; toolName: string;
      args: Record<string, unknown>; result: string | null;
      success: boolean | null; resultTruncated: boolean }
  | { kind: 'dispatch'; callId: string; subStreamSessionId: string;
      subAgentName: string; task: string;
      status: 'queued'|'executing'|'completed'|'failed'|'timeout'|'aborted' }
  | { kind: 'todo'; items: TodoItem[] };                              // 该位置最终快照
```

聚合规则（镜像 stream-aggregator.ts:74-288，差异仅：跳过 `thinking_delta`、todo 保留位置快照而非末值、无平铺字段）：

- `tool_call_start` / `tool_call_result` 按 callId 配对；`isDispatch && subStreamSessionId` 分流为 dispatch 段（P0-6 语义，v2 生产链路 dispatch 以 tool_call_start(isDispatch) 落库）
- 终态收敛：流终态后未配对 tool result → `(已中断)`（aborted）/`(未返回结果)`（其他），dispatch → aborted（防 UI「执行中」同款问题在导出复现）
- `status_change`/`final` → 消息级状态；`failed` 携带 error 文本

**Markdown 渲染**（markdown-exporter.ts 增强）：

```
文本        → 原样
工具调用    → 🔧 **工具** `name` → 参数 JSON 全量 → 结果截断 2000 字符（标注原长）
委派        → 📤 **委派** 子agent名：任务 —— 终态图标
              → 缩进嵌套渲染子 agent 回复（递归，规则同上、思考除外）
todo        → 清单（✓ 完成项 / ○ 未完成项）
状态标注    → 消息头 `## 🤖 name — 时间（已中断/失败：错误文本）`
```

## 5. 嵌套展开规则

- dispatch 段触发：按 `subStreamSessionId` 查子消息行（新 repo 函数 `listMessagesByStreamSessionId`，子行可多行：roll/segment 产物）
- 子消息行同样走「事件 → 聚合 → 渲染」，其自身 dispatch 再递归——**深度上限 3**，超出渲染 `（深层委派已省略）`
- 子消息查不到（窗口外/已删）→ dispatch 块仅显示终态，不炸
- 子消息行的显示对齐复用主循环同款规则（segment 归组等）

## 6. 兼容与错误处理

- **IPC 契约不变**：`{filename, content}` 形状不动，`types.d.ts` 零改动，renderer / ExportChatButton 零改动
- **legacy-export 兼容**：`exportLegacyData` 走 `toExportMessage`（无事件、body-only）——段序列为空时回退纯 body 渲染，即现状路径，行为不变
- **无事件消息**（手写行/异常行）→ 纯 body 回退
- **畸形 payload**（缺 callId/类型不符）→ 跳过该事件，导出继续；不因单事件炸整份导出
- 用户消息（无 events）→ 现状渲染不变

## 7. 验收标准

1. 含工具调用的会话导出：工具块出现在正确时间线位置，参数全量、结果截断标注原长
2. 协作会话导出：dispatch 块嵌套子 agent 回复（含子层工具调用），深度 ≤3
3. thinking 不出现在导出中任何位置
4. aborted/failed 消息带状态标注与错误文本；未配对工具结果显示收敛终态
5. legacy 路径与无事件消息渲染与改造前逐字节一致
6. 既有导出测试零回归；typecheck 双 workspace clean

## 8. 范围外

- thinking 导出开关（用户明确排除）
- 导出弹窗 UI / 截断长度可配置（YAGNI）
- 导出 JSON 格式
- P2P 镜像会话导出行为变化（沿用本地同链路，无特判）
