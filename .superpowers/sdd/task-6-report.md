# Task 6 Report — 溢出恢复 + 重放 + 防循环（compaction-overhaul，spec §7 + T5 遗留 Important-1）

**Status**: DONE
**Branch**: feat/compaction-overhaul
**Commit**: `f9d98ae`

> 注：本文件原为 turn-mandate 计划同名 Task 6 报告（`/compact` 主进程链路，commit `58f8d3e`+`2746072`，已收官），按当前 compaction-overhaul 计划指示覆盖为本计划 Task 6 报告。

## 1. 实现概要

TDD 严格执行：新建 `electron/tests/agent/overflow-recovery.test.ts` 7 用例先行（6 红——功能缺失的精确断言失败，1 绿——非 overflow 错误的既有行为锁）→ 实现 → 全绿。

**逐文件变更**（2 文件，+483/−6）：

| 文件 | 变更 |
|---|---|
| `electron/src/main/agent/runtime-entry.ts` | ① 模块级 `OVERFLOW_ERROR_RE`（spec §7 措辞，`.{0,20}` 有界距离防过拟合）；② chatStream catch 内 AbortError 判定之后的溢出恢复分支：`!overflowRecovered`（回合级 flag）+ 特征匹配 + `estimateConversation > MIN_TRIGGER` → `runCompaction()` 成功 → 置 flag、重放本轮授权（`mandate.userBody` + steers 逐条 push 为 user 消息）、清 wrapUpMode（沿 steer drain「新指令优先于收尾」先例——恢复=重试本轮）、continue 外层轮循环；失败/二次溢出 → 原错误路径（end error + throw 原始错误）；③ `runCompaction` 去参化：coveredUntil 内部按 head 末条真实消息已知时刻计算（convCtx 来源 → WeakMap 精确 timestamp；回合内 → `turnStart - 1`）；auto/compact 两处 `runCompaction(Date.now())` 调用点改为无参；④ `turnStart`（回合首行）+ `convTimes` WeakMap 支撑（按引用跟随，压缩重建 messages 后尾部 convCtx 条目仍精确） |
| `electron/tests/agent/overflow-recovery.test.ts` | 新建 401 行 7 用例（fake-LLM 剧本扩展 throwError 能力 + mock requestCompaction IPC 边界 + process.send 捕获 end chunk 形态） |

## 2. TDD 证据

- **RED**：(a)(a2)(b)(e) 因无恢复逻辑失败（IPC 0 次/提前 throw）；(c1) `expected 1788923105614(Date.now()) to be 1712345678000`——旧 coveredUntil 过覆盖 bug 精确复现；(c2) `expected 1700000000000 to be 1699999999999`——fake timers 冻结下与旧值恰差 1；(d) 绿（regex 不过拟合锁，既有行为）
- **GREEN**：7/7（(a2) 一次测试侧断言顺序修正——实现 push 顺序 userBody→steers 符合 mandate 契约，测试期望写反）

## 3. 测试矩阵

| 用例 | 锁定 |
|---|---|
| (a) | 首轮溢出 → IPC 恰 1 次 + 摘要条 + 重放 userBody（末条 verbatim）+ 工具恢复 + end(stop) 正常完成 |
| (a2) | steers 参与重放（userBody 后跟 `[用户中途补充]` steer）且**不回写 mandate.steers**——steer 全程恰 3 次（system 提示段 1 + 原 drain 1 + 重放 1），误回写则 4 |
| (b) | 二次溢出 → end error 终止 + IPC 仍仅 1 次（防循环） |
| (c1) | coveredUntil === head 末条 convCtx 消息精确 DB timestamp（旧 Date.now() 红） |
| (c2) | head 末条回合内消息 → `turnStart - 1`（冻结时钟 `FROZEN-1`；旧值 `FROZEN`） |
| (d) | 'network error' → 直接终止不压缩（非 overflow 不误恢复） |
| (e) | 恢复压缩失败 → 原溢出错误终止（错误不吞不改，end error 为原始溢出信息非压缩失败信息） |

## 4. 验证矩阵

| 验证 | 结果 |
|---|---|
| `tests/agent/` 全量 | 87 文件 / 749 测试全绿（T5 compact-auto 七用例 + compact-wrapup 十三用例零弱化） |
| electron 全量 | 211 文件 / 1767 测试全绿 |
| typecheck（根） | electron + renderer 双 clean |
| 红线「继续工作」字面 | changed files grep 0 命中 |

## 5. Self-review（任务指定重点）

- **overflow flag 回合级生命周期**：`overflowRecovered` 为 runChatLoop 闭包内 `let`——回合生回合灭，仅成功恢复置位；下回合重新可恢复。(b) 锁定回合内单次。
- **重放不与 mandate 注入重复**：只 push 消息，不触碰 mandate 状态对象（steers 不回写 `mandate.steers`，提示段不翻倍——(a2) 锁死）。与尾部 anchor 保护副本的重叠是 spec 无条件重放的既定语义（「重放本轮授权」），增量有界、flag 防循环兜底。
- **coveredUntil 边界不变式**：尾部含 convCtx 消息 ⟹ head ⊆ convCtx 前缀 ⟹ head 末条精确时间戳；head 末条回合内 ⟹ 尾部全回合内（createdAt ≥ turnStart > turnStart−1）。两方向均不过覆盖（未摘要消息绝不消失）。当前 user 消息落 head（steer 锚点场景）时必已被摘要，覆盖它语义正确——(c2) 正是此场景。WeakMap 对缺 timestamp 的 stub 运行时优雅降级（`get → undefined → ?? turnStart-1`）。
- **AbortError 优先级零变化**：仍为 catch 首判（off → interrupted → return 原序）；唯一结构差异是**非 abort 路径**的 `process.off` 后移至恢复尝试之后——恢复 await 期间监听保持存活，期间 abort 可被下一轮 abort 分支承接（既有 abort/stream 全量套件绿）。
- **孤儿 tool 防护覆盖重放路径**：重放只 push user 消息（user-after-tool 协议合法），不制造 tool 消息；尾部工具对原子性由既有切点规则保证。
- 附带改进：end chunk `error` 字段对非 Error throwable 由 `undefined` 变为 `String(err)`（`error?: string` 形状兼容）。

## 6. 遗留与关注（非阻塞）

1. 重放使 userBody 在上下文双份（尾部 verbatim + 重放）当锚点保护保住原消息时——spec 既定（无条件重放）；est 增量一份 userBody，防循环 flag 兜底。
2. `OVERFLOW_ERROR_RE` 是措辞启发式：未覆盖的 provider 报错措辞按普通错误终止（安全方向——宁可终止不误恢复）；新措辞可在模块级常量一处扩展。
3. turnStart 取 runChatLoop 入口；当前 user 消息落库先于 runtime spawn（createdAt < turnStart），但其入 head 必伴随已被摘要，`turnStart-1` 覆盖正确（§5 第三条）。
4. macOS 主机冒烟未做（容器无真实 provider）：建议主机验收补「长会话人为压小窗口触发溢出 → 观察恢复重放与终止两路径」。
