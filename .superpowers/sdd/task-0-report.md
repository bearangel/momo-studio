# Task 0 实施报告

**Task**：验证 builtin-loader 行为 + 创建 tools/catalog.ts 常量
**Phase**：0（基础）
**Commit**：`71f7f89`
**Status**：DONE

---

## 1. 实施了什么

| 文件 | 行数 | 内容 |
|---|---|---|
| `electron/src/main/agent/tools/catalog.ts`（新建） | 56 行 | 三个导出常量：`ALL_BUILTIN_TOOLS`（24 工具，`as const`）/ `SAFE_MINIMUM_TOOLS`（7 工具，`as const`）/ `TOOL_CATEGORIES`（7 类别分组）。中文注释，标注设计依据与修改前置条件 |
| `electron/tests/agent/tools-catalog.test.ts`（新建） | 29 行 | 3 个测试用例（24 工具完整性 + 真子集关系 + 类别覆盖无重复） |

**与 brief 的偏差**：无。常量代码、测试代码、commit message 三处全部逐字按 brief 执行。

---

## 2. TDD 5 步实际输出

### Step 1：写失败测试
按 brief Step 1 创建 `tools-catalog.test.ts`（29 行）。三个测试用例：`ALL_BUILTIN_TOOLS 共 24 个`、`SAFE_MINIMUM_TOOLS 是真子集`、`TOOL_CATEGORIES 覆盖无重复`。

### Step 2：跑测试确认失败
```
命令：cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools-catalog.test.ts

 FAIL  tests/agent/tools-catalog.test.ts
Error: Failed to load url ../../src/main/agent/tools/catalog
       (resolved id: ../../src/main/agent/tools/catalog)
       in tools-catalog.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```
失败原因 = 模块不存在（符合 brief Expected）。

### Step 3：创建 catalog.ts
按 brief「共享常量」块逐字实现。三处常量：
- `ALL_BUILTIN_TOOLS`（24 项，`as const`）
- `SAFE_MINIMUM_TOOLS`（7 项，`as const`）
- `TOOL_CATEGORIES`（7 类别）

补充：中文注释解释（a）文件用途（b）每个常量的设计依据（c）修改前置条件。无额外导出、无 helper（YAGNI）。

### Step 4：跑测试确认通过 + typecheck
```
命令：cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools-catalog.test.ts

 ✓ tests/agent/tools-catalog.test.ts  (3 tests) 3ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Typecheck（双 workspace）：
```
命令：cd /workspace && npx pnpm@9.0.0 typecheck
electron typecheck: Done
renderer typecheck: Done
```

LSP diagnostics：catalog.ts 与测试文件均 0 错误 0 警告。

全量 electron 测试套件回归检查：
```
命令：cd electron && npx pnpm@9.0.0 vitest run
Test Files  74 passed (74)
     Tests  491 passed (491)
```
（含新增 3 个；无回归）

### Step 5：commit
```
git add electron/src/main/agent/tools/catalog.ts electron/tests/agent/tools-catalog.test.ts
git commit -m "feat(agent): 加 tools/catalog.ts 常量（24 工具全集 + 安全最小集 + 类别分组）"

[main 71f7f89] feat(agent): 加 tools/catalog.ts 常量（24 工具全集 + 安全最小集 + 类别分组）
 2 files changed, 85 insertions(+)
 create mode 100644 electron/src/main/agent/tools/catalog.ts
 create mode 100644 electron/tests/agent/tools-catalog.test.ts
```

---

## 3. 交叉验证：catalog 与 v1.5 实际注册工具一一对应

为确保 brief 里的 24 工具列表不是空想，对照了 v1.5 tools 注册中心（`tools/index.ts` + 各 `*-tools.ts` 中的 `name:` 字段）：

| 模块 | 文件 | 工具名 | 数量 |
|---|---|---|---|
| FileTools | file-tools.ts | read_file, write_file, list_files, edit_file, mkdir, rm, mv, exists | 8 |
| SearchTools | search-tools.ts | grep, glob | 2 |
| ShellTools | shell-tools.ts | bash | 1 |
| GitTools | git-tools.ts | git_status, git_diff, git_log, git_show, git_add, git_commit, git_branch, git_checkout, git_stash | 9 |
| WebTools | web-tools.ts | webfetch | 1 |
| TodoTools | todo-tools.ts | todowrite | 1 |
| LspTools | lsp-tools.ts | lsp_diagnostics, lsp_find_references | 2 |
| **合计** | | | **24** |

`ALL_BUILTIN_TOOLS` 与实际注册 100% 吻合。✓

---

## 4. Self-Review：plan 有什么遗漏或可改进？

### ✓ 做得好的地方
1. **TDD 5 步流程严谨**：先写测试 → 验证失败原因正确（模块不存在，非 typo）→ 最小实现 → 验证通过 → commit。每一步都有实际命令输出佐证。
2. **常量定义克制**：`as const` 断言保证了字面量类型推导（后续 task 用 `typeof ALL_BUILTIN_TOOLS[number]` 可拿到联合类型），YAGNI 原则执行到位——没有多余 helper。
3. **测试覆盖到位**：3 个测试同时保证「数量正确」「子集关系正确」「类别覆盖且无重复」，任何后续修改 catalog 触发其中一项都会失败。

### ⚠ 可改进 / 后续 task 需注意的点

1. **`as const` 副作用——TOOL_CATEGORIES 未加 `as const`**：plan 中 `TOOL_CATEGORIES` 显式标了类型 `Array<{ label: string; emoji: string; tools: string[] }>`，这意味着 `tools: string[]` 是可变数组（不是字面量联合类型）。这是**刻意**的——UI 要做勾选/排序操作，可变数组更方便。但后续 Task 1 / Migration v16 如果想用 `TOOL_CATEGORIES` 派生「类别名联合类型」会拿不到字面量。**建议**：后续 task 若需要可单独 `export type ToolCategoryLabel = typeof TOOL_CATEGORIES[number]['label'];`（仍然能拿到，因为 `label` 是 `string` 类型但实际值是字面量，TS 会从 `Array<...>` 推导出联合类型）。此项**不阻塞**，仅记录。

2. **plan 未要求 `export type` 派生类型**：当前只有 3 个值常量。后续 Task 2（DefinitionEditor UI）会需要 `ToolRef = { kind: 'builtin'; ref: string }` 这种类型——plan 里 Task 2/3 各自定义，没有集中到 catalog.ts。**建议**：如果 Task 2/3 出现重复定义，可考虑后续 task 把 `ToolRef` / `CapabilitySpec` 类型也搬进 catalog.ts 或单独 capability-types.ts。当前 task 保持 YAGNI 不动。

3. **plan Step 2 Expected 的失败信息措辞**：brief 写 `Expected: FAIL with "Cannot find module '../../src/main/agent/tools/catalog'"`，但实际 vitest + vite 的报错是 `Failed to load url ../../src/main/agent/tools/catalog ... Does the file exist?`（vite 的 module resolution 报错，不是 Node 的 `Cannot find module`）。**这是 vitest/vite 的特性，不影响 TDD 红→绿过渡**。建议 plan 后续 task 的 Expected 措辞放宽为「模块不存在类错误」而非精确字符串匹配。

4. **24 工具与 builtin YAML 的同步未在本 task 处理**：本 task 只创建常量，builtin YAML 的 `defaultTools` 同步是 Task 1 的职责。但 plan Task 1 描述里没有明确指出「YAML defaultTools 必须用 `ALL_BUILTIN_TOOLS` 全集」——builtin agent（main / sub）应该拿到全部 24 个工具，不是 SAFE_MINIMUM_TOOLS。**建议**：Task 1 实施时确认 builtin YAML 的 defaultTools = 全部 24 工具，而非安全最小集（builtin agent 是平台预置的，需全权能）。

5. **测试未覆盖「TOOL_CATEGORIES 与 v1.5 注册工具同名」的对照**：当前测试只保证 catalog 内部自洽（24 个、无重复、类别覆盖），但不保证 catalog 里的名字与 v1.5 注册中心的 `name:` 字段一一对应。理论上有人改了 `file-tools.ts` 把 `read_file` 改名 `read`，catalog 测试仍然通过，但实际运行时 agent 会找不到工具。**建议**（非本 task 范围）：后续 task 或独立 PR 加一个「contract test」——用 `buildToolRegistry()` 拿到实际工具名列表，与 `ALL_BUILTIN_TOOLS` 比对。这超出 Task 0 范围，仅记录为后续改进项。

---

## 5. 最终交付

- **Commit hash**：`71f7f89`
- **测试结果**：electron 全套 491 passed（含新增 3 passed）；typecheck 双 workspace clean
- **状态**：DONE
- **后续 task 依赖项**：Task 1（builtin YAML 同步）/ Task 2（DefinitionEditor UI）/ Task 3（crud.ts 默认工具）均可从此 commit 起引用 `ALL_BUILTIN_TOOLS / SAFE_MINIMUM_TOOLS / TOOL_CATEGORIES`。
