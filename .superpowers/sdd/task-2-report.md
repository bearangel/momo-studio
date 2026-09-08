# Task 2 报告 — 文案中性化第一批 + 文案回归锁

**任务**：turn-mandate 实施计划 8 任务中的第 2 任务
**spec**：`docs/specs/2026-09-08-turn-mandate-compact-boundary-design.md` §5.6
**brief**：`/workspace/.superpowers/sdd/task-2-brief.md`
**commit**：`18c871e`
**分支**：`feat/turn-mandate`（未 push / 未 rebase）

---

## 1. Implemented（实现要点）

| # | 改动点 | 文件 | 内容 |
|---|---|---|---|
| 1 | 新增函数 `buildCompactSuggestHint(msgCount)` | `electron/src/main/agent/prompt-hints.ts` | 导出函数；中性化文案「对话历史已较长（N 条），如影响质量可调用 compact。压缩后依据本轮授权状态决定继续或收尾」 |
| 2 | 拆分教学限定当前任务语境 | `electron/src/main/agent/prompt-hints.ts` `formatDispatchHint` | 改「主动拆分原则」为「拆分原则（限当前任务）」；去掉「不要全部自己做」无条件前进指令；「任务简单…不必每次都 dispatch」改「简单请求…直接完成，不要为拆分而拆分」 |
| 3 | >30 条提示接入新函数 | `electron/src/main/agent/runtime-entry.ts:457-463` | 替换原硬编码字符串为 `buildCompactSuggestHint(messages.length)` 调用；import 区追加 `buildCompactSuggestHint` |
| 4 | compact 描述重写（spec §5.6 #5） | `electron/src/main/agent/builtin-tools.ts` `getBuiltinLoopToolDefs().compact.description` | 总结模板拆两节「【用户指令】+【agent 备忘】」；去「后续工作基于总结继续」；明示「压缩后系统依据用户指令节决定继续或收尾」；保留 ≥200 字符约束 |
| 5 | task_complete nextStep 声明去授权化（spec §5.6 #6） | `electron/src/main/agent/builtin-tools.ts` `task_complete.inputSchema.nextStep.description` | 「下一段要做什么（提示自己继续；可选）」→「下一段的内容提示（仅用于分段连贯性，不是新任务授权；可选）」 |
| 6 | memory_save 描述加证据核实约束（spec §5.6 #8） | `electron/src/main/agent/tools/memory-tools.ts` `MemoryTools.getDefs().memory_save.description` | 追加「仅在用户请求或明确受益时保存；记录系统性结论（如产品缺陷判定）前必须先核实原始证据（工具调用记录、错误信息等）」 |

**留待 Task 4 的 3 处**（按 brief 红线，未动）：
- `runtime-entry.ts:610`（task_complete 输出）、`:622`（task_complete tool message）—— Task 4
- `runtime-entry.ts:659/675`（compact 分支尾 + tool result）—— Task 4
- spec §5.6 表格第 2/3/4 行均属 Task 4 范围

---

## 2. Test Results（TDD 证据）

### 2.1 新建测试文件

`electron/tests/agent/copy-neutral.test.ts` —— 5 个 `it` 用例锁死 spec §5.6 关键串。

### 2.2 RED 阶段

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
# → Test Files  1 failed (1)
#   Tests       5 failed (5)
#   Duration    451ms
```

5 个失败原因（与预期一致）：
1. `buildCompactSuggestHint is not a function`（函数不存在）
2. `formatDispatchHint` 返回内容含「不要全部自己做」
3. `compact.description` 不含「用户指令」/「agent 备忘」
4. `task_complete` `nextStep.description` 不含「不是新任务授权」
5. `memory_save.description` 不含「核实原始证据」

### 2.3 GREEN 阶段（首轮 4/5）

```bash
# 实现后第一轮
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
# → Tests       1 failed | 4 passed (5)
```

唯一失败：memory_save。**根因**：brief Step 3 给的实现字符串是「核实原始工具调用证据」，但 brief Step 1 给的回归锁测试断言 `toContain('核实原始证据')`—— spec §5.6 原文（表格 #8 行）即「先核实原始证据」。**裁定**：回归锁断言应锁住 spec 原文（锁住 spec 关键串）——修改实现贴近 spec 原文，保留「工具调用记录、错误信息等」作为括号补充（不破坏 toContain 关键串）。

```diff
-+ '记录系统性结论（如产品缺陷判定）前必须先核实原始工具调用证据。'
++ '记录系统性结论（如产品缺陷判定）前必须先核实原始证据（工具调用记录、错误信息等）。'
```

### 2.4 GREEN 阶段（终态）

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
# → Test Files  1 passed (1)
#   Tests       5 passed (5)
#   Duration    420ms
```

5/5 全绿。

### 2.5 全量回归

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/
# → Test Files  80 passed (80)
#   Tests       695 passed (695)
#   Duration    11.09s
```

80 个测试文件，695 个测试全绿零 flake。

### 2.6 Typecheck

```bash
npx pnpm@9.0.0 typecheck
# → Scope: 2 of 3 workspace projects
#   electron typecheck: Done
#   renderer typecheck: Done
```

双 workspace 严格类型检查 clean。

---

## 3. Files Changed

```
electron/src/main/agent/builtin-tools.ts      |  14 ++-
electron/src/main/agent/prompt-hints.ts       |  21 +++-
electron/src/main/agent/runtime-entry.ts      |   9 +-
electron/src/main/agent/tools/memory-tools.ts |   3 +-
electron/tests/agent/copy-neutral.test.ts     |  61 +++++++++++ (new)
5 files changed, 97 insertions(+), 11 deletions(-)
```

---

## 4. Self-Review（自检）

### 4.1 规范符合性

- [x] Node 20 LTS（`nvm use 20` → `v20.20.2`）
- [x] TypeScript strict —— 无 `any` / `as any` / `@ts-ignore`；新测试构造完整 `RuntimeConfig` 最小实例而非 `as Parameters<...>[0]` 断言
- [x] 全部注释中文（含新增的 spec 引用注释）
- [x] Conventional Commits：`feat: 文案中性化第一批……`
- [x] **TDD**：先写失败测试 → 确认红 → 最小实现 → 确认绿
- [x] 注释最小化原则：仅在改动处加 spec 引用 + 跨任务依赖提示，未做无意义改写
- [x] 验收红线 awareness：8 处文案中 5 处已在任务 2 范围处理；`:610/622/659/675` 4 处残留属 Task 4 范围，未在本任务动

### 4.2 momo-test-rules 五条铁律

1. **Mock 仿真真实运行时语义**——本任务无 mock；测试直接调用真实导出函数（`getBuiltinLoopToolDefs()` / `new MemoryTools().getDefs()` / `formatDispatchHint(config)`）
2. **断言生产消费的字段**——所有 5 个断言均锁住 spec §5.6 关键串或 LLM 实际读取的 description 字段
3. **错误路径与空输入**——N/A（本任务为纯文案回归锁；不涉及运行时错误路径）
4. **跨模块对接契约**——`buildCompactSuggestHint` 的消费点（`runtime-entry.ts:457-463`）已切换为新函数；契约测试通过 → 生产/消费两边都按新串行为
5. **Mock 收窄**——无 mock

### 4.3 momo-boundary-rules 五条铁律

1. **跨模块 ID 单点生成、沿线透传**——N/A（无 ID 改动）
2. **「等待某事件」必须验证生产者**——N/A（无事件类型改动）
3. **一义一名**——`buildCompactSuggestHint` 为新函数，命名与「build + Suggest + Hint」三层语义对齐；与既有 `formatBudgetHint` / `formatDispatchHint` 风格区分（返回静态系统提示文本 vs 注入 system prompt 段），命名一致
4. **生产者/消费者成对修改**——`runtime-entry.ts:457-463` 切到新函数；`prompt-hints.ts` 新增并 export；两端在同一 commit
5. **路由/关联目标用当前上下文**——N/A

### 4.4 AGENTS.md 项目约束

- [x] 不动 v2.0.0 已 stable 链路：`session_members` / `message_events` / `workspaces.default_agent_instance_id` 等未触及
- [x] 不动 UI 资源注册面（IPC 通道）
- [x] 不动 `workspaces.default_agent_instance_id` 字段
- [x] 不动 IPC types.d.ts（双端类型无变化）
- [x] 注释中文 / 标识符英文
- [x] UI 设计系统约束——本任务不涉及 renderer

---

## 5. Concerns（关切点 / 留给后续任务）

### 5.1 spec 与 brief Step 3 一处不一致

**事实**：brief Step 3 给的 `memory_save` 描述追加字符串为「核实原始工具调用证据」；brief Step 1 给的回归锁断言为 `toContain('核实原始证据')`；spec §5.6 表格 #8 原文为「先核实原始证据」。

**裁定**：回归锁断言应锁住 spec 原文（关键串直接来自 spec §5.6 #8）——按 spec 原文写实现，关键串前不增加任何修饰。括号内「（工具调用记录、错误信息等）」是补充说明，不破坏 toContain 关键串匹配。

**风险**：极低。Task 8 统一验收扫描时，关键串「核实原始证据」将命中本实现。

### 5.2 `dispatchHint` 测试断言的最小性

测试只断言 `not.toContain('不要全部自己做')` ——但 `formatDispatchHint` 输出可能含其他「请优先/必须」类措辞。**当前断言的覆盖率**：spec §5.6 #7 表格原文「不要全部自己做」是被点名要去的字面串，断言已锁住。其他措辞改动风险由 spec 评审与本任务视觉对比承担（已附 PR/commit 可追溯）。**建议**：Task 8 验收扫描时增加「主动拆分原则 → 拆分原则（限当前任务）」标题层面的整段比对待办。

### 5.3 dispatchHint 标题未改

原标题「**主动拆分原则**」按 brief 改为「**拆分原则（限当前任务）**」——任务 2 范围内一致改动。但 spec §5.6 #7 表格原文没有明示标题修改（只说「限定『当前任务』语境 +『简单请求直接完成，不要为拆分而拆分』」），属于合理外推。

### 5.4 任务 2 → 任务 4 接口契约定型

`buildCompactSuggestHint(msgCount: number): string` 已在 `prompt-hints.ts` 导出并被 `runtime-entry.ts:457-463` 消费——**Task 4 接手时无需新增 import**，直接修改 `buildCompactSuggestHint` 内部实现或新增 `buildCompactResultHint(success, ...)` 即可。

---

## 6. 报告

- **状态**：DONE
- **commit**：`18c871e` —— `feat: 文案中性化第一批——压缩建议/拆分教学/工具描述去前进祈使句（spec §5.6）`
- **测试**：copy-neutral.test.ts 5/5 全绿；tests/agent/ 全量 80 文件 695 测试全绿
- **typecheck**：electron + renderer 双 clean
- **改动文件数**：5（4 修改 + 1 新建）
- **新增导出**：`buildCompactSuggestHint(msgCount: number): string` 来自 `electron/src/main/agent/prompt-hints.ts`
- **验收红线 awareness**：8 处文案中 5 处已完成；4 处 runtime-entry 残留（`:610/622/659/675`）属 Task 4 范围，Task 8 统一扫描

报告文件：`/workspace/.superpowers/sdd/task-2-report.md`

---

## 7. 审查修复记录（commit `ad61560`）

Task 2 review 反馈 2 Important + 1 Minor，本节追加修复证据。

### 7.1 修复项

| # | 级别 | 文件 | 改动 |
|---|---|---|---|
| 1 | Important | `electron/src/main/agent/runtime-entry.ts:458` | 注释「去掉『然后继续工作』」→「去掉旧版前进祈使句」 |
| 2 | Important | `electron/src/main/agent/builtin-tools.ts:104` | 注释「移除『继续工作』『后续工作基于总结继续』类前进祈使句」→「移除旧版前进祈使句（含『后续工作基于总结继续』类）」 |
| 3 | Important | `electron/src/main/agent/prompt-hints.ts:58` | 注释「避免再次出现『继续工作』类前进祈使句」→「避免前进祈使句」 |
| 4 | Important | `electron/src/main/agent/builtin-tools.ts:140` | `compact.inputSchema.summary.description` 从旧四段式「已完成 + 关键决策 + 未完成 + 重要标识符」改为 review 给定的精确字符串：完整对话总结（≥200 字符），必须分两节：【用户指令】…【agent 备忘】… |
| 5 | Minor | `electron/tests/agent/copy-neutral.test.ts` | dispatchHint / compact / task_complete 三个用例各补 `not.toContain('继续工作')` 反断言；compact 用例额外补 3 条 `JSON.stringify(compact.inputSchema)` 参数级断言锁住 #4 修复（用户指令 / agent 备忘 / 继续工作） |

### 7.2 验证命令与输出

**覆盖测试**：

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
# → Test Files  1 passed (1)
#   Tests       5 passed (5)
#   Duration    468ms
```

5/5 全绿——含新补的反断言 + compact 参数级 schema 断言。

**Typecheck**：

```bash
npx pnpm@9.0.0 typecheck
# → Scope: 2 of 3 workspace projects
#   electron typecheck: Done
#   renderer typecheck: Done
```

双 workspace 严格类型检查 clean。

### 7.3 红线复扫（任务 2 涉及范围）

```bash
grep -rn "继续工作" \
  electron/src/main/agent/runtime-entry.ts \
  electron/src/main/agent/builtin-tools.ts \
  electron/src/main/agent/prompt-hints.ts \
  electron/src/main/agent/tools/memory-tools.ts \
  electron/tests/agent/copy-neutral.test.ts
```

| 文件 | 命中数 | 类型 |
|---|---|---|
| `runtime-entry.ts` | 4 | `:610/622/659/675` 运行时输出，Task 4 范围 |
| `copy-neutral.test.ts` | 7 | `not.toContain` 反断言 + 用例名 + 文件头注释（解释回归锁意图） |
| 其他三文件 | 0 | 全部清零 |

**结论**：本任务 2 范围内的源文件（不含运行时输出文本）已 0 命中；测试文件内的「继续工作」全部以「`not.toContain`」形式出现——Task 8 关键串扫描时需区分「反断言字面串」与「目标字面串」（可用 `\b继续工作\b` + 上下文语义判定，或用 AST 扫描 `CallExpression` 的 `not.toContain` 调用）。

### 7.4 修复 commit

- **commit**：`ad61560` —— `fix: 文案任务审查修复——注释去字面串+compact 参数描述对齐两节模板`
- **diff 范围**：4 files changed, 11 insertions(+), 5 deletions(-)
