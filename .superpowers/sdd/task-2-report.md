# Task 2 报告：file:searchNames IPC 契约（handler + preload + types）

**Status: DONE** | **Commit: `0bca3f1`** | 基线：Task 1（`11ef529`）之上

## 做了什么

按 brief 三步 TDD 完成 `file:searchNames` IPC 通道三端接线（一处 commit）：

1. **测试先行（RED）**——`electron/tests/files/ipc.handlers.test.ts` 四处扩展：
   - `vi.hoisted` 解构加 `mockSearchNames`（保持既有 hoisted 风格，只是格式微调为一行解构）
   - `vi.mock('../../src/main/files/workspace-fs')` 工厂实例加 `searchNames: mockSearchNames`
   - `beforeEach` 加 `mockSearchNames.mockReset()`
   - 文件末尾追加 `files/ipc.handlers file:searchNames` describe（3 用例：通道注册 / 透传 query + 结果直返 / 错误沿 IPC reject）
2. **实现三端（GREEN）**：
   - `electron/src/main/files/ipc.handlers.ts`——`file:rename` 之后注册 `file:searchNames`，handler 只透传：`getWorkspaceFs(workspaceId)` → `wsFs.searchNames(query)`（含 brief 指定的契约注释：renderer 保证 trim 非空，主进程空串短路纵深防御——注意空串短路实际在 Task 1 的 `WorkspaceFS.searchNames` 内部，注释描述的是跨进程分工）
   - `renderer/src/ipc/types.d.ts`——`file` 块加 `searchNames(workspaceId, query): Promise<SearchHit[]>`；`DirEntry` 旁加 renderer 镜像 `SearchHit` 接口（跨进程独立定义，仅结构对齐，注释逐字按 brief）
   - `electron/src/preload/index.ts`——`file` 段加 `searchNames: (wsId, query) => invoke('file:searchNames', wsId, query)`（泛型 `invoke<T>` 从 `ApiSurface` 上下文推断 `SearchHit[]`，与既有绑定同机制）

## RED 证据（Step 2）

```
 ❯ tests/files/ipc.handlers.test.ts  (9 tests | 3 failed) 9ms
   ❯ ... > 注册 file:searchNames 通道
     → expected false to be true        ← ipcHandlers.has('file:searchNames') === false，通道未注册（正确失败原因）
   ❯ ... > 透传 workspaceId 定位 workspace，query 原样交给 searchNames，结果直返
     → handler is not a function
   ❯ ... > searchNames 抛错时错误沿 IPC 传播（reject）
     → handler is not a function
 Tests  3 failed | 6 passed (9)          ← 6 个既有用例不受影响
```

## GREEN 证据（Step 4）

```
 ✓ tests/files/ipc.handlers.test.ts  (9 tests) 6ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## 双 workspace typecheck（Step 5）

```
> pnpm -r typecheck
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
```

lsp_diagnostics（error 级）三个改动源文件 + 测试文件均零报错。

## Commit（Step 6）

```
0bca3f1 feat: add file:searchNames IPC channel (handler + preload + types)
 electron/src/main/files/ipc.handlers.ts   | 10 +++++++++
 electron/src/preload/index.ts             |  1 +
 electron/tests/files/ipc.handlers.test.ts | 34 +++++++++++++++++++++++++++----
 renderer/src/ipc/types.d.ts               | 12 +++++++++++
 4 files changed, 53 insertions(+), 4 deletions(-)
```

仅含 brief 指定的 4 个文件（`.superpowers/` 下无关改动未纳入）。

## 自审发现（含一项超出 brief 的排查）

- **代码逐字对齐 brief**：describe 块、handler、types、preload 行均 verbatim；仅 `vi.hoisted` 解构因加名后换行格式略有重排（语义不变）。
- **契约三端同 commit**（momo-boundary-rules 第 4 条）：handler / types.d.ts / preload 单 commit `0bca3f1`；双 typecheck clean（预加载三层 `../../../` 引用已验证对齐）。
- **既有测试风格保持**：`vi.hoisted` + 全 mock WorkspaceFS 结构未动，只加成员。
- **⚠️ 全量套件 SIGSEGV（预存环境问题，非本任务引入）**：跑全量 electron 套件时 vitest 在 53 个测试文件全绿后被 SIGSEGV 杀死（崩溃点在 migration/storage 类测试运行中）。按 momo-debug-rules 复现排查：在 Task 1 基线 commit `11ef529` 的干净 worktree 里同命令**同样复现 segfault**（EXIT=1，同位置）——确认是容器内 better-sqlite3 native binding 在 vitest 并行 worker 下的预存环境问题（AGENTS.md 已记载此类 native binding 脆弱性），与本任务改动无关（本任务不触 sqlite）。worktree 已清理。目标测试文件 + 双 typecheck（brief 的全部验证要求）均绿。
- **Task 3 依赖就绪**：`window.api.file.searchNames(workspaceId, query): Promise<SearchHit[]>` 已可用，`SearchHit` 从 `renderer/src/ipc/types.d.ts` 可导入。

## 遗留 / 关注项

- 全量套件在本容器无法完整跑完（预存 segfault，基线同样复现）；如需全量回归建议在 macOS 主机跑。不影响本任务验收标准（单测文件 9/9 + 双 typecheck clean）。
- 本文件原有内容为上一特性周期（create_task 描述纠偏）的旧报告，按本次任务指令覆盖。
