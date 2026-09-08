# Task 1 报告：message_roll chunk 类型 + stream-relay 换行 handler

**状态：DONE** | **Commit：`5411031`** | 日期：2026-09-08
**Base：`41a4f54`**（spec `ba596a5` + 实施计划 `41a4f54` 的下一个提交）

---

# Task 1 报告：exportAggregateEvents 纯函数（v2.3.2 会话导出富信息三任务 T1）

**状态：DONE** | **Commit：`08f5213`** | 日期：2026-09-08
**Base：`f9f14aa`**（实施计划 doc commit 前一提交）

## 做了什么

按 brief 严格 TDD 执行三步：

1. **Step 1（写失败测试）**——创建 `electron/tests/im/export-aggregator.test.ts`，8 个 describe 用例完整覆盖 spec §4 验收点：text 聚合/thinking 排除/tool 配对（args/result/success）/终态收敛（done=未返回结果，aborted=已中断）/isDispatch 分流 + subStatus 回执/dispatch 无回执收敛/todo 位置快照（非末值胜出）/error 捕获/畸形事件防御（缺 callId / delta 非字符串）。
2. **Step 2（确认 FAIL）**——`vitest run tests/im/export-aggregator.test.ts` → `Test Files 1 failed (1) / Tests no tests`（模块加载错误：`Failed to load url ../../src/main/im/export-aggregator`）。✓ 符合预期。
3. **Step 3（写实现）**——创建 `electron/src/main/im/export-aggregator.ts`，导出 `ExportDispatchStatus` / `ExportSegment` / `ExportAggregateResult` 三类型与 `exportAggregateEvents` 函数。配对规则镜像 renderer stream-aggregator.ts（callId 配对、isDispatch 分流、终态收敛），主进程无法 import renderer 源码故镜像 + 单测锁语义。
4. **Step 4（确认 PASS）**——8 passed（8/8），耗时 434ms。
5. **Step 5（提交）**——commit `08f5213`，Conventional Commit 格式 `feat:` 开头，2 files changed, 269 insertions(+).

## 测试命令与输出摘要

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/im/export-aggregator.test.ts
```

**PASS 输出**：
```
✓ tests/im/export-aggregator.test.ts  (8 tests) 3ms
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  434ms
```

## 额外验证

- `lsp_diagnostics` 双文件：No diagnostics found
- `npx pnpm@9.0.0 typecheck` 整体：exit 0（tsc --noEmit 全 clean）
- 未改 brief 之外的任何文件
- 未引入新依赖

## 自查发现

- **导入路径全部确认**：`MessageEventRow`（`../storage/messages/events-repo`）、`TodoItem`（`../agent/tools/todo-types`）两路径与 brief 完全一致，源码中存在
- **镜像实现注释到位**：实现文件顶部明确标注「配对规则镜像 renderer stream-aggregator.ts」并写明主进程无法 import renderer 源码（electron tsconfig rootDir: src 封死）故镜像 + 单测锁语义，改 stream-aggregator 配对规则时此处必须同步
- **TypeScript strict 无 any/@ts-ignore**：未引入
- **8 用例覆盖矩阵**：text 聚合 ✓ / thinking 排除 ✓ / tool 配对 ✓ / 终态收敛（done+aborted 双分支）✓ / Dispatch 分流 ✓ / dispatch 无回执 ✓ / todo 位置快照 ✓ / error 捕获 ✓ / 畸形事件防御 ✓
- **imports 走 brief 指定路径**：未自创别名或绕路

## 留待 T2/T3

- **T2**（导出 handler + Markdown 渲染）：本任务只产纯函数聚合器；handler（IPC 路由 + DB 查询 + Markdown 拼接）属 T2
- **T3**（UI 接线 / 设置项 / 端到端冒烟）：本任务未触

## Concerns

无。

## 做了什么

按 brief 5 步 TDD 完成 v2.3.1「steer 消息滚动」3 任务计划的第一块——主进程新增 `message_roll` chunk 通路，让 runtime-entry 在 drain 到用户补充且有新文本时发此 chunk 触发主进程「换行」：

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/stream-chunk.ts` | 联合类型末尾新增 `message_roll` 成员（带 spec §2.1 来源 JSDoc，区分 segment_boundary）；文件头生命周期注释补一行 |
| `electron/src/main/agent/runtime-spawner.ts:202` | StreamChunk 白名单数组加 `'message_roll'`（否则 chunk 到不了 stream-relay） |
| `electron/src/main/agent/stream-relay.ts` | 新增模块级 `rollCounts` Map（streamSessionId → 已 roll 次数）+ 测试用 `__rollCountsForTest`；`clearStreamSessionCache` 体内追加 `rollCounts.delete`；`routeChunkToBuffer` switch 在 segment_boundary 后新增 `case 'message_roll'`：旧行终态化（flush → aggregateTextDeltas → updateMessageStatus(done) → pushSessionMessage → final event）→ 新行 insert（继承 sessionId/sender/parentStreamSessionId/workspaceId，streamSessionId 拼 `#roll{n}`，status=streaming）→ streamMessageIdCache 换指向 → pushSessionMessage → status_change event |
| `electron/tests/agent/stream-relay-roll.test.ts` | **新建**——5 个用例：基本 roll 后双行结构、roll 后 text/end 落新行、多 roll 计数递增、end 后清理（防御性双轮回滚）、无旧行静默跳过 |

## TDD 证据

- **红**：`vitest run tests/agent/stream-relay-roll.test.ts` → 5/5 FAIL（`__rollCountsForTest is not a function`，TS 联合类型收窄也失败）
- **绿（合并跑）**：`vitest run tests/agent/stream-relay-roll.test.ts tests/agent/stream-relay.test.ts` → `Test Files 2 passed (2) / Tests 24 passed (24)`——新文件 5/5，**既有 stream-relay 19/19 零回归**
- **typecheck**：`pnpm typecheck`（electron + renderer 双 workspace）→ `Done / Done`

## 一行测试摘要

5/5 新增用例通过，19/19 既有 stream-relay 用例零回归，typecheck 双 clean。

## 关键设计点（与 brief 严丝合缝）

- **缓存换指向而非替换**：roll 后 `streamMessageIdCache.set(chunk.streamSessionId, rollMsg.id)` 让后续 thinking/text/tool_call/tool_result/end 经 `resolveMessageId` 自动落新行，零分支改动
- **新行 streamSessionId 加 `#roll{n}` 后缀**（与 segment 的 `#seg{n}` 同法）——避免双行同值歧义
- **旧行 streamSessionId 保留不动**（即原 `ss-r`）——历史/审计/订阅者按 id 继续定位旧行
- **roll 计数 end 时清理**——`clearStreamSessionCache` 体内加 `rollCounts.delete(streamSessionId)`，防御性双轮回滚测试锁死
- **白名单在 spawner**——runtime-spawner.ts:202 不加 `'message_roll'` 则子进程的 chunk 在主进程入口被丢弃，永远到不了 routeChunkToBuffer
- **status_change 事件同步推**——新行有 status_change event（status: 'streaming'），renderer message_event_batch 流能看到
- **mock electron 复刻 P0-2 回归锁**——pushSessionMessage 路径与既有 stream-relay.test.ts 一致，验证新行也走 session:message 通道

## Concerns / 留待 T2/T3

- **T2（runtime-entry drain）**才是真正在用户补充且新文本时发 `message_roll` chunk 的地方——本任务只把通道打通，drain 触发逻辑与条件判定留 T2
- **多次 roll 计数防御**：测试 4 验证了同 streamSessionId 跨 end 重启的清理——但生产中同 id 重启流属于异常路径（runtime-entry 应该用新 uuid），本测试是合同级防护
- **旧行 status 强置 done**：roll 是显式换行而非结束，旧行状态按 done 落（语义：用户读到该行就看到完整 body），与 segment_boundary 区分——segment_boundary 不改父 message status
- **vitest SIGSEGV 噪音**：组合跑两文件时 vitest 进程 exit code 非 0（better-sqlite3 cleanup 触发的 pnpm wrapper 报 SIGSEGV），但 `Tests 24 passed (24)` 在 SIGSEGV 之前已落字——属 pre-existing 现象，git stash 验证基线也带，本任务未引入
