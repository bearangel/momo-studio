# Task 13 — Tooltip 原子件报告

## 实现内容

新增 `renderer/src/components/ui/Tooltip.tsx` 与 `renderer/src/components/ui/Tooltip.test.tsx`（brief verbatim）。组件特性：

- CSS group-hover / group-focus-within 机制实现可见性切换，无定位库（floating-ui 等）依赖
- 默认隐藏（`opacity-0 transition-opacity`），`group-hover:opacity-100 group-focus-within:opacity-100` 触发态
- `side?: 'top' | 'bottom'` 变体（默认 top，`bottom-full mb-1.5` vs `top-full mt-1.5`）
- `role="tooltip"` 语义（符合 WAI-ARIA tooltip 模式）
- 包裹元素为 `<span className="group relative inline-flex">`——`relative` 提供定位上下文，`inline-flex` 让包裹尺寸与触发子元素一致
- `pointer-events-none` 保证提示层不抢焦点
- 视觉与现有原子件（Button/IconButton/Avatar）一致：`border border-subtle bg-surface-3 text-primary` + Tailwind 默认 `shadow-lg`（独立调色板，按 brief 允许）

## TDD 证据

### RED

```
RUN  v1.6.1 /workspace/renderer
❯ src/components/ui/Tooltip.test.tsx  (0 test)
FAIL  src/components/ui/Tooltip.test.tsx
Error: Failed to resolve import "./Tooltip" from "src/components/ui/Tooltip.test.tsx". Does the file exist?
Test Files  1 failed (1)
     Tests  no tests
```

模块未实现 → 导入解析失败 → 0 个用例被执行 → 符合 RED 预期。

### GREEN

```
RUN  v1.6.1 /workspace/renderer
✓ src/components/ui/Tooltip.test.tsx  (3 tests) 44ms
Test Files  1 passed (1)
     Tests  3 passed (3)
```

3/3 PASS：role=tooltip 文本与触发子元素、opacity-0 + group-hover:opacity-100、side=bottom 切换为 top-full 定位类。

## 套件 + 类型检查结果

- `pnpm --filter momo-studio-renderer test`：**Test Files 85 passed (85); Tests 759 passed (759)**（Tooltip 3/3 包含；零回归）
- `cd renderer && pnpm exec tsc --noEmit`：**EXIT=0**

## 提交

- `cfb7356 feat(renderer): Tooltip 原子件——CSS group 机制 + focus-within 可访问`（2 files changed, 65 insertions）

## 变更文件

- 新增 `renderer/src/components/ui/Tooltip.tsx`（27 行，含中文文件头注释）
- 新增 `renderer/src/components/ui/Tooltip.test.tsx`（38 行）

## 自审

- **role=tooltip 语义**：tooltip `<span>` 标 `role="tooltip"`，符合 WAI-ARIA tooltip pattern；测试通过 `screen.getByRole('tooltip')` 验证
- **group 机制 class**：包裹元素 `group relative inline-flex`（`group` 是关键，缺失会导致 `group-hover` / `group-focus-within` 无效）；提示层同时声明 `group-hover:opacity-100 group-focus-within:opacity-100`——两条触发路径（鼠标 hover + 键盘 focus-within）均覆盖
- **side 变体 class**：top → `bottom-full mb-1.5`；bottom → `top-full mt-1.5`；测试断言 side=bottom 时包含 `top-full`（GREEN 验证 class 切换）
- **中文注释**：文件头注释「轻量悬浮提示：CSS group 机制实现（无定位库依赖），hover 与键盘 focus 均可触发。」——说明实现机制 + 可访问性意图
- **shadow-lg**：Tailwind 默认 shadow utility，独立于颜色调色板，按 brief 明示允许
- **`pointer-events-none`**：提示层不抢鼠标事件，避免遮挡触发子元素
- **`absolute` 定位**配合父 `relative` 上下文：未指定 width，由 `whitespace-nowrap` 决定宽度；测试未断言宽度属合理
- **API 完整性**：`content: string`（必填）、`side?: 'top' | 'bottom'`（默认 top）、`children: ReactNode`——满足 brief 接口定义

## 关注点

- Tooltip 当前未暴露 `delay`（hover 立即出现/消失）。若后续对触摸设备友好需考虑，需要 `@media (hover: hover)` 守卫或 click 触发——本次 brief 未要求，留作未来 PR
- 包裹元素为 `<span>`——若触发子元素是块级元素（如 `<div>`），`<span>` 包裹将产生 HTML 校验告警。当前测试覆盖的是 `<button>` 与 `<span>` 触发器，未涉及块级触发器场景；同样按 brief 未要求范围扩展
