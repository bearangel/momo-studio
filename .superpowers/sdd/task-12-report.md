# Task 12 报告：Avatar 原子件

**Status:** DONE | Branch: `main` | Date: 2026-09-01

## 概览

实现 v2.1 UI 设计系统 P0 计划的第 12 个原子件——`Avatar`。名称首字母头像 + 名称哈希色相派生（同名恒定，异名尽量分散）；`bot=true` 切换为 lucide `Bot` 图标变体；尺寸支持 `sm`(20px) / `md`(28px)。遵循「先 RED 后 GREEN」TDD 流程，按 brief 代码逐字落地。

## 提交

- `eb1d410` feat(renderer): Avatar 原子件——名称色相派生 + Bot 变体
  - 新增 `renderer/src/components/ui/Avatar.tsx`（49 行）
  - 新增 `renderer/src/components/ui/Avatar.test.tsx`（40 行）

## TDD 证据

### RED

未实现 `Avatar.tsx` 时运行 `vitest run src/components/ui/Avatar.test.tsx`：

```
FAIL  src/components/ui/Avatar.test.tsx [ src/components/ui/Avatar.test.tsx ]
Error: Failed to resolve import "./Avatar" from "src/components/ui/Avatar.test.tsx". Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

导入失败 → 套件级失败，0 测试可收集。符合预期。

### GREEN

实现 `Avatar.tsx` 后运行同命令：

```
✓ src/components/ui/Avatar.test.tsx  (4 tests) 28ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

四个 case 全绿：
1. 渲染大写首字母 + `title` 提示 + `rounded-full` 类
2. 同名 `alice` 两次渲染 → `style.backgroundColor` 完全相等（确定性色相）
3. `bot=true` 渲染 `<svg>`（Bot 图标），`textContent` 为空字符串
4. `size="sm"` 时 `width` / `height` 都为 `20px`

## 验证门

| 检查 | 命令 | 结果 |
|---|---|---|
| Avatar 单测 | `vitest run src/components/ui/Avatar.test.tsx` | **4/4 PASS** |
| Renderer 全套 | `cd renderer && npx pnpm@9.0.0 test` | **756/756 PASS**（+4 新增，零回归） |
| Renderer typecheck | `cd renderer && npx pnpm@9.0.0 exec tsc --noEmit` | **exit 0** |

## 自审（brief §7 要求）

- **`nameHue` 确定性**——`(h * 31 + codePointAt(0)) % 360` 是纯函数；同名两次调用必得相同整数。测试 2 直接以 `style.backgroundColor` 字符串相等验证。
- **Bot 变体无首字母**——`if (bot)` 分支提前 return，不进入 `name.slice(0, 1).toUpperCase()` 渲染路径；只输出 `<Bot />` svg。测试 3 验证 `textContent === ''`。
- **中文注释**——顶部文件级注释 + `nameHue` 函数 docstring + `Props.bot` 字段注释均为中文。
- **`hsl(...)` 动态值例外**——文件头注释明确说明「动态值，非硬编码 hex——lint 白名单语义见 design-system.md」，与 brief 注释一致。
- **可访问性**——非交互装饰元素用 `aria-hidden`；`title={name}` 提供悬停提示（hover tooltip，无障碍读屏不重复读出）。

## 文件清单

```
renderer/src/components/ui/Avatar.tsx       新增  49 行
renderer/src/components/ui/Avatar.test.tsx  新增  40 行
```

## 范围

未触及任何其它文件。`renderer/src/components/ui/` 当前目录：`Badge`、`Button`、`IconButton`、`Input`、`Segmented`、`Spinner`、`Avatar`（本次新增），共 7 个原子件。

## 关注点

无。