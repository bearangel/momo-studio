# Task 3 Report (sidebar-search) — FileTree 搜索框 + 扁平结果列表

> 注意：此报告对应 sidebar-search 任务（commit `5f5cada`），不与既有 task-3-report.md（starter 团队分支，commit `064adc6`）混淆。本报告追加在同文件末尾做附录，原报告保留不动。

## 状态
DONE（commit `5f5cada`，renderer typecheck 干净，全套 987 测试通过）

## 改动文件（仅 brief 指定的两份）
- `renderer/src/components/files/FileTree.tsx` — 加搜索状态 / 防抖 effect / 搜索框 / 错误行 / 主体切换（搜索态 → 扁平结果列表；非搜索态 → 既有树视图保留）
- `renderer/src/components/files/FileTree.test.tsx` — 扩 `mockApi.file.searchNames`、补 `act`/`afterEach` import、追加 7 个 `describe('FileTree 文件名搜索')` 用例

未触碰任何 brief 未列文件。

## Step 1 → Step 2（RED）

`renderer/` 下 `npx pnpm@9.0.0 vitest run src/components/files/FileTree.test.tsx`：

```
 Test Files  1 failed (1)
      Tests  7 failed | 5 passed (12)
```

7 个新用例全部因 `getByLabelText('搜索文件')` 找不到元素而失败——符合 brief §Step 2 预期。5 个既有测试全绿。

## Step 3（实现）
逐字转录 brief §Step 3 代码块。要点：
- `import { ipc } from '../../ipc/client'` + `import type { SearchHit } from '../../ipc/types'`（与 Task 2 IPC 表面对齐）
- `useState` 加 `query` / `results` / `searchError`；`useRef<number>` 做竞态守卫序号
- 防抖 200ms `useEffect`，依赖 `[query, workspace]`，空 query 直接清空恢复树（不发 IPC）
- 主体按 `searching = query.trim() !== ''` 切换
- UI：搜索框用 `lucide-react` 的 `Search`/`X`/`FileText`/`Folder`（size 14 / stroke 1.75）；语义 token（`bg-surface-3` / `text-tertiary` / `text-status-error` / `border-subtle`），无硬编码颜色，无 emoji
- 文件行 `<button onClick={() => onSelectFile(hit.path)}>`，目录行 `<div>` 不可点击

`handleRefresh` / `handleCreate` / `handleEmptyClick` / `handleEmptyContextMenu` / `targetLabel` 与 `FileContextMenu` / `PromptDialog` 渲染区按 brief 指示保持原样。

## Step 4（GREEN）

```
 RUN  v1.6.1 /workspace/renderer
 ✓ src/components/files/FileTree.test.tsx  (12 tests) 276ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

12 用例全绿（7 新 + 5 既有）。新增覆盖：防抖 200ms / 空态「无匹配文件」/ 目录不可点+文件可点 / 清除恢复树+停止再发 / 错误文案 / 竞态守卫（旧响应不覆盖新结果）/ 200 条上限截断提示。

## 全套回归

- `npx pnpm@9.0.0 typecheck`（renderer）：`tsc --noEmit` exit 0，无错无警
- `npx pnpm@9.0.0 test`（renderer 全套）：105 文件 / 987 用例全绿（21.5s，无 flake）

## 备注 / 自审
- 7 个新测试完全按 brief 给定字符串断言（`搜索文件`/`清除搜索`/`无匹配文件`/`搜索失败：boom`/`已显示前 200 条匹配` 等）——文案与 brief 一字不差，未来误改文案即红
- 防抖窗口 200ms 在测试中分两段 `advanceTimersByTimeAsync(100)` 验证「窗口内不发」+「到点发」，保真度高于单步 200
- 竞态守卫用例构造一个未决 stalePromise，触发 q2 后才 resolve stale；生产代码用 `seqRef` 序列号比对丢弃，验证真实运行时语义
- `useRealTimers()` 在 `afterEach` 强制还原，避免污染后续 `mockApi.file.list` 的现有测试
- 既有 5 个测试无需任何改动即全绿，说明搜索态是严格叠加而非侵入式重构

## Commit
- `5f5cadafe8e7cbd433e4106155dee542d010e1cf` — `feat: file tree sidebar search with flat result list`
- 文件统计：2 files changed, 265 insertions(+), 10 deletions(-)
