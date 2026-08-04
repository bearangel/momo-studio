# Task 2 报告 — v1.4 委派嵌套流式：Runtime PM dispatch 增强 + 子 agent 嵌套

**Status:** DONE
**Commit:** `b5f0a74` — `feat(v1.4): runtime dispatch 嵌套流式 — PM 发 dispatch chip + 子 agent parentStreamSessionId`

## 实现内容

严格按计划 `docs/plans/2026-08-04-v1.4-nested-dispatch-streaming.md` 的 Task 2 (Steps 1-5) 执行。在 Task 1 类型扩展的基础上，让 runtime 实际**使用**这些字段完成 PM↔子 agent 的嵌套流式关联。

### 修改文件 (4)

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/runtime-entry.ts` | 5 处核心改动（详见下文） |
| `electron/src/main/agent/runtime-manager.ts` | `AgentRuntimeOpts` 加 `botName?` / `botAvatar?` |
| `electron/src/main/agent/spawn-helpers.ts` | `buildSpawnOpts` 从 `def.name` / `def.iconEmoji` 填充 `botName` / `botAvatar` |
| `electron/tests/agent/runtime-stream.test.ts` | 6 个新测试用例 |

### runtime-entry.ts 的 5 处改动

#### Step 1: PM 侧 dispatch tool_call chunk 增强

`runChatLoop` 的工具执行循环中，`tc.name.startsWith('dispatch:')` 时：
1. **预生成** `subStreamSessionId = randomUUID()`（在调用 `executeDispatch` 前）
2. 从 `config.subAgents` 查找子 agent 引用，取 `description`（fallback slug → toolName）作为 `subAgentName`，avatar 用默认 `'🤖'`
3. 发送增强 `tool_call` chunk：`isDispatch: true` + `subStreamSessionId` + `subAgentName` + `subAgentAvatar`
4. `subStreamSessionId` 透传给 `executeTool` → `doExecuteTool` → `executeDispatch`

非 dispatch 工具走原有路径（无嵌套字段）。

#### Step 1 (续): tool_result 携带 subStatus

dispatch 成功 → `subStatus: 'completed'`；dispatch 失败 → 按错误信息判断：
- 错误消息含「超时」→ `subStatus: 'timeout'`（对应 `executeDispatch` 渐进式计时器的 reject）
- 其它错误 → `subStatus: 'failed'`

#### Step 2: executeDispatch 签名扩展

`executeDispatch` 新增第 6 个参数 `toolStreamSessionId?: string`，透传到 `buildDispatchMessage({ toolStreamSessionId })`。`executeTool` / `doExecuteTool` 同步加 `toolStreamSessionId?` 参数（仅 dispatch 路径使用）。

#### Step 3: 子 agent start chunk 携带 parentStreamSessionId

`runChatLoop` 签名末尾加 `parentStreamSessionId?: string`。start chunk 在 `parentStreamSessionId` 有值时额外携带：
- `parentStreamSessionId` — 关联 PM 的 stream session
- `subAgentName: config.botName` — 子 agent 展示名
- `subAgentAvatar: config.botAvatar` — 子 agent emoji 头像

`handleDispatch` 从 `dispatch.tool_stream_session_id` 读取并传入 `runChatLoop`；`handleEvent`（非 dispatch 路径）不传，默认 `undefined`。

#### Step 5: 子 agent 最终消息携带 parent_stream_session_id

`sendFinalMessage` 新增 `parentStreamSessionId?` 参数。有值时在 m.room.message content 写入 `'io.momo-studio.parent_stream_session_id'`。renderer 的 MessageList（Task 6）据此把子 agent 消息嵌套到 PM 气泡而非独立渲染。

#### Step 4: RuntimeConfig 扩展

`RuntimeConfig` 加 `botName?: string` / `botAvatar?: string`，`parseConfig` 从 AGENT_CONFIG JSON 解析（缺省 undefined）。

### spawn 链数据流

```
agent_definitions (name, icon_emoji)
  ↓ buildSpawnOpts
AgentRuntimeOpts.botName / botAvatar
  ↓ doSpawnAgent → AGENT_CONFIG JSON
RuntimeConfig.botName / botAvatar (parseConfig)
  ↓ runChatLoop → start chunk
subAgentName / subAgentAvatar → renderer dispatch chip
```

## 测试结果

### 新增测试（6 个用例）

| 用例 | 验证点 |
|---|---|
| dispatch tool_call chunk 携带 isDispatch + subStreamSessionId + subAgent 信息 | `isDispatch=true`、`subStreamSessionId` 非空、`subAgentName='研究员'`、`subAgentAvatar='🤖'` |
| dispatch 成功后 tool_result chunk 携带 subStatus=completed | `subStatus='completed'`、`success=true` |
| 子 agent start chunk 携带 parentStreamSessionId + subAgentName/Avatar | `parentStreamSessionId` / `subAgentName='研究员'` / `subAgentAvatar='🔬'` |
| 无 parentStreamSessionId 时 start chunk 不含嵌套字段 | `parentStreamSessionId` / `subAgentName` 均 undefined |
| 子 agent 最终消息携带 io.momo-studio.parent_stream_session_id | m.room.message content 含该字段 |
| 无 parentStreamSessionId 时最终消息不含 parent_stream_session_id | m.room.message content 不含该字段 |

dispatch 测试通过 mock `client.sendEvent` 拦截 dispatch 事件 + `setTimeout` 异步触发 `handleTaskReply` 来 resolve `executeDispatch` 的 pending Promise。

### Task 2 指定测试

```bash
$ npx pnpm@9.0.0 vitest run tests/agent/runtime-stream.test.ts
✓ tests/agent/runtime-stream.test.ts  (20 tests) 66ms
Test Files  1 passed (1)
Tests      20 passed (20)
```

20 = 14 个原有测试 + 6 个新增测试，全部通过。

### Typecheck

```bash
$ npx pnpm@9.0.0 typecheck
electron typecheck: Done
renderer typecheck: Done
```

### 全量回归 (electron workspace)

```
Test Files  1 failed | 55 passed (56)
Tests      3 failed | 345 passed (348)
```

3 个失败全部在 `tests/conduit/manager.test.ts`（SIGKILL/healthCheck/timeout）—— README「技术债务跟踪」已记录的预存 flaky 测试，与本 task 改动无关。345 个测试全部通过（较 Task 1 的 339 增加 6 个新用例）。

## 设计要点

1. **subStreamSessionId 在 PM 侧预生成** — PM 在发 `tool_call` chunk 前生成 UUID，通过 `executeDispatch → buildDispatchMessage` 写入 dispatch event 的 `tool_stream_session_id`。子 agent 读取后写入自己 `start` chunk 的 `parentStreamSessionId`。PM 的 `tool_call.subStreamSessionId` === 子 agent 的 `start.streamSessionId` === 子 agent 的 `start.parentStreamSessionId` 指向 PM 的 `streamSessionId`。形成双向关联，全部靠 Matrix event + stream chunk 两个通道对位，无共享内存。

2. **subStatus 超时判定用字符串匹配** — `executeDispatch` 的渐进式计时器 reject 时错误消息含「超时」（`等待子 agent ${subSlug} 回复超时`）。这是脆弱的启发式，但避免了改 `executeDispatch` 的 reject 类型（保持 Task 1 的 `executeDispatch` 返回值合同不变）。如果未来需要更精确的判定，可让 `executeDispatch` reject 一个带 `code: 'timeout'` 的自定义 Error。

3. **botName/botAvatar 优于 SubAgentRef 扩展** — 计划建议 PM 侧 dispatch chip 的 avatar 用默认 `'🤖'`（因 SubAgentRef 无 avatar 字段）。采用此方案而非扩展 SubAgentRef，原因是子 agent 的 start chunk 会携带正确的 `config.botAvatar`（从 `def.iconEmoji` 来），renderer 可用 start chunk 的 avatar 覆盖 tool_call chip 的临时 `'🤖'`，无需改 SubAgentRef/rebuildSubAgents。

4. **parentStreamSessionId 只在 handleDispatch 路径传入** — `handleEvent`（普通 @ 消息）→ `runChatLoop` 不传 `parentStreamSessionId`，start chunk 和最终消息均不含嵌套字段。测试显式验证了这一"无嵌套场景"的正确性。

## 下一步 (供后续 Task 参考)

- **Task 3** (`stream.store.ts`) 可消费本 task 产出的 chunk 字段：`tool_call.isDispatch` / `tool_call.subStreamSessionId` → 创建 DispatchChild；`start.parentStreamSessionId` → 关联子 stream 到父的 DispatchChild；`tool_result.subStatus` / `end` → 更新 DispatchChild status。
- **Task 6** (`MessageBubble.tsx` 历史还原) 会用到最终消息的 `io.momo-studio.parent_stream_session_id` 字段——本 task 已在 `sendFinalMessage` 中写入，且测试验证了有/无 parentStreamSessionId 两种场景。
- **Task 7** (中断传播) 可在 `runtime-manager.ts` 的 `relayStreamChunk` 中根据 `start.parentStreamSessionId` 建立 parent→children 映射——本 task 的 start chunk 已携带该字段。
