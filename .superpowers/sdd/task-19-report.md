# Task 19 Report: ESLint 机械约束框架

**Status: DONE**（有一处计划外但必要的存量修复，见「偏差」节）

## 实现内容

`/workspace/eslint.config.mjs`（根 flat config）按 brief 逐字插入：

1. **`const UI_RESTRICTED_SYNTAX`**（模块顶层，imports 之后）——三条 `no-restricted-syntax` 选择器：
   - `JSXAttribute[name.name='className'] Literal[...]` 禁标准 Tailwind 色阶类（22 色系 × 50-950 色阶，前缀 text/bg/border/ring/divide/placeholder/from/to）
   - `JSXAttribute[name.name='style'] Literal[...]` 禁 inline hex（`#rrggbb` 3-8 位）/ `rgb(`/`rgba(` 颜色
   - `JSXText[value=/\p{Extended_Pictographic}/u]` 禁 JSX 文本 emoji
2. **全局 warn 块**——`files: ['renderer/src/**/*.{ts,tsx}']`，`no-restricted-syntax: ['warn', ...]`
3. **新代码 error 块**——`files: ['renderer/src/components/ui/**/*.tsx', 'renderer/src/lib/task-status.ts']`，`no-restricted-syntax: ['error', ...]`

位置：react-hooks 块之后、ignores 块之前。brief 的 snippet 中 `const` 是语句不能进函数实参列表，故置于模块顶层（brief 的 `// ... 既有块 ...` 占位即此结构）——这是唯一语法可行的解读。

另修复 `renderer/src/components/ui/Checkbox.tsx`（见偏差节）。

## Lint 门禁（Step 2）

```
npx pnpm@9.0.0 --filter momo-studio-renderer lint
→ EXIT_CODE=0
→ ✖ 446 problems (0 errors, 446 warnings)
```

446 条 warning 全部来自新规则命中存量（`text-neutral-*` / inline hex / emoji，遍布 im/layout/settings/task-board/resource-library/p2p 等域）——符合预期，P1-P3 逐域清零。0 error = ui/ 12 原子件 + task-status.ts 全部 token 化。

**首跑曾出现 1 个 error**：`ui/Checkbox.tsx:11 'className' is defined but never used`（`@typescript-eslint/no-unused-vars`，**非新规则命中**，系 Task 6 落地 Checkbox 时遗留、上一个任务未跑 lint 的存量错误）。

## 反向验证（Step 3）

用 stdin 探针（非文件型）；关键环境细节：**必须以 /workspace 为 cwd**——以 renderer/ 为 cwd 时 `-c` 指定 config 的相对 `files` glob 按 cwd 解析导致不命中（先用无 files 限制的 base 规则 Diag 定位了这一点）。ESLint 9 用 `--no-config-lookup` 取代 brief 的 `--no-eslintrc`（任务上下文已预告）。eslint v9.39.5。

| 探针 | 内容 | 虚拟路径 | 结果 |
|---|---|---|---|
| A（brief 原样） | `className="text-neutral-500"` | `.../components/ui/probe.tsx` | **1 error**（色阶类），exit 1 ✅ |
| B | 色阶 + `#ff0000` + ✅emoji | `.../components/ui/probe.tsx` | **3 errors**（三规则全命中），exit 1 ✅ |
| C（对照） | 色阶类 | `renderer/src/foo.tsx`（非 ui） | **1 warning**，exit 0 ✅（warn/error 分层正确） |
| D（阴性对照） | `bg-surface-1 text-secondary border-subtle` + `hsl(...)` | `.../components/ui/probe.tsx` | **0 problems**，exit 0 ✅（语义 token 与 Avatar hsl 例外不误报） |

代表性输出（Probe B）：

```
/workspace/renderer/src/components/ui/probe.tsx
  2:18  error  禁止标准 Tailwind 色阶类：使用语义 token（...）  no-restricted-syntax
  2:53  error  禁止 inline style 硬编码颜色：...（Avatar 的 hsl 动态派生为例外）  no-restricted-syntax
  2:66  error  禁止 JSX 文本中的 emoji 图标：使用 lucide-react 线条图标  no-restricted-syntax
```

探针全程 stdin，未在 repo 创建任何文件；/tmp 临时日志已删。

## 回归验证（Step 4）

- renderer 全套：**90 test files / 774 tests 全绿**，exit 0（含 Checkbox.test.tsx 3 例）
- renderer typecheck（tsc --noEmit）：exit 0
- LSP diagnostics（Checkbox.tsx）：无诊断

## Commits

- `09f3c85` fix(ui): Checkbox 接通消费方 className 透传（修复遗留 no-unused-vars error）
- `82a879b` feat(lint): 设计系统机械约束——禁裸色号/inline hex/emoji（全局 warn + ui/ error）（brief 原文 message；仅 eslint.config.mjs，36 行插入）

Checkbox 修复先行提交，保证每个 commit 上 lint 门禁都是绿的（存量错误先修、新规则后上）。

## 偏差与说明

1. **Checkbox.tsx 计划外修复**（brief Step 2 授权：「若出现 error：定位到 ui/ 内违规文件修复后重跑」）。该 error 是存量 no-unused-vars（非本次规则命中），且 Task 6 已 landed——即 HEAD 上 lint 本就红。修法按原子件家族既有模式（Button/Input/Select/IconButton/Badge/Segmented 均如此）：destructure 的 `className` 经 `cn()` 合并到 input 元素，而非改名 `_className` 丢弃——静默丢弃消费方 className 本就是原子件 API 缺陷，接通是更正确的修复。
2. **stdin 探针 cwd 细节**：brief 的命令在 renderer/ cwd 下 glob 不命中（诊断过程见上）；等效调整为 cwd=/workspace。已按任务要求报告所用形式：**stdin 型，`--no-config-lookup` + cwd=/workspace**。
3. `.superpowers/sdd/` 下其他任务报告的既有未提交修改未触碰。

## 自审（Step 6）

- **规则顺序**：warn 块在 error 块之前；flat config 同名规则后块覆盖前块 → ui/ + task-status.ts 得 error、其余 renderer 得 warn。Probe A/B（ui/=error）与 Probe C（非 ui=warning, exit 0）实证了这一分层 ✅
- **色阶正则**：`\b(前缀)-(色系)-(50…950)\b`——前导 `\b` 使 `hover:bg-red-500` / `placeholder:text-neutral-400` / `dark:text-gray-300` 等变体前缀同样命中（`:` 为非词字符）；尾随 `\b` 使 `bg-red-500/80` 透明度变体命中；`text-secondary` / `bg-surface-1` / `border-strong` / `bg-status-error` / `text-[13px]` 均不含「色系+色阶」组合不误报（Probe D + ui/ 0 error 实证）✅
- **emoji 属性转义**：`/\p{Extended_Pictographic}/u` 在 esquery 属性选择器中合法（esquery 把 flags 透传给 RegExp 构造）；Extended_Pictographic 不含 CJK 表意文字——存量大量中文 JSX 文本（About/Settings 等域）只报色阶类不报 emoji，实证不误报中文 ✅
- **verbatim 校对**：选择器串、message、files glob、severity 数组与 brief 逐字符一致；插入位置 react-hooks 后、ignores 前 ✅
- **无规则削弱**：三条规则原样落地，未做任何软化 ✅

## 顾虑

无阻塞性顾虑。供 P4 参考的两个已知边界（规则设计使然，非缺陷）：inline style 规则不拦 `hsl()`（brief 明示 Avatar 动态派生例外）；emoji 规则基于 Extended_Pictographic，理论上极少数符号字形（如 `©`）不在该属性内不会命中——与设计意图一致。
