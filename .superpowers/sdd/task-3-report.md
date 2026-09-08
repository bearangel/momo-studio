# Task 3 报告 — turn mandate 注入与每轮重写

**任务**：turn-mandate 实施计划 8 任务中的第 3 任务
**spec**：`docs/specs/2026-09-08-turn-mandate-compact-boundary-design.md` §2
**brief**：`/workspace/.superpowers/sdd/task-3-brief.md`
**commit**：`aab9ad4`
**分支**：`feat/turn-mandate`（未 push / 未 rebase）

---

## 1. Implemented（实现要点）

| # | 改动点 | 文件 | 内容 |
|---|---|---|---|
| 1 | 新增函数 `buildMandateHint(opts)` | `electron/src/main/agent/prompt-hints.ts` | 导入 `getTodosForSession`；导出函数返回 mandate 尾段（用户消息原文 / 中途补充 / 用户请求的未完成项 / 约束说明），pending 项过滤 source=user 且非 completed |
| 2 | `runChatLoop` 装配区拆出 staticSystem + mandate 状态对象 + refreshSystem 闭包 | `electron/src/main/agent/runtime-entry.ts:295-323` | static 段（ctx.systemPrompt + budget + dispatch + task + pinnedMem）一次组装；mandate 状态对象 `mandate = { userBody, steers }`；`refreshSystem()` 闭包重写 messages[0] = staticSystem + buildMandateHint(...)；messages 用占位 `system: ''`，构造完立即调 refreshSystem() |
| 3 | `streamSessionId` 声明提前 | `electron/src/main/agent/runtime-entry.ts:295-300` | 原声明在装配区下方（:312）会让 refreshSystem 闭包撞 TDZ；按 brief「refreshSystem 立即填充」语义前移到装配区之前，附注释说明提前原因 |
| 4 | steer drain 区维护 mandate.steers | `electron/src/main/agent/runtime-entry.ts:464-485` | `let drained = false`；drain 时 `mandate.steers.push(steer)`；drained 时调 refreshSystem()；**不引入 `wrapUpMode` 变量**（Task 4 范围；本任务独立可编译通过）|
| 5 | 每轮 for 循环顶部调用 refreshSystem() | `electron/src/main/agent/runtime-entry.ts:452-456` | spec §2「每轮重写」——未完成项可能已被 todowrite 推进/完成；跨压缩存活路径也走此保证 mandate 视图一致 |
| 6 | import 区追加 `buildMandateHint` | `electron/src/main/agent/runtime-entry.ts:19` | 从 `./prompt-hints` 拉新导出 |

**留待 Task 4 的 1 处**（按 brief 红线，未动）：
- `drained` 分支内 `wrapUpMode = false` 一行—— Task 4 声明变量并接入「收尾模式」判定

**红线自查**：
- 本任务新增/改写文案不含「继续工作」字面串——grep 命中 4 处均位于 `task_complete` / compact 分支（`runtime-entry.ts:636/648/685/701`），pre-existing 文本，本任务未触
- 全部注释中文
- TypeScript strict——未引入 `any` / `as any` / `@ts-ignore`（lint 强制）
- `wrapUpMode` 变量未声明、未使用——Task 4 独立可接线

---

## 2. Test Results（TDD 证据）

### 2.1 新建测试文件

`electron/tests/agent/mandate-hint.test.ts` —— 2 个 `it` 用例锁死 spec §2 mandate 尾段关键字段。

### 2.2 RED 阶段

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/mandate-hint.test.ts
# → Test Files  1 failed (1)
#   Tests       2 failed (2)
#   Duration    305ms
```

2 个失败原因（与预期一致）：
1. `TypeError: buildMandateHint is not a function`（函数未导出）
2. 同上（两个用例都依赖 buildMandateHint）

### 2.3 GREEN 阶段

```bash
# 实现 buildMandateHint 后
cd electron && npx pnpm@9.0.0 vitest run tests/agent/mandate-hint.test.ts
# → Test Files  1 passed (1)
#   Tests       2 passed (2)
#   Duration    238ms
```

2/2 全绿。回归锁覆盖：
- 用户消息原文注入
- 「本轮用户授权」节标题
- 无补充无未完成项时两节均显式标注「无」
- 「agent 备忘」类信息约束句（含「勿据此发起新工作」）
- 中途补充实时反映
- 用户请求的未完成项只列 source=user 的条目（agent 项不进）

### 2.4 全量回归

```bash
# electron tests/agent/ 81 文件全跑
cd electron && npx pnpm@9.0.0 vitest run tests/agent/
# → Test Files  81 passed (81)
#   Tests       697 passed (697)
#   Duration    10.67s

# 全 workspace 套件
npx pnpm@9.0.0 test
# → electron: Test Files  197 passed (197), Tests  1632 passed (1632)
# → renderer: Test Files  107 passed (107), Tests  1005 passed (1005)

# typecheck 双 clean
npx pnpm@9.0.0 typecheck
# → electron typecheck: Done
# → renderer typecheck: Done
```

运行时改动（runtime-entry.ts）未触碰既有 loop/dispatch 测试——所有 81 个 agent 测试文件维持既有通过状态。

---

## 3. 设计要点 / 边界说明

### 3.1 streamSessionId 提前声明（TDZ 处理）

brief 装配区代码示例在 `refreshSystem` 闭包内引用 `streamSessionId`，并紧接 `messages` 构造后立即 `refreshSystem()`。原代码 `const streamSessionId = ...` 在装配区下方（line 312），会撞 TDZ 让 brief 期望的语义无法成立。

**处置**：把 `streamSessionId` 声明上移到 `pinnedMem` 之后、`staticSystem` 之前（约 line 300）。该变量在原 line 312 之后的所有使用点（start chunk、消息滚动、sendStreamChunk 引用等）保持不变——`const` 块级作用域，纯前移对运行无影响。

注释标注「提前到此处声明，让 assembly 区 buildMandateHint 闭包可引用」——告知后续 reviewer 这是有意的 TDZ 排序。

### 3.2 staticSystem / mandate / refreshSystem 三件套

按 spec §2「每轮重写」：

- **staticSystem**：ctx.systemPrompt + budget + dispatch + task + pinnedMem——所有依赖 config / room / workspace 的不变量，一次组装
- **mandate**：本轮可变状态对象 `{ userBody, steers }`—— `userBody` 来自 `currentBody`（构造时锁定），`steers` 由 drain 累加
- **refreshSystem**：闭包，把 messages[0] 重写为 staticSystem + buildMandateHint(...)—— 读 mandate 与 streamSessionId

`messages[0]` 用占位 `content: ''` 构造，构造完立即 refreshSystem()——确保首次 LLM 请求已含完整 mandate 视图。

### 3.3 每轮 refreshSystem + drain 后 refreshSystem 双触发

```typescript
for (let round = 0; ; round++) {
  refreshSystem();              // 每轮：mandate.steers 已累加 / 未完成项可能已变
  // ... steer drain ...
  if (drained) {
    refreshSystem();            // 双保险（drained 时本轮末尾再次刷新）
  }
}
```

**说明**：每轮顶部已 refreshSystem，drained 分支的 refreshSystem 是双保险——若 drain 发生于上一轮末尾的尾段，则顶部 refresh 已纳入新 steers；但**两次 refresh 写入同一内容幂等**，不会引入 race 或视觉差异。

此设计延续 brief 模板，待 Task 4 在此位置插入 `wrapUpMode = false` 时无需重排 drain 逻辑。

### 3.4 mandate 只读 user 挂靠项

`buildMandateHint` 过滤 `t.status !== 'completed' && t.source === 'user'`——agent 自发项（source='agent'）不进授权节。这与 spec §5.2「用户授权范围」严格对齐：LLM 看到的就是用户授权的精确边界，不会被自己的备忘项污染。

未完成项的实时性：跨压缩存活走 refreshSystem() 路径——compact 分支不动 mandate 对象，下一轮 refresh 时自动读到最新 todoStore 视图（Task 6/Task 4 落地）。

---

## 4. 与下游任务的契约

本任务交付给 Task 4/5/6 的精确边界：

| 接口 | 状态 | Task 4 接入点 |
|---|---|---|
| `buildMandateHint({ userBody, steers, streamSessionId })` | ✅ 已导出 | Task 4：wrapUpMode 触发路径复用同一函数 |
| `mandate = { userBody, steers: string[] }` | ✅ 闭包内 | Task 4：可读 mandate.userBody 判定收尾边界 |
| `refreshSystem()` 闭包 | ✅ 已存在 | Task 4：可在 compact 分支末尾显式调用以保证 mandate 视图最新 |
| `drained` 标志 | ✅ 局部 let | Task 4：插入 `wrapUpMode = false` 一行（注释已留位） |

任何 Task 4 接入均不破坏本任务独立编译——`wrapUpMode` 变量由 Task 4 声明。

---

## 5. Concerns / 风险

无 P0 关注点。

**可观察项**（非阻塞）：
1. **mandate.steers 无去重**——同一补充重复发送会重复入列表（沿用既有 messages.push 行为；steer 入 messages 也无去重，跨轮累加）。本任务按 brief 实现；如需去重属后续 polish。
2. **drained 双 refresh 等幂**——每次 refresh 写入同一内容，benchmark 无明显开销；多写一次 ≈ 5 行字符串拼接，纳秒级。

---

## 6. 提交

```
[feat/turn-mandate aab9ad4] feat: turn mandate 注入与 system prompt 每轮重写（跨压缩存活的授权边界）
 3 files changed, 107 insertions(+), 10 deletions(-)
 create mode 100644 electron/tests/agent/mandate-hint.test.ts
```

**未触发**：push / rebase / hooks skip。分支仍为 `feat/turn-mandate`，HEAD = `aab9ad4`，base = `ad61560`（Task 2 终点）。