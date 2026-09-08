# Task 1 Report — WorkspaceFS.searchNames 递归文件名搜索

## 摘要

按 brief 完整执行 TDD：写失败测试 → 验证 RED → 实现 → 验证 GREEN → 全量回归 + typecheck → 提交。

- **状态**：DONE
- **commit**：`11ef529 feat: add WorkspaceFS.searchNames recursive filename search`
- **base**：`b1409d7`（spec/plan docs commit，main 分支）
- **修改文件**：
  - `electron/src/main/files/workspace-fs.ts`（新增 `SearchHit` 接口 + 2 常量 + `searchNames` 方法）
  - `electron/tests/files/workspace-fs-search.test.ts`（新建，10 用例）

---

## Step 1：写失败测试

按 brief 给定代码逐字写入 `electron/tests/files/workspace-fs-search.test.ts`：

- 10 个 `it` 用例：空 query、嵌套命中、大小写、子串、目录命中、`.git*` 排除、`node_modules` 排除、符号链接目录不进入 + 符号链接文件按条目匹配、limit 截断、traversalCap 截断
- 全程用真实 `tmpRoot` 临时目录 + 真实 fs，无 mock（momo-test-rules 第 5 条）
- 镜像 `src/` 结构放在 `electron/tests/files/`（AGENTS.md 强制规则）

---

## Step 2：验证 RED

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-search.test.ts
```

**结果**：10/10 全部失败，全部因为同一个原因：

```
TypeError: wsFs.searchNames is not a function
```

```
⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 10 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 空 query 返回 []
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 嵌套目录中的文件按名命中，path 含目录前缀（/ 分隔）
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 大小写不敏感（query 大写命中小写文件名）
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 子串包含（非前缀匹配）
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 目录名命中返回 isDirectory: true（目录本身参与匹配）
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > .git* 前缀条目不进入不返回（与 listDir 过滤一致）
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > node_modules 不进入
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 符号链接目录不递归进入（防环防逃逸），符号链接文件按普通条目匹配
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > limit 截断：命中数超过 limit 时只返回前 limit 条
TypeError: wsFs.searchNames is not a function
 FAIL  tests/files/workspace-fs-search.test.ts > files/workspace-fs searchNames > 遍历条目总数上限触发时安全返回已有结果（不依赖 readdir 顺序）
TypeError: wsFs.searchNames is not a function
 Test Files  1 failed (1)
      Tests  10 failed (10)
```

RED 完美——按 brief 预期的「wsFs.searchNames is not a function」运行时错误（TS 编译期也会报属性不存在）。

---

## Step 3：实现 searchNames

按 brief 给定代码逐字添加到 `electron/src/main/files/workspace-fs.ts`：

1. **模块级**（在 `DirEntry` 接口后）：
   - `export interface SearchHit { path: string; isDirectory: boolean }`
   - `const SEARCH_LIMIT_DEFAULT = 200`
   - `const SEARCH_TRAVERSAL_CAP_DEFAULT = 10_000`

2. **类内**（在 `listDir` 方法后）：
   - `async searchNames(query, limit=200, traversalCap=10_000): Promise<SearchHit[]>`
   - `q = query.trim().toLowerCase()`；空字符串 → `[]`
   - `walk(relDir)` 递归：从 `.` 开始；`abs = relDir === '.' ? rootDir : assertInWorkspace(relDir)`
   - `readdir(..., { withFileTypes: true })`；按 `e.isDirectory()` 判断（symlink-dir 天然 false，不进入）
   - 过滤：`.git*` 前缀 + `node_modules` 整条目
   - 命中条件：`lower.includes(q)`
   - 双上限：先检查 `hits.length >= limit || visited >= traversalCap` 再 `visited++`
   - 路径统一 `'/'` 分隔（`relDir === '.' ? e.name : `${relDir}/${e.name}``）
   - 复用了 `assertInWorkspace` 路径防御 + `rootDir` 边界（spec §5.1 一致）

代码与 brief 一字不差。

---

## Step 4：验证 GREEN

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-search.test.ts
```

**结果**：

```
 ✓ tests/files/workspace-fs-search.test.ts  (10 tests) 16ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  13:21:12
   Duration  344ms
```

10/10 全绿，包括最棘手的 symlink-dir 循环防护用例。

---

## Step 5：全量回归 + typecheck

### 5.1 files/ 全量

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/
```

```
 ✓ tests/files/workspace-fs.test.ts  (8 tests) 11ms
 ✓ tests/files/workspace-fs-crud.test.ts  (9 tests) 13ms
 ✓ tests/files/ipc.handlers.test.ts  (6 tests) 8ms
 ✓ tests/files/workspace-fs-search.test.ts  (10 tests) 18ms

 Test Files  4 passed (4)
      Tests  33 passed (33)
   Duration  395ms
```

无回归。8 + 9 + 6 + 10 = 33 全绿。

### 5.2 typecheck（根）

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```

```
> momo-studio@2.0.0 typecheck /workspace
> pnpm -r typecheck

Scope: 2 of 3 workspace projects
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
```

electron + renderer 双 clean。

### 5.3 lsp_diagnostics（自查）

- `electron/src/main/files/workspace-fs.ts` → `No diagnostics found`
- `electron/tests/files/workspace-fs-search.test.ts` → 仅 2 条 hint (TS 80007 "await has no effect" on line 98/100)，**非错误**

  这两处 hint 来源是 brief 给定的测试代码第 98/100 行 `await expect(hits).toEqual(...)`——`hits`/`linkHits` 是已 resolved 的 `SearchHit[]`，所以 `await` 无作用。这是 brief 故意保留的写法（与 vitest 用法对齐风格一致），不属于本任务范围；tsc --noEmit 0 errors 已确认通过。

---

## Step 6：Commit

```bash
git add electron/src/main/files/workspace-fs.ts electron/tests/files/workspace-fs-search.test.ts
git commit -m "feat: add WorkspaceFS.searchNames recursive filename search"
```

**commit hash：`11ef529`**

```
[main 11ef529] feat: add WorkspaceFS.searchNames recursive filename search
 2 files changed, 169 insertions(+)
 create mode 100644 electron/tests/files/workspace-fs-search.test.ts
```

提交只含 brief 指定的两文件，未触碰任何无关文件。

---

## 自查与最终验证

| 项 | 结果 |
|---|---|
| RED → GREEN 全程录制 | ✅ 10 fail → 10 pass |
| 测试位置合规（`electron/tests/files/`） | ✅ 镜像 src 结构 |
| 真实 fs（无 mock） | ✅ 临时目录 + 真实读写 + 真实 symlink |
| 边界覆盖：空 query / 大小写 / 子串 / 目录 / `.git*` / `node_modules` / symlink / 双上限 | ✅ brief 全部用例 |
| 双上限（limit + traversalCap） | ✅ 实现内逐 entry 检查 |
| 符号链接目录防环 | ✅ `e.isDirectory()` 对 symlink 返回 false → 天然不进入 |
| 路径分隔符 `'/'`（跨平台稳定） | ✅ 相对路径拼 `${relDir}/${e.name}` |
| `.git*` + `node_modules` 排除与 listDir 一致 | ✅ 同语义（listDir 仅 `.git*`，此处加 `node_modules`，与 brief 第 92 行 listDir 设计一致） |
| `assertInWorkspace` 路径防御被复用 | ✅ 递归调用 `assertInWorkspace(relDir)`，逃逸会被捕获 |
| 性能上限（traversalCap=10000）防病态深目录 | ✅ 命中 `visited >= traversalCap` 立即 `return` |
| TypeScript strict（无 any/ignore） | ✅ 全代码仅使用既有类型 + `SearchHit`/`SearchHit[]` |
| typecheck 双 clean | ✅ |
| commit 消息与 brief 完全一致 | ✅ |
| 未修改 brief 外的任何文件 | ✅ diff stat 仅 2 文件 |

---

## 结论

**Status: DONE**

- **Commit**: `11ef529`
- **Test summary**: 10/10 PASS（单文件） / 33/33 PASS（files/ 全量） / typecheck 双 clean
- **Concerns**: 无。后续任务（Task 2 IPC handler、Task 3 renderer）可基于此接口继续推进。
