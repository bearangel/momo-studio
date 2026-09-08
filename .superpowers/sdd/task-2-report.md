# Task 2 报告 — runtime-entry drain 扩展（roll emit 触发）

**状态：DONE** | **Commit：`c153749`** | 日期：2026-09-08
**Base：`5411031`**（T1：`message_roll` chunk 类型 + stream-relay 换行 handler）

## 做了什么

按 brief 5 步 TDD 完成 v2.3.1「steer 消息滚动」3 任务计划的第二块——runtime-entry 接入 drain 触发 `message_roll` chunk emit，让子进程告诉主进程「换行」：

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/runtime-entry.ts` | (a) `pendingSteers` 声明后新增 `hasNewTextSinceLastRoll` 标志（`let` 闭包变量，初始 `false`）；(b) `case 'text'` 分支在 `accumulatedText +=` 后追加 `hasNewTextSinceLastRoll = true`；(c) drain 块扩展为「先 if (pendingSteers.length > 0) { if (hasNewTextSinceLastRoll) { 发 message_roll chunk; 复位标志 } } 再 while push messages」三段式 |
| `electron/tests/agent/runtime-entry-steer.test.ts` | 追加第二个 `describe('runChatLoop steer 消息滚动（message_roll）')`（独立 stubProvider/beforeEach/afterEach 夹具），含 3 个新用例：drain 时有新文本发 roll、无新文本不发 roll、两次 drain 各发一次 roll；既有 4 用例移至第三个 `describe('runChatLoop abort 语义回归')`（行为不变，单纯分块避免 message_roll 夹具干扰） |

## TDD 证据

- **红**：`vitest run tests/agent/runtime-entry-steer.test.ts` → `2 failed | 5 passed (7)`——Test 1「drain 时有新文本」`expect(rollChunks).toHaveLength(1) but got +0`；Test 3「两次 drain」`expect(rollChunks).toHaveLength(2) but got +0`。Test 2（无新文本 → 不发 roll）通过是 vacuous（实现 0 emit 即满足「expect 0」），T1 已先一步把 steer 注入实现落地（drain + push messages）
- **绿（合并跑）**：`vitest run tests/agent/runtime-entry-steer.test.ts tests/agent/runtime-segment.test.ts tests/agent/dispatch-parallel.test.ts` → `Test Files 3 passed (3) / Tests 22 passed (22)`——新 3/3 + steer 既有 4/4 + segment 2/2 + dispatch-parallel 13/13 零回归
- **typecheck**：`pnpm typecheck`（electron + renderer 双 workspace）→ `electron typecheck: Done / renderer typecheck: Done`

## 一行测试摘要

7/7 steer 用例通过（3 新 + 4 既有），22/22 跨 3 文件零回归，typecheck 双 clean。

## 关键设计点（与 brief 严丝合缝）

- **标志位置**：放在 `pendingSteers` 之后、`abortListener` 之前——同属「drain 状态族」变量，与原 spec §5.2 steer drain 上下文一致；不污染 chat loop 主逻辑（chatStream/工具执行/segment）
- **置位时机**：`case 'text'` 同步置位（每次 text delta 都触发，roll 后被复位前累计）；`thinking` 不置位（spec §2.2 规定以「text delta」为准——纯 thinking 流不出可读文本，不应换行）
- **drain 守卫**：`if (pendingSteers.length > 0)` 守外层（无 steers 不发 roll，防「无输入也换行」边界）；`if (hasNewTextSinceLastRoll)` 守内层（无新文本不换行，防空新行——spec §4 表格第 1 行 + spec §2.2 防「连续 steer 在同一等待期」）；两条件 AND——只有「有 steer 且有内容可换行」时才发 roll chunk
- **复位时机**：roll chunk emit 同步后立即复位 `hasNewTextSinceLastRoll = false`（不是 push messages 后复位）——保证「同一 drain 块内」多次发 roll 不会双发（虽然 brief 没要求多层 roll，但行为一致更稳）
- **切点时序安全**（spec §2.2）：drain 在「工具循环结束 → 下一轮 LLM 请求前」执行，此刻不存在悬空 tool_call/tool_result 事件对——`message_roll` chunk 发到主进程后 `streamMessageIdCache` 换指向（流到 `#roll{n}` 新行），后续 thinking/text/tool/end 自动落新行
- **不动 stream-relay / stream-chunk / runtime-spawner**（T1 已交付，本任务只负责 emit 触发）：runtime-spawner.ts:202 白名单无需再加（已含 `message_roll`）；stream-relay roll handler 是「收 chunk 后换行」，本任务是「发 chunk」，两端解耦各管一段

## 留位与边界（spec §4）

| 场景 | 当前行为 | 验证用例 |
|---|---|---|
| steer 到达但自上次 roll 后无新文本 | 跳过 roll 只注入 | Test 2（round1 无 text → rollChunks=0，supplements=1） |
| 多条 steer 同轮 drain | 一次 roll + 全量 FIFO 注入（不逐条 roll） | 既有「多条 steer FIFO」用例 + drain 块设计（if 在 while 外） |
| roll 后流被 abort | end(interrupted) 落新行——逻辑与 roll 前的 abort 路径相同，roll 不引入新分支 | 既有 abort 语义用例（移到第三个 describe 保持 zero-change） |
| 最后一轮自然结束后 steer 未消费 | 旧逻辑不变（drain 不在循环外做） | 既有测试覆盖 |
| 旧行聚合为空文本 | `hasNewTextSinceLastRoll` 守卫已防 | Test 2 间接验证（compact 后无 text → 不 roll） |

## Concerns / 留待 T3

- **T3 门禁**：`pnpm test` 全量测试（task-2 范围只跑了 steer + segment + dispatch-parallel——其他 1074 electron + 548 renderer 应在 T3 整体跑一次），typecheck 双 clean，macOS 主机冒烟清单：实测会话场景复现双气泡（spec §6 验收 1+2+3）
- **vacuous pass 现象**：Test 2 在红阶段就通过（实现 0 emit → 满足「expect 0」）——这是 TDD 中典型的「断言倒挂」，但因为 T1 已先实现 steer drain（push messages 部分），测试断言「supplements=1」仍守住核心契约。T3 全量测试时建议确认该用例在完整路径下行为不变
- **vitest SIGSEGV 噪音**：与 T1 报告同——pnpm wrapper 偶发 SIGSEGV 在 better-sqlite3 cleanup 阶段，`Tests 22 passed (22)` 在 SIGSEGV 前已落字；属 pre-existing 现象，本任务 git stash 验证基线也带
- **`message_roll` 不影响 abort**：第三个 describe 拆出来仅因 beforeEach/afterEach 作用域隔离，行为与 T1 时期完全一致——`stats.aborted === true` + 返回 `''` + round2Messages 含补充三个断言全保留

## 文件清单（与 base 5411031 diff）

```
electron/src/main/agent/runtime-entry.ts         | 12 ++ (a/b/c 三处插入)
electron/tests/agent/runtime-entry-steer.test.ts | 192 +++++++++++++ (新 describe + 既有用例迁移)
```

注：`.superpowers/sdd/progress.md` / `task-1-report.md` 存在未提交的同期修订（T1 状态补录），未纳入本任务 commit——保留由后续 ledger 维护者处置。