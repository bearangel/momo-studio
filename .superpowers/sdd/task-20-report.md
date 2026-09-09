# Task 20 Report: v2.1 设计系统规范文档 + AGENTS.md UI 规范小节

**Status**: DONE

## Deliverables

- `/workspace/docs/dev/design-system.md`（新建，74 行）—— renderer UI 开发唯一规范入口。
- `/workspace/AGENTS.md` —— 「必须遵守的约束」节新增 UI 设计系统 v2.1 bullet，「关键文档」节新增一行指向 `docs/dev/design-system.md`。

## What I wrote

### docs/dev/design-system.md

按 brief Step 1 的 markdown 块逐字写入，仅在 §5 末尾追加一行 blockquote（factual update 3）：

> README 已知限制中的旧表述将由本规范口径取代（P1 期间勘正 README）。

结构（5 节，与 brief 一致）：
1. 颜色：只用语义 token（含语义表 / dark: 前缀 / 状态徽标单源）
2. 字体 / 字号 / 间距 / 圆角 / 动效
3. 图标（lucide-react）—— 含 Do 代码示例 + 16/1.75 默认 + 禁 emoji/CDN/背景图
4. 原子组件优先 —— 12 个原子件齐全：Button、Input、IconButton、Badge、Dialog、Avatar、Tooltip、Spinner、EmptyState、Segmented、Select、Checkbox
5. Do / Don't（含 Task 1 根因结论 + README 勘正 blockquote）

### AGENTS.md

两处精确插入：
- 第 78 行后：在 `- **Conventional Commits**：...` 后追加 `- **UI 设计系统（v2.1）**：...` bullet（brief Step 2 第一个代码块原文）
- 第 137 行后：在 `.superpowers/sdd/progress.md` 行后追加 `- docs/dev/design-system.md — ...`（brief Step 2 第二个代码块原文）

## Factual updates folded in

- ESLint framing：brief 已含 "ESLint 已机械强制（P4 起全局 error + Tailwind 默认色阶移除）" —— 保留 brief 原口径，未改动。
- Task 1 根因：brief §5 已写入"动态拼接 class 禁令的根因"+ "任意值 class 静态书写时可用" —— 与 Task 1 实测一致，未改动。
- README 勘正说明：按 update 3 指示，§5 末尾追加一行 blockquote 自然嵌入。

## Verification

- `git diff HEAD~1` 仅 2 个目标文件 + 77 行 / 1 行删除，无意外污染
- 工作树其他 `M .superpowers/sdd/...` 是先前报告编辑的遗留，本任务未触碰（commit 只 staged 两个目标文件）
- Renderer test suite：727 通过 / 47 失败 —— **失败预存在**，与本任务无关：
  - 失败文件：theme.store.test.ts / FileTree.test.tsx / AppearanceSettings.test.tsx，错误模式 `localStorage.clear()` undefined（jsdom 环境问题）
  - 在 HEAD（清空本次改动）下重跑同样 47 失败 → 确认预存在
  - 4 个失败文件 `git diff HEAD` 输出 0 行 → 自上次 commit 起未改动

## Files changed

```
AGENTS.md                 |  4 ++-（2 处增补，0 改/1 末尾换行删）
docs/dev/design-system.md | 74 ++++++++++++++++++++++++++++++++（新建）
```

## Commit

`eb02d0e` — docs: v2.1 设计系统规范文档 + AGENTS.md UI 开发红线

## Self-review

- ✓ Token 名与 `renderer/src/styles/globals.css` 一致（`bg-canvas` / `bg-surface-1/2/3/active` / `text-primary/secondary/tertiary/disabled/inverse` / `border-subtle/strong/focus` / `accent-500/600` + dark 300 / `status-success/warning/error/violet` + `status-*-tint` / `bg-backdrop`）
- ✓ 原子件齐全：12 项（Button/Input/IconButton/Badge/Dialog/Avatar/Tooltip/Spinner/EmptyState/Segmented/Select/Checkbox），与 v2.1 P0 Task 6-19 落地列表一致
- ✓ task-status 单源：`renderer/src/lib/task-status.ts`（Task 4 859c694 落地）
- ✓ ESLint/P4 升级路径：与 Task 5 82a879b 一致（global warn + ui/ error，P4 起全局 error + Tailwind theme.colors 独占）
- ✓ AGENTS.md 两处锚点位置正确（Conventional Commits 后 / 关键文档末尾）
- ✓ 全中文（除代码标识符 / 路径 / class 名）

## Concerns

- Renderer 47 测试预存在失败（jsdom `localStorage` 未挂载），与本任务无关，留待后续 P 期间修复；不在 Task 20 范围
- 「P4 起全局 error」目前为 446 warnings / ui/ error（Task 5 落地态）；AGENTS.md 与 brief 一致保留 P4 升级口径
