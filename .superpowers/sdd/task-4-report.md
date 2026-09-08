# Task 4 报告：compact 双态与确定性收尾轮

- **状态**：DONE
- **Commit**：`2a1a6c7` — `feat: compact 双态——user 挂靠续跑/无挂靠收尾轮无工具机械终止（spec §5.1）`
- **分支**：`feat/turn-mandate`（未 push，未 rebase）
- **BASE**：aab9ad4（T3 之后）

## 一、改动内容

### `electron/src/main/agent/runtime-entry.ts`（+71/−18）

1. **`pendingUserItems()` 闭包**（refreshSystem 之后）：与 `hasPendingUserTodos` 同谓词（`status !== 'completed' && source === 'user'`）的本地取数闭包——compact 双态布尔判定与文案条数 K 共用同一次快照 `pendingItems`，单一来源防「判定说有、文案说无」漂移（brief 展开注记的强制要求）。
2. **`wrapUpMode` 声明**（segmentCount 变量区）：回合级内存状态，仅顶层 chat 路径 compact 置位，steer drain 清除。
3. **steer drain 分支**：T3 预留位接入 `wrapUpMode = false`（在 refreshSystem 之前，新指令优先于收尾，spec §5.1）。
4. **tools 装配行**：`wrapUpMode || budgetRemaining <= 0 ? undefined : chatTools`——收尾轮无工具 → 模型只能输出终文 → finishReason=stop 机械退出（沿预算耗尽先例）。
5. **compact 分支重写**：
   - 双态判定：`mandateGated = parentStreamSessionId == null && !config.currentTaskId`；有 pending user todo → 续跑，无 → `wrapUpMode=true` 收尾；task 域 / dispatch 子路径不 gate。
   - 尾部指令三态：续跑「请继续完成」/ 收尾「请输出简短总结后结束本轮，不要开始新工作」/ task 域中性「请基于总结继续当前任务」。
   - tool_result 文案按双态分叉（续跑含 `仍有 K 项用户待办`，K 取自 pendingItems）。
   - 删除第二条前进指令消息（spec §5.6 #4：三份指令合并为尾部指令 + 回执）。
   - 分支内补 `refreshSystem()`（compact 清空历史后立即基于当前 todo 重建 mandate 段）。
   - summary 过短拒绝分支保持原样（不触碰 wrapUpMode——失败的 compact 不应收尾）。
6. **task_complete 两处文案**（spec §5.6 #6）：`'继续工作'` / `'请继续工作，…'` → `'请继续输出当前回复的下一段'`。

### `electron/tests/agent/compact-wrapup.test.ts`（新建，236 行）

真实 `runChatLoop` + fake LLM 剧本回放 harness，4 用例：
- **(a)** 无 user 挂靠 → 压缩后下一轮 `captured[1].tools === undefined`（核心机械保证，断言未弱化）+ 回合终止 + 收尾文案 + 全程无「继续工作」
- **(b)** 有 user 挂靠 → 工具正常 + `messages[0]` 含「本轮用户授权」（mandate 跨压缩存活）+ 续跑文案
- **(c)** 收尾模式 drain 出 steer → 清除收尾、恢复工具 + `[用户中途补充]` 注入（spec §5.1 交互 / §7-2(c)）
- **(d)** task 域（currentTaskId 非空）→ 工具正常、不进收尾 + task 域中性文案

## 二、测试与验证

| 项 | 结果 |
|---|---|
| compact-wrapup.test.ts | 4/4 PASS（先 RED：(a) `expected [] to be undefined` + (b)(d) 旧文案断言失败，形态符合 brief Step 2 预期；(c) 现状即绿，作为改造后防回退锁） |
| `tests/agent/` 全量 | 82 文件 / 701 测试全绿 |
| electron 全量 | 198 文件 / 1636 测试全绿 |
| 根 typecheck | electron + renderer 双 Done |
| lsp_diagnostics（runtime-entry.ts） | 0 错误 |
| 红线 grep「继续工作」runtime-entry.ts | **0 命中**（运行时字符串 + 注释全清） |

环境备注：容器 shell 在 bash 调用间会重置回 Node 26，导致 better-sqlite3 `Module did not self-register`——**预存环境问题**（干净工作树 stash 对照复现），每次调用显式 `nvm use 20` 后全部通过，与本任务改动无关。

## 三、brief 适配点决策记录

1. **vi.mock hoisting（适配点 ①）**：采用 repo 既有模式（`vi.mock` 工厂只含 `vi.fn()` + `mockImplementation` 注入剧本回放 generator），零 hoisting 风险——同 `runtime-entry-steer.test.ts` / `runtime-segment.test.ts`。`captured`/`script` 为模块级状态，无工厂闭包。
2. **text delta 字段（适配点 ②）**：`{ type: 'text', content }`（llm-provider StreamDelta 实际类型；`delta` 字段名会让 runChatLoop 读到 undefined）。tests 不在 tsc include 内，typecheck 不会兜底，已按实际类型手改。
3. **runChatLoop 参数个数（brief 未列明的适配点 ③）**：brief 草稿 7 参调用会把 SID 落到 `externalAbortSignal`（第 7 参）→ `addEventListener is not a function`。正确为 8 个位置参数（`…, stats, parent, signal, override`）。
4. **mkConfig 补全**：按 runtime-config.ts 实际接口补 `agentAssignmentId/agentUserId/systemPrompt/role/devMode/mcpNames` 等必填字段（brief 草稿缺、`as RuntimeConfig` 掩盖），免 cast。
5. **memory mock 收窄**：`__setMemoryProviderForTest` 注入 9 方法 stub（真实 memory 模块），替代 brief 草稿的整模块 `vi.mock`——mock 收窄原则（momo-test-rules 第 5 条）+ repo 既有模式。
6. **新增第 4 用例 (c)**：spec §7-2 核心回归锁四例之一（steer×wrapUpMode 交互），brief 3 例未覆盖；现状下即绿（作为改造后防回退锁），是自审重点项的最强证据。
7. **K 取数偏离伪代码一行**：brief 伪代码 `hasPendingUserTodos(streamSessionId)` 做 boolean + 闭包取 K 会造成两份过滤条件；按 brief 展开注记改为 `pendingItems`（一次快照）同时供布尔与 K。`hasPendingUserTodos` 保留为 todo-tools 公共谓词 API（自身单测锁定，谓词一致性由注释双向标注）。

## 四、自审（四重点）

1. **双态判定边界**：mandateGated 精确实现 spec §5.1 三态覆盖（顶层 chat / task 域 / dispatch 子路径）；pendingUser 短路——非 gate 路径不消费 todo；过短拒绝分支不置位；连续 compact 每次重判（todo 可能被 todowrite 推进）。
2. **steer×wrapUpMode**：drain 分支先清 wrapUpMode 再 refreshSystem（T3 澄清的承载性 refresh 保留）；测试 (c) 锁定；收尾轮自然结束后未消费 steer 沿 v2.3 既有语义（进会话历史不重派发）；既有 runtime-entry-steer.test.ts 全绿（其 compact 载体场景与新逻辑兼容）。
3. **task 域 / dispatch 不变式**：`!mandateGated → wrapUpMode 恒 false`，工具永不剥离；测试 (d) 锁 task 域；dispatch 子路径与 task 域同走第三态文案，既有 dispatch 套件（fresh-session/parallel/session-boundary 等）全绿佐证。spec §5.6 #4 的删除在全域一致生效（该条未限定作用域）。
4. **K 单一来源**：见上文适配点 7——布尔与 K 取自同一次同步快照，判定与文案永不矛盾。

## 五、已知软边界（spec §4 明示记录，非缺陷）

- steer「停下」但 agent 未清 todo 即压缩 → 误续跑；abort 按钮兜底（spec §4 场景 1）。
- wrapUpMode 下不合规 provider 无视 `tools=undefined` 仍返回 tool_use 时工具会执行（预算允许时）——与 spec「软边界，可接受」一致，主流 provider 不发生。

## 六、结论

spec §5.1 双态 + §5.6 #2/#3/#4/#6 文案全部落地；红线（运行时「继续工作」清零、核心断言未弱化、typecheck/测试全绿）全部满足。特性核心行为「同样输入『压缩上下文』→ agent 终止于压缩确认」由用例 (a) 机械化锁定。

---

**报告人**：Sisyphus-Junior
**报告时间**：2026-09-08
**commit**：2a1a6c7

---

# 修复报告：审查补锁（Task 4 review fixes）

- **状态**：DONE
- **Commit**：`f52eab7` — `fix: compact 双态审查补锁——三态文案K值/dispatch子路径/过短拒绝回归锁`
- **改动面**：仅 `electron/tests/agent/compact-wrapup.test.ts`（+71/−1），生产代码零改动（contract 1 ✓）

## 修复项对照

### Important 1 — 三态 tool_result 文案 / K 值 / 第二份指令消息删除 回归锁

- **harness 补强**：process.send stub 改为收集型（`sentChunks` 数组，同 runtime-segment.test.ts 模式）——关键接线事实：runChatLoop 的 chunk 走模块级 `sendStreamChunk`（= `process.send?.(chunk)`）而非 `ctx.sendStreamChunk`，捕获点必须在 process.send。新增 `compactToolResults()` 过滤 helper。
- **(b) 续跑态**：tool_result 含「仍有 1 项用户待办」（K=1，spec §5.6 #3）。
- **(a) 收尾态**：tool_result 含「无用户待办，请输出总结收尾」。
- **(a) 第二份指令消息删除锁**（spec §5.6 #4）：round-2 `role==='tool'` 消息恰 1 条 + 反断言不含「请继续基于总结工作」。

### Important 2 — dispatch 子路径第三态覆盖（新用例 (e)）

- 8 参调用形态：第 6 参 `parentStreamSessionId='pm-sid-1'` + `streamSessionIdOverride=SID`（override 优先级高于 parent，todo 键控不变）。
- 断言：下一轮 `tools` 为数组（不进收尾）+ 尾部指令与 tool_result 均含 task 域中性文案「请基于总结继续当前任务」。

### 顺手项 — 过短拒绝无锁（新用例 (f)）

- compact 传 `'太短'`（< 50 字符）→ 断言回填 LLM 的 tool 消息含「过短」+ 下一轮 `tools` 仍为数组（失败的 compact 不置 wrapUpMode）。

## 验证

| 项 | 结果 |
|---|---|
| compact-wrapup.test.ts | 6/6 PASS（原 4 用例——Important 1 断言并入 (a)(b)——+ 新 (e)(f)；三项 finding 断言全部落位） |
| 根 typecheck | electron + renderer 双 Done |
| git 改动面 | 仅测试文件（`git status` 复核） |

说明：审查描述「原 4 + 新 3」按 finding 计数；实际 it 块为 4+2=6（Important 1 的三处断言是并入既有用例的补强，非新用例）。

---

**修复报告人**：Sisyphus-Junior
**commit**：f52eab7
