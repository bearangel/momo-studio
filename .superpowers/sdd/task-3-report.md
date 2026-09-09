# Task 3 报告：主进程 CompactionService + IPC 桥 + /compact 迁移

- **Status**: COMPLETE
- **Commit**: `d631e55`（分支 `feat/compaction-overhaul`，未 push）
- **测试**: electron 全量 208 文件 / 1743 用例全绿（新增 tests/compaction/service.test.ts 12 用例 + ipc-bridge.test.ts 12 用例；session-command.test.ts 适配后 11 用例）；typecheck 双 clean；修改文件 LSP 诊断零错误

## 交付物

| 文件 | 变更 |
|---|---|
| `electron/src/main/compaction/service.ts` | 新建：`generateCompaction`（prior 自读 session_compactions → resolveSessionLlm → buildCompactionPrompt → llm.chat → 空抛错 → SUMMARY_MAX_LEN 硬帽）+ `upsertSessionCompaction` / `getSessionCompaction` + `CompactionResultMsg` wire 类型 |
| `electron/src/main/agent/runtime-spawner.ts` | messageHandler 新增 `compaction:request` 分支（独立导出 `handleCompactionRequestMsg(msg, respond)` 供契约测试；成功→upsert+ok:true 回写，异常→ok:false+error；coveredUntil Number 收敛防 IPC 漂移） |
| `electron/src/main/agent/runtime-entry.ts` | 子进程侧：`pendingCompactions` Map + `requestCompaction(sessionId, conversation, coveredUntil): Promise<string>`（randomUUID 配对键单点生成、10s 超时、防竞态先注册后发送）+ `handleCompactionResultIpc` + taskMessageListener 分支 |
| `electron/src/main/im/session-service.ts` | /compact 迁移：最近一轮（最后一条 user 起）verbatim 排除 → messageToContext 映射（只产 user/assistant）→ serializeMessages → generateCompaction → upsert covered_until=头部末条 createdAt；确认消息文案不变；不再写 session_summaries |
| `electron/src/main/memory/extraction.ts` | `SUMMARY_MAX_LEN` 补 export（brief 称 T2 已导出，实际漏了——一行改动，extraction 测试全绿） |

## TDD 轨迹

红（16 failed：service 模块缺失 + 旧行为）→ 实现 → 绿（32/32）→ typecheck 两轮（修 noUncheckedIndexedAccess 两处，沿 llm-provider.ts:146 非空断言先例）→ 受影响域 979 绿 → 全量 1743 绿。

## 契约对齐自查（momo-boundary-rules）

- IPC wire 四点同 commit：子发送方 / spawner 分支 / 类型（CompactionResultMsg）/ 测试锁（ipc-bridge.test.ts 用请求侧真实生成的 streamSessionId 回喂结果侧——不经手写中间数据）
- 配对键单点生成（requestCompaction 内 randomUUID）主进程原样回传，无中途回收
- 等待的事件有生产者：`compaction:result` 的 emit 点就在 spawner 分支，契约测试双向锁死
- 错误路径专项：空摘要 / 无 LLM / llm.chat 抛错（string rejection 收敛）/ 超时 / 迟到结果 / 未知 id / 无 IPC 通道 / 仅最近一轮——共 12 个错误用例

## 与 spec 的偏差（有意）

1. **generateCompaction 签名**：spec §4.3 带 `previousSummary` 入参；按 task 契约改为服务自读 `session_compactions`（T4/T5 接口以 task 下发为准；自读消除了调用方传错 prior 的可能，单一真相源）。
2. **确认消息计数**：`[系统] 会话已压缩：${history.length} 条消息` 保持原样（含被排除的最近一轮）——「文案不变」指令优先。

## Concerns / 给 T5 的提示

- `requestCompaction` 的 streamSessionId 是**压缩请求关联键**（函数内生成），不是 chat loop 的流 id——T5 消费时无需传 ctx.streamSessionId。
- 子进程侧类型是宽松内联形状（与 task-reply/mcp 模式一致）——子进程不能 import 主进程 DB 模块，wire 严格类型只在主进程侧（CompactionResultMsg）。
- spawner compaction 分支的 `respond` 注入设计使契约测试免于真实 fork；生产 messageHandler 用 `sendCompactionResult`（通道关闭防御，mcp 同款）。
- `.superpowers/sdd/` 下有三个前序任务的未提交账本改动，未混入本 commit。
