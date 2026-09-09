# Task 17 Report — Dialog 模态原子件

**Status:** DONE_WITH_CONCERNS（实现细节与 brief 有两处冲突，详见文末）

## 简述

按 brief 任务 17 实现 Dialog 原子件（portal 到 body + role=dialog + aria-modal + Esc/点遮罩关闭 + 可选 footer）。完整 TDD 流程：先写测试 → 验证 RED → 实现 → 验证 GREEN → 全量套件零回归 → typecheck exit 0 → 提交。

## 实现概要

- `renderer/src/components/ui/Dialog.tsx`（58 行）
- `renderer/src/components/ui/Dialog.test.tsx`（69 行，5 用例）
- Props: `open: boolean` / `onClose: () => void` / `title: string` / `children?: ReactNode` / `footer?: ReactNode` / `width?: number`（默认 480）
- 行为：
  - `open=false` 早返回 null（不渲染 portal）
  - `useEffect` 在 `open=true` 时挂 window `keydown` 监听 → `Escape` 触发 `onClose`；effect cleanup 在 `open`/`onClose` 变化或组件卸载时移除监听
  - effect 末尾 `dialogRef.current?.focus()` —— 焦点落入对话框（tabIndex=-1 可编程聚焦但不进 tab 序）
  - `createPortal` 到 `document.body`，内含兄弟两元素：遮罩（fixed inset-0 z-50 bg-backdrop, onClick=onClose, aria-hidden）+ 对话框（fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50）
- 中文注释：保留了 brief 给的「已知边界（SettingsView 全局 Esc 与本组件 Esc 关闭会同时触发——P1 迁移设置页弹窗时由消费方处理）」

## TDD Evidence

### RED（首跑，预期 FAIL）

```
$ npx pnpm@9.0.0 exec vitest run src/components/ui/Dialog.test.tsx
❯ src/components/ui/Dialog.test.tsx  (0 test)
FAIL  src/components/ui/Dialog.test.tsx
Error: Failed to resolve import "./Dialog" from "src/components/ui/Dialog.test.tsx". Does the file exist?
Test Files  1 failed (1)
Tests  no tests
```

### GREEN（实现后）

```
$ npx pnpm@9.0.0 exec vitest run src/components/ui/Dialog.test.tsx
✓ src/components/ui/Dialog.test.tsx  (5 tests) 57ms
Test Files  1 passed (1)
Tests  5 passed (5)
```

5 用例全过：
1. `open=false 不渲染` ✓
2. `open 渲染 role=dialog + aria-modal + 标题` ✓
3. `Esc 触发 onClose` ✓
4. `点击遮罩触发 onClose；点击内容区不触发` ✓（含 `previousElementSibling` 查询）
5. `footer 渲染在尾部` ✓

## 全量套件

```
$ npx pnpm@9.0.0 --filter momo-studio-renderer test
Test Files  89 passed (89)
Tests  771 passed (771)
Duration  19.52s
```

零回归（89 文件 / 771 测试）。

## Typecheck

```
$ cd renderer && npx pnpm@9.0.0 exec tsc --noEmit
exit: 0
```

## 提交

```
c5c6554 feat(renderer): Dialog 模态原子件——portal + Esc/遮罩关闭 + aria-modal
 2 files changed, 113 insertions(+)
 create mode 100644 renderer/src/components/ui/Dialog.test.tsx
 create mode 100644 renderer/src/components/ui/Dialog.tsx
```

## 自审

| 关注点 | 状态 |
|---|---|
| portal target = document.body | ✓ |
| Esc 监听器在 unmount / `open=false` 时清理（effect cleanup + 早返回 null） | ✓ |
| 焦点落入对话框容器（`tabIndex=-1` + effect 内 focus） | ✓ |
| 中文注释（保留 brief 给的「已知边界」） | ✓ |
| backdrop 与 dialog 为 body 直接子节点（满足 `dlg.parentElement === document.body` 契约） | ✓（见 concerns #1） |
| backdrop 与 dialog 兄弟关系（满足 `dlg.previousElementSibling === backdrop` 契约） | ✓ |

## Concerns（两处 brief 内部不一致，已最小修复）

### #1：brief 的 Dialog.tsx 在 backdrop 与 dialog 之外多包了一层 wrapper `<div className="fixed inset-0 z-50 flex items-center justify-center p-4">`，导致 `dlg.parentElement !== document.body`，让测试 2（portal 到 body 断言）失败。

修复：用 React.Fragment 替换 wrapper div，把 `fixed inset-0 z-50 bg-backdrop` 挪到 backdrop 自己身上，对话框的居中改用 `fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`。视觉与交互等价，DOM 结构满足测试契约。改动只在 JSX 结构，逻辑/Props 类型/中文注释均按 brief。

### #2：brief 的 Props 把 `children: ReactNode` 设为必填，但测试用例 1（`open=false 不渲染`）和测试用例 3（`Esc 触发 onClose`）调用 `<Dialog ... />` 时不带 children，typecheck 报 `TS2741: Property 'children' is missing`。

修复：把 `children: ReactNode` 改为 `children?: ReactNode`。语义合理——某些 dialog 只需要 title/footer，无需 body 内容（例如纯确认框）。无其他影响。

### 选择优先级

Brief 同时要求「verbatim 实现」与「5/5 PASS + typecheck exit 0」。两个要求相互冲突时，按 brief 强制的验证纪律（步骤 3-5）取后者，承认已偏离 verbatim。

## 文件清单

- 新增 `renderer/src/components/ui/Dialog.tsx`（58 行）
- 新增 `renderer/src/components/ui/Dialog.test.tsx`（69 行）

## 后续（P1）

无消费者接入。本任务仅为原子件定义；P1-P3 计划将设置页等 11+ 个手写弹窗迁移到 Dialog。已知边界（SettingsView 全局 Esc 与本组件 Esc 关闭同时触发）由消费方在 keydown 处理中 `stopPropagation` 或改用受控状态优先策略——代码注释已标注。