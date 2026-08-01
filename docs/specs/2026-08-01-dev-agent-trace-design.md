# dev 模式 Agent 行为日志设计

> **版本**：v1.2.2
> **日期**：2026-08-01
> **状态**：已确认，待编写实施计划
> **依赖**：v1.2 M3+M4 已合并 main

## 1. 背景

开发模式下排查 agent 行为问题（超时、不响应、工具调用错误等）时，缺乏实时可观测性。当前 agent 子进程只有零散 stderr 错误日志，LLM provider 零日志，工具审计只写 SQLite 不实时显示。需要在 dev 模式下向终端输出每个 agent 的行为摘要。

## 2. 方案

在 `runtime-entry.ts` 加轻量 `trace()` 函数，在 agent 行为关键节点写格式化单行到 stdout。现有 `runtime-manager.ts` 已捕获子进程 stdout 并转发到终端（logger.info）。不改 UI、不改 IPC 协议。

## 3. 日志格式

父进程已自动加 `[agent:<instanceId>]` 前缀。trace 输出单行，箭头表示方向（→ 发起 / ← 收到）：

```
[agent:pm-agent] → 收到消息 (room=!team, from=@owner, body=42字)
[agent:pm-agent] → 决定响应 (mentioned=true, coordinator=true)
[agent:pm-agent] → LLM #1 (openai/glm-5.2, msg=3, tools=5)
[agent:pm-agent] ← LLM #1 (1.2s, tool_use, calls=1)
[agent:pm-agent] → 工具: dispatch:coder (输入=42字)
[agent:pm-agent] ← 工具: dispatch:coder (15.3s, ✓)
[agent:pm-agent] → LLM #2 (openai/glm-5.2, msg=5, tools=5)
[agent:pm-agent] ← LLM #2 (0.8s, stop)
[agent:pm-agent] → 回复 (room=!team, 156字)
```

子 agent dispatch 路径：
```
[agent:coder] → 收到 dispatch (from=pm-agent, task=42字)
[agent:coder] → LLM #1 (openai/glm-5.2, msg=2, tools=3)
[agent:coder] ← LLM #1 (45.2s, tool_use, calls=1)
[agent:coder] → 工具: write_file (输入=2048字)
[agent:coder] ← 工具: write_file (0.1s, ✓)
[agent:coder] → 发送 completed (89字)
```

## 4. 插桩点

| 位置 | 事件 | 字段 |
|---|---|---|
| `handleEvent()` 消息接收 | `→ 收到消息` | room, from, type, body字数 |
| `handleEvent()` / `decideResponse()` 响应决策 | `→ 决定响应` 或 `→ 跳过` | mentioned, coordinator, isTeamRoom, 原因 |
| `runChatLoop()` LLM 调用前 | `→ LLM #N` | provider, model, msg数, tools数 |
| `runChatLoop()` LLM 响应后 | `← LLM #N` | 耗时, finishReason, toolCall数 |
| `runChatLoop()` 回复发送 | `→ 回复` | room, 长度字数 |
| `executeTool()` 工具开始 | `→ 工具: <name>` | 输入字数 |
| `executeTool()` 工具完成 | `← 工具: <name>` | 耗时, ✓/✗ |
| `executeDispatch()` dispatch 发出 | `→ dispatch` | 目标slug, taskId |
| `executeDispatch()` dispatch 超时 | `← dispatch 超时` | slug, stage |
| `handleDispatch()` 收到 dispatch | `→ 收到 dispatch` | from, task字数 |
| `handleDispatch()` 发送 in_progress | `→ 发送 in_progress` | — |
| `handleDispatch()` 完成 | `→ 发送 completed` | body字数 |
| `handleTaskReply()` 收到 reply | `← reply` | status, body字数 |
| `fetchWithRetry()` 重试 | `→ LLM 重试` | attempt, statusCode, 退避秒数 |

## 5. trace 函数

定义在 `runtime-entry.ts` 内部：

```typescript
function trace(event: string, fields?: Record<string, unknown>): void {
  if (!config.devMode) return;
  const parts = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  process.stdout.write(`${event}${parts}\n`);
}
```

`config.devMode` 从 `AGENT_CONFIG` JSON 解析，由主进程 `!app.isPackaged` 推导。

## 6. dev 模式判定

主进程统一使用 `!app.isPackaged` 作为 dev 模式标志。`spawnAgent` 时将 `devMode: !app.isPackaged` 写入 `AGENT_CONFIG`。子进程 `parseConfig` 解析此字段，缺省为 `false`（安全默认）。

## 7. 安全约束

- 不记录 LLM prompt / response 正文
- 不记录工具输入 / 输出正文（只记录字数）
- 不记录 API key / token / Authorization header
- 不记录完整 AGENT_CONFIG
- `fetchWithRetry` 重试日志只记录 HTTP statusCode，不记录响应体

## 8. 改动范围

| 文件 | 改动 |
|---|---|
| `runtime-entry.ts` | 加 `trace()` 函数 + `devMode` 配置解析 + 14 个插桩点 |
| `runtime-manager.ts` | `AgentRuntimeOpts` 加 `devMode?: boolean`；spawnAgent 传入 AGENT_CONFIG |
| `spawn-helpers.ts` | `buildSpawnOpts` 传递 `devMode` |
| `llm-provider.ts` | `fetchWithRetry` 重试时 stdout.write 日志（同子进程内） |

## 9. 不在范围内

- UI 日志面板（终端输出即可）
- 完整 prompt/response 正文（行为摘要足够）
- 按 agent 分离日志文件
- 日志搜索/过滤
- 生产模式日志变更（现有行为不变）
