# Momo Studio UI 设计系统（v2.1）

> 本文档是 renderer UI 开发的**唯一规范入口**。颜色一律用语义 token，图标一律用 lucide-react。
> 完整设计依据：`docs/specs/2026-09-01-v2.1-ui-design-system-refactor-design.md`。
> 机械强制：ESLint `no-restricted-syntax`（裸色号 / inline hex / emoji）+ P4 起 Tailwind `theme.colors` 独占。
> 当前分档：全局 warn（存量 446 处 P1-P3 清零）+ `components/ui/` 与 `lib/task-status.ts` 已 error；P4 起全局 error 并移除 Tailwind 默认色阶。

## 1. 颜色：只用语义 token

颜色值只存在于 `renderer/src/styles/globals.css` 的 CSS 变量（`:root` 明亮 / `.dark` 暗黑），
Tailwind class 经 `renderer/tailwind.config.js` 映射生成。**组件代码禁止出现色号类与 inline 颜色。**

| 语义 | class（bg/text/border 前缀按需） | 用途 |
|---|---|---|
| 画布 | `bg-canvas` | 窗口最底 / 消息主区 |
| 面板 | `bg-surface-1` | 标题栏 / 活动栏 / 侧栏 |
| 卡片 | `bg-surface-2` | 卡片 / 输入框 / 二级容器 |
| 浮层 | `bg-surface-3` | hover / 浮层 / popover |
| 选中 | `bg-surface-active` | 列表选中 / 当前导航（形式二，禁 `/nn`） |
| 选中态文字 | `text-accent-600 dark:text-accent-300` | 选中态统一为 `bg-surface-active` + 本文字色（spec §3.4）；TitleBar 内 tab 激活态（`bg-surface-2 text-primary`，WorkspaceTabs）是独立的「控件激活」类，不属于导航选中态 |
| 文字 | `text-primary / secondary / tertiary / disabled` | 四级文字 |
| 反白 | `text-inverse` | accent 底上的文字 |
| 边框 | `border-subtle / strong / focus` | 分割线 / 强调边 / 焦点边 |
| 强调 | `bg-accent-500`、`text-accent-600 dark:text-accent-300` | 主按钮 / 链接 |
| 状态 | `text-status-success/warning/error/violet` + `bg-status-*-tint` | 徽标 / 状态提示 |
| 遮罩 | `bg-backdrop` | 弹窗遮罩（形式二，禁 `/nn`） |

**`dark:` 前缀使用条件**：仅当明暗差异无法用 CSS 变量表达时（如 accent 文字亮模式用 600、暗模式用 300）。

**状态徽标**：一律 `<Badge tone>` 或 `taskStatusStyle()`（`renderer/src/lib/task-status.ts`），
禁止在任何组件里重造状态色映射。

## 2. 字体 / 字号 / 间距 / 圆角 / 动效

- 字体栈（已内置 Inter Variable，勿另行引入网络字体）：见 globals.css
- 字号：20 页面标题 / 16 区块 / 14 组件标题 / **13 正文** / 12 辅助 / 11 大写标签 / 12.5 等宽
- 间距 4px 网格：4/8/12/16/20/24；行高：会话列表 28、设置项 32
- 圆角：4 chip / 6 按钮输入 / 8 卡片弹窗 / full 头像
- 过渡 `transition-colors`（Tailwind 默认 150ms；如需 140ms 精确值用 duration-[140ms]）；主题切换**无动画**；focus-visible 全局 2px 焦点环（globals.css 已内置）

## 3. 图标（lucide-react）

```tsx
import { Star } from 'lucide-react';
<Star size={16} strokeWidth={1.75} aria-hidden />   // 装饰性
<IconButton aria-label="收藏"><Star size={16} strokeWidth={1.75} /></IconButton>  // 可操作
```

- 命名导入（tree-shaking）；默认 16/1.75，活动栏 20；颜色继承 currentColor
- **禁止**：emoji 作图标、CDN 图标、背景图图标
- 纯图标按钮必须 `aria-label`（IconButton 已在类型层面强制）

## 4. 原子组件优先

新 UI 一律优先用 `renderer/src/components/ui/` 原子件组合，而不是手写样式：

`Button`（primary/secondary/ghost/danger × sm/md/lg）、`Input`、`IconButton`、`Badge`、`Dialog`、
`Avatar`、`Tooltip`、`Spinner`、`EmptyState`、`Segmented`、`Select`、`Checkbox`

外部 className 经 `cn()` 合并（`renderer/src/lib/cn.ts`）。

## 5. Do / Don't

| Do | Don't |
|---|---|
| `className="bg-surface-2 text-secondary"` | `className="bg-neutral-800 text-neutral-400"` |
| `<Badge tone="success">进行中</Badge>` | `<span style={{ color: '#10b981' }}>进行中</span>` |
| `<IconButton aria-label="删除"><Trash2 … /></IconButton>` | `<button>🗑</button>` |
| `taskStatusStyle('failed').className` | 组件内重造 STATUS_COLOR 映射 |
| class 写死在 JSX（静态字符串，经 cn() 组合） | `` className={`bg-${color}-500`} `` 动态拼接 |

**动态拼接 class 禁令的根因**（P0 Task 1 实测结论）：Tailwind 3.4 JIT 只扫描源码中**静态出现**的
class 字面量；运行时拼接的字符串不在扫描结果里，对应 CSS 不会生成——这是 v1.x「任意值 class 失效」
债务的根因。任意值 class（如 `max-w-[70%]`、`text-[13px]`）静态书写时可用。

> README 已知限制中的旧表述将由本规范口径取代（P1 期间勘正 README）。

## 6. Dialog 消费方指引（P1 起生效）

- `onClose` 请传**稳定引用**（useCallback 或模块级函数）——内联箭头函数会因 Dialog 的 effect 依赖在父组件每次渲染时重挂监听并重新抢焦
- Dialog 的 Esc 关闭与 SettingsView 的全局 Esc 返回会**同时触发**：设置页内的弹窗消费方应在自身的 keydown 处理中 `stopPropagation` 或先关弹窗再由状态判定是否返回
- Dialog 不内置焦点陷阱（focus trap）与滚动锁定；多层弹窗叠加时一个 Esc 会关闭所有层（各层独立监听）——需要单层关闭语义时由消费方管理层级
