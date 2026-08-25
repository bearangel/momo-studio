# Task 5 Report: 内部事件桥——runtime-entry 的 dispatch/task_reply 脱离 Matrix 传输

## 1. Status

**DONE**

## 2. Commit

```
19f7903 feat(agent): 内部事件桥——dispatch/task_reply 脱离 Matrix 传输
```

10 files changed, +473 / −130（仅含本任务文件；仓库内预存的 `.superpowers/sdd/task-*-report.md` 修改与未跟踪 `docs/2026-08-14-system-feature-inventory.md` 未纳入提交）。

## 3. 变更清单

### 新增

| 文件 | 内容 |
|---|---|
| `electron/src/main/agent/internal-event.ts` | 子进程侧协议：`INTERNAL_EVENT_MSG`（'momo-internal-event'）+ `InternalEventMsg` 信封 + `sendInternalEvent`（`process.send?.()`）+ 便捷构造器 `sendDispatchEvent` / `sendTaskReplyEvent` / `sendAbortDispatchEvent`（eventType 分别绑定 dispatch.ts 三个常量） |
| `electron/src/main/agent/internal-event-bridge.ts` | 主进程侧桥：`setBridgeRouter(svc \| null)` 注入 RouterService；`handleChildMessage(msg)` 识别内部事件 → 构造 InternalEvent 形状（getType/getContent/getSender/getRoomId 四个闭包访问器）→ `routeEvent(event, 'owner', null)` fire-and-forget（带 `.catch` 兜底防 unhandled rejection）。RouterService 未注入时 warn + 返回 true（消费丢弃）；非内部事件返回 false |

### 修改

| 文件 | 变更 |
|---|---|
| `runtime-entry.ts` | ① `main()` 重构：task-driven 分支**不再创建 Matrix client**（无 createClient/startClient/waitForPrepared/joinRoom/MyMembership 监听），只 build ctx + 注册 task-config/shutdown listener；v1 fallback 分支整段保留原 client 用法（标注 Task 13 删除边界）。② `runTaskChatLoop(cfg, config, ctx)` 去掉 client 参数，内部传 `null` 给 runChatLoop。③ `runChatLoop` / `executeTool` / `doExecuteTool` / `executeDispatch` 的 client 参数放宽为 `MatrixClient \| null`。④ `executeDispatch` 发送分流：client 非空 → 原 Matrix sendEvent（v1 行为不变）；null → `sendDispatchEvent(teamRoomId, config.botUserId, {...dispatch.content})`（展开满足 Record 索引签名）。abort 同理走 `sendAbortDispatchEvent`。⑤ `sendFinalMessage` client 为 null 时 early return（task-driven 最终消息不发 Matrix——SQLite 由 chunk 路径 routeChunkToBuffer 承载，spec §4.1 ③）；task_complete 分段 sendEvent 包进 `if (client)`。⑥ v1-only 的 `handleEvent` / `handleDispatch`（含其 task_reply Matrix 发送）完全未动 |
| `runtime-spawner.ts` | messageHandler 首行前置 `if (handleChildMessage(msg)) return;`——内部事件优先转桥，已消费不进 chunk 通道 |
| `router-bootstrap.ts` | `ensureRouterService` 末尾 `setRouterService(currentRouterService)` → `setBridgeRouter(currentRouterService)`；`destroyRouterService` → `setBridgeRouter(null)`；删除 sync-manager import。**sync-manager 侧 `setRouterService` 导出保留**（Task 12 删除），router-bootstrap 不再调用它 |
| `init-runtime.ts` | 仅注释更新（注入目标说明 + 循环依赖描述修正） |

### 测试适配（场景覆盖全部保留）

| 文件 | 变更 |
|---|---|
| `tests/agent/router-bootstrap.test.ts` | mock 目标 sync-manager → internal-event-bridge；5 个场景断言 `setBridgeRouter`（首次启动传 RouterService 实例 / 幂等 1 次 / 空 runners no-op / destroy 传 null / destroy no-op） |
| `tests/integration/router-lazy-init.test.ts` | 同上——vi.hoisted mock 换到 internal-event-bridge 的 `setBridgeRouter`；3 个场景（initTaskDrivenRuntime 批量恢复 / startAgentRuntime 单启动 / 2 agents 幂等 1 次）断言不变 |
| `tests/agent/runtime-task-driven.test.ts` | 适配新签名：8 处调用去掉 `mockClient()` 参数，删除 mockClient helper 与 MatrixClient import；场景全部保留 |

## 4. TDD 记录

- **RED**：先写 `tests/agent/internal-event-bridge.test.ts`（9 用例），运行失败——`Failed to load url ../../src/main/agent/internal-event-bridge`（模块不存在，预期失败原因）。
- **GREEN**：实现两模块后单跑 9/9 通过。

新增测试覆盖：
1. dispatch 内部事件 → routeEvent 以正确 InternalEvent 形状调用（type/content/sender/roomId + 'owner' + null）
2. task_reply / abort_dispatch eventType 透传
3. StreamChunk / task-end / null / 字符串 / 数字 / 缺 eventType → false 不消费
4. RouterService 未注入 → true + 不抛错
5. routeEvent reject → 无 unhandled rejection
6. sendDispatchEvent / sendTaskReplyEvent / sendAbortDispatchEvent → process.send 信封契约（type/eventType/sessionId/sender/content）
7. process.send 缺失（非 fork）→ 不抛错

## 5. 验证输出

### 聚焦测试

```
tests/agent/internal-event-bridge.test.ts   9 passed
tests/agent/router-bootstrap.test.ts        5 passed（适配后）
tests/integration/router-lazy-init.test.ts  3 passed（适配后）
tests/agent/runtime-spawner.test.ts         2 passed
tests/agent/runtime-task-driven.test.ts     9 passed（签名适配后）
tests/agent/dispatch-fresh-session.test.ts  4 passed（未改——仍以 client 调 runChatLoop，v1 路径）
tests/agent/runtime-stream.test.ts         22 passed（未改——断言 Matrix sendEvent 的 dispatch 场景走 client 非 null 分支）
tests/agent/runtime-segment.test.ts         5 passed
tests/integration/task-driven-dispatch-chain.test.ts 5 passed（未改）
tests/agent/abort-dispatch.test.ts + runtime-entry-routing.test.ts + dispatch.test.ts 14 passed
```

### 全量门禁

```
typecheck（root，双 workspace）：electron Done / renderer Done
electron 全套：Test Files 139 passed (139) / Tests 919 passed (919)
renderer 全套：Test Files 50 passed (50) / Tests 407 passed (407)
lsp_diagnostics（5 个改动源文件）：zero errors
```

## 6. 设计决策与理由

1. **共享函数按 client 是否为 null 分流，而不是无条件替换 sendEvent**：`runChatLoop → executeTool → doExecuteTool → executeDispatch` 链路被 v1（taskDriven=false）与 task-driven 两模式共享，而 v1 子进程由 runtime-manager 自己 fork + message handler 管理（不走 runtime-spawner，未接桥）。无条件替换会静默打断 v1 dispatch。因此 task-driven 传 null 走内部事件桥、v1 传真实 client 保持 Matrix 传输——精确满足"v1 分支不动、task-driven 脱离 Matrix"。v1 分支（main() else 段 + handleEvent + handleDispatch）零改动，Task 13 整体删除。
2. **sender 字段用 `config.botUserId`**：Task 2 后 RuntimeConfig 仍为 `botUserId`（parseConfig 确认）；代码注释标注 Task 10 更名 agentUserId 后同步替换。RouterService 当前路由不消费 getSender()（dispatch 按 content.dispatch_to 反查、task_reply 按 content.reply_to），sender 为信息性字段。
3. **bridge 的 routeEvent 加 `.catch` 兜底**：RouterService.routeEvent 内部已 try/catch，但 IPC handler 内 fire-and-forget 若遇极端 reject 会成 unhandled rejection——加 catch + logger.error 更稳（brief 代码按仓库实际微调）。
4. **m.room.message 最终/分段发送在 task-driven 下直接跳过而非删除代码**：sendFinalMessage 顶部 `if (!client) return`、分段 send 包 `if (client)`——效果等同"删除 task-driven 完成路径的 Matrix 发送"，同时 v1 行为逐字节不变。
5. **router-bootstrap 不再调 setRouterService 是有意为之**：sync-manager /sync → RouterService 的 m.room.message 路由在本任务后断开（用户聊天入口由后续任务重建为非 Matrix 入口）；sync-manager 导出与 InternalEvent(RoutedEvent) import 保留至 Task 12。与 brief 指令一致。

## 7. Concerns / 移交后续任务

1. **sync-manager 路由断开（预期中间态）**：m.room.message → RouterService 的链路随 setRouterService 解绑而失效，task-driven agent 暂不响应 Matrix 用户消息——待后续任务以新输入源（IPC/直连）重建用户聊天入口。
2. **task-driven 模式 task_reply 发送侧未接**：sub-agent 的 runTaskChatLoop 仍只发 task-end IPC（PM 等待侧 handleTaskReply 的 'task-reply' IPC 消费链也未在 task-driven 分支注册）。`sendTaskReplyEvent` 已就绪但暂无 runtime-entry 调用点（v1 的 handleDispatch 用 Matrix 发送且不动）——后续任务接通 sub 完成回执时使用。
3. **abort_dispatch 经桥到达 RouterService.routeAbortDispatch 仍是 TODO(T8) stub**（仅日志）；与 Matrix 时代行为等价（v1 子监听 Matrix event；task-driven 中断走 AgentRunner.abortStream IPC）。
4. **PM dispatch 等待侧**：pendingReplies 由 handleTaskReply 消费，task-driven 下需后续任务把 notifyTaskReply 的 'task-reply' IPC 接到该函数（本任务范围外）。

## 8. 自审结论

- runtime-entry 全部 `client.sendEvent` 逐一核验：v1-only（handleEvent 错误回复 683；handleDispatch task_reply 716/770/784）与 client 分支或早退守卫（1039 分段、1462/1472 最终消息、1742 abort、1761 dispatch）两类，task-driven 路径零 Matrix 传输。
- runtime-manager.ts 的 `handleChildMessage`（L621）是 v1 路径的同名局部函数，与桥导出无冲突。
- 提交范围干净：不含预存报告改动与无关文档。
