# Task 4 报告：历史收缩 + 摘要注入 + prune（spec §5/§8）

- **Status**: DONE
- **Commit**: `5f1f04d`（分支 `feat/compaction-overhaul`，未 push）
- **测试**: 新增 conversation-shrink.test.ts 11 用例（先红 8/11 → 绿 11/11）；tests/memory/ 95 全绿；electron 全量 209 文件 / 1754 测试全绿；renderer 107 文件 / 1012 全绿（保险跑）；typecheck 双 clean；LSP 零新增诊断（steer 测试文件的既有 LSP 噪声经 stash 对照证实与本次改动无关）

## 改动

| 文件 | 内容 |
|---|---|
| `electron/src/main/storage/messages/repo.ts` | `listMessagesBySession` 增可选 `afterTs`（`created_at > ?` 严格大于，与 beforeTs 动态组合）；既有调用方零影响（不传时 SQL 语义与原先逐字节一致） |
| `electron/src/main/memory/sqlite-provider.ts` | `getConversationContext`：读 `session_compactions` → 有行则 afterTs 过滤 + 头部注入 `{ role:'user', content:'[此前对话压缩摘要]\n'+summary, timestamp:coveredUntil, sender:'owner' }`；`pruneOldToolResults` 模块级 helper（旧轮次 eventType='tool_call_result' 且 >2000 字符 → 前 2000 + `\n[truncated]`；最后 user 回合含其后全部豁免；无 user 消息全视为旧轮次） |
| `electron/src/main/compaction/serialize.ts` | `TOOL_RESULT_MAX_LEN` / `TRUNCATED_MARKER` 导出共享（spec §4.2/§8 同源，防双份定义漂移） |
| `electron/tests/memory/conversation-shrink.test.ts` | 真 DB harness（沿 compaction/service.test.ts 模式）：12 条 + covered_until=第 8 条 → [注入条, 9..12]；无行 → 12 条全返回原序；prune 3000/2000/2001/非工具/无 user/零持久化/收缩组合 |
| `electron/tests/agent/runtime-entry-steer.test.ts` | 测试基建修复（见下） |

## 裁定记录

1. **循环依赖**：静态确认 `sqlite-provider → compaction/service → memory/extraction → memory/index → sqlite-provider` 成环 → 按预案下沉 provider 直读 `session_compactions` 单查询（与本文件 `getPinnedContext` 直读 `session_summaries` 既有模式一致）；serialize.ts 为纯函数模块（唯一 import 是 type-only），共享常量无环。
2. **prune 落点**：provider 拉取层而非 `messageToContext`——后者被 extraction `fetchLatestWindow` 与 `/compact` 序列化共用，改它外溢影响两条非目标链路。
3. **工具结果识别**：messages 行的判别列是 `eventType`（取 `'tool_call_result'`，与 message_events 同名分类）；`ContextMessage` 无 tool 角色可依。当前无生产写入方落这种行（工具结果实际存 message_events），prune 为按契约就位的拉取时变换，后续持久化路径接入即生效。
4. **prune 无条件生效**：spec §8（P5）是独立于 §5 收缩的拉取时变换——「无行 → 现行为不变」仅约束收缩+注入；测试分别锁定两种形态。

## Extraction 零交叠确认

`extraction.ts` 中 `getConversationContext` 仅出现在注释；实际拉取走自有 `fetchLatestWindow`（直接 SQL），`messageToContext` 未改动 → 收缩/prune 对 extraction 窗口零影响（95 用例全绿实证）。

## 顺带修复（既有缺陷，非断言改动）

`runtime-entry-steer.test.ts` abort 回归 describe 原先漏注 stub provider，走默认 `SQLiteMemoryProvider` 读宿主真实 `~/.momo-studio/state.db`（旧 schema 缺 v30 表即炸；全新机器上 `messages` 缺表同样会炸；且有污染真实用户数据隐患）。修复：stub 提升模块级 + 该 describe 补 beforeEach/afterEach 注入。生产路径无对应问题（boot 必跑 runMigrations）。

## Concerns

- 注入条不计入 `limit`（limit 语义原样下推 SQL，作用于过滤后集合）——已测试锁定，如 T5 需要注入条计入预算需显式调整。
- runChatLoop 现拉 `{ limit: 20 }` 为 ASC 最早 N 条（既有语义）；收缩后 =「covered 之后的最早 20 条 + 摘要」，与 spec §5 意图一致，但若 T5 期望「最近 20 条」需另立改动（非本任务范围）。
