# Task 1 Report — v1.7 资源库 types.ts（统一类型 + 资源 ID 工具）

**Commit**: `333e9e5`
**Base**: `2b0e7f5`（v1.7 计划已合）
**状态**: DONE — 5/5 新增 passed，electron 全套 552/552 passed（零回归），typecheck 双 clean，LSP 无 diagnostics

> v1.6 周期的同名 report 已归档为 `task-1-report-v1.6-archived.md`（gitignored，仅本地保留）。

## 实施摘要

新建 `electron/src/main/resource/types.ts`（v1.7 资源库的基石文件，后续 14 个 task 全部引用）：

- **类型**：`ResourceType`（`'agent' | 'mcp' | 'skill'`）/ `ResourceSource`（`'builtin' | 'marketplace' | 'custom' | 'p2p'`）/ `ResourceFilter` / `ResourceItem`
- **ID 工具**：`buildResourceId(source, type, slug)` 拼 `${source}-${type}-${slug}`；`parseResourceId(id)` 用白名单正则反解三元组（非法返回 `null`）
- **展示工具**：`sourceLabel(source)` 返回中文文案（builtin=系统预置 / custom=我的上传 / marketplace=网络资源 / p2p=P2P 共享）

`ResourceItem` 采用「扁平通用顶层字段 + 四个可选 source namespace」的形状：列表渲染只需顶层字段，详情面板按 source 切到对应 namespace。字段名严格按 brief（后续 task 引用，不可改名）。

测试 `electron/tests/resource/types.test.ts` 覆盖 brief 给定的 5 个用例：buildResourceId 拼接、parseResourceId 反解（含 UUID slug）、parseResourceId 非法 id 四种边界、buildResourceId↔parseResourceId 互逆、sourceLabel 中文文案。

## TDD 5 步输出

### Step 1 — 写失败测试（RED 准备）

按 brief 逐字写 `electron/tests/resource/types.test.ts`（5 个 it 用例 + 顶部加中文文件头注释，与仓库其它测试风格一致）。

### Step 2 — 跑测试确认失败（RED 验证）

```
❯ tests/resource/types.test.ts  (0 test)
 FAIL  tests/resource/types.test.ts
Error: Failed to load url ../../src/main/resource/types (resolved id: ../../src/main/resource/types)
       in /workspace/electron/tests/resource/types.test.ts. Does the file exist?
Test Files  1 failed (1)
     Tests  no tests
```

失败原因 = 模块不存在（feature missing），非 typo / 非测试自身错误。RED 确认。

### Step 3 — 实现 types.ts（GREEN）

按 brief 代码实现 `electron/src/main/resource/types.ts`（保留 brief 给定的正则 `/^(builtin|marketplace|custom|p2p)-(agent|mcp|skill)-(.+)$/`，并补充与仓库 `marketplace/types.ts` 一致的中文 JSDoc）。

### Step 4 — 跑测试确认通过（GREEN 验证）

```
✓ tests/resource/types.test.ts  (5 tests) 2ms
Test Files  1 passed (1)
     Tests  5 passed (5)
```

### Step 5 — commit

```
git add electron/src/main/resource/types.ts electron/tests/resource/types.test.ts
git commit -m "feat(resource): v1.7 types.ts 统一类型 + 资源 ID 工具"
→ [main 333e9e5] 2 files changed, 177 insertions(+)
```

## Self-Review

### parseResourceId 正则边界（4 种非法输入全覆盖）

正则：`/^(builtin|marketplace|custom|p2p)-(agent|mcp|skill)-(.+)$/`

| 输入 | 匹配结果 | 原因 | 测试用例 |
|---|---|---|---|
| `'invalid'` | 不匹配 → `null` | 不含两个 `-` 分隔的三段 | ✓ `'invalid'` |
| `'builtin-agent-'` | 不匹配 → `null` | `.+` 要求 ≥1 字符，空 slug 判负 | ✓ 空 slug |
| `'unknown-agent-foo'` | 不匹配 → `null` | `unknown` 不在 source 白名单交替组 | ✓ 未知 source |
| `'builtin-unknown-foo'` | 不匹配 → `null` | `unknown` 不在 type 白名单交替组 | ✓ 未知 type |

合法边界：
- `'custom-agent-abc-123-def'` → slug = `'abc-123-def'`（`.+` 贪婪，允许 UUID 连字符）
- `'marketplace-skill-xlsx-remote'` → slug = `'xlsx-remote'`（互逆测试覆盖）
- `'builtin-agent-pm-agent-extra'` → slug = `'pm-agent-extra'`（首段 source/type 被 `^` + 交替组锚定，不会错切）

`if (!m || !m[3]) return null;` 中的 `!m[3]` 是防御性冗余（`.+` 已保证非空），保留以提高可读性。无 `as any` / `@ts-ignore`，两处 `as ResourceSource` / `as ResourceType` 是从已通过白名单正则的捕获组窄化，类型安全。

### ResourceItem 字段完整性（对照 brief 逐字段核对）

顶层通用字段（11 个）：`id` / `type` / `source` / `slug` / `name` / `description` / `version?` / `iconEmoji?` / `installed` / `installable` / `removable` ✓

可选 source namespace（4 个）：
- `builtin?: { category?; tags? }` ✓
- `marketplace?: { author; readme; downloadUrl; checksum; verificationStatus; sizeBytes?; installCount?; tags; category }` ✓
- `custom?: { installedAt; mcpConfig?; skillFrontmatter?; agentSystemPromptHash? }` ✓
- `p2p?: { peerId; peerName }` ✓

字段名、可选性、嵌套形状与 brief 100% 一致；后续 14 个 task（registry / IPC / store / UI）按此契约引用，无需调整。

### 仓库约束符合性

- TS strict：无 `any` / `@ts-ignore` / `as any`（LSP `No diagnostics found`）
- 中文注释：文件头说明 + 每个 export 都有中文 JSDoc
- Conventional commit：`feat(resource): ...`
- 未触动 working tree 中无关的 v1.6 时期 report 修改（task-5 / task-11 / v1.6.2-fix）

## 验证证据

| 验证项 | 命令 | 结果 |
|---|---|---|
| 单文件测试 | `vitest run tests/resource/types.test.ts` | 5 passed |
| electron 全套回归 | `vitest run` | 552 passed / 82 files（含 conduit flaky 测试也过） |
| typecheck（双 workspace） | `pnpm -r typecheck` | electron Done / renderer Done |
| LSP（实现文件） | `lsp_diagnostics` types.ts | No diagnostics |
| LSP（测试文件） | `lsp_diagnostics` types.test.ts | 仅 2 个 hint 6133（brief 要求的 `import type` 未在 assertion 中消费，编译期擦除，不影响 typecheck） |

## Concerns

无。本 task 是纯类型 + 纯函数（无副作用、无 IO、无 IPC），TDD 5/5 通过，零回归。后续 task 2+ 在此基础上构建 registry / IPC 时如遇字段调整需求，应回头修订本文件并同步 brief。
