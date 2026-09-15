# Momo Studio UI 设计系统（v2.1）

> 本文档是 renderer UI 开发的**唯一规范入口**。颜色一律用语义 token，图标一律用 lucide-react。
> 完整设计依据：`docs/specs/2026-09-01-v2.1-ui-design-system-refactor-design.md`。
> 机械强制（**P4 已生效**，2026-09 收官）：ESLint `no-restricted-syntax` 全局 `error`
> （裸色号 / inline hex / emoji，renderer/src 全覆盖）+ Tailwind `theme.colors` 独占
> （默认色阶已物理移除——裸色号类在编译层不再生成 CSS）。分档过渡期（全局 warn）已结束。

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

> README 已知限制中的旧表述已按本规范口径勘正（P1 完成）。

## 6. Dialog 消费方指引（P1 起生效）

- P1 起 Dialog 已**原子件级防抢焦**（内部已持焦时不抢）+ Esc capture 阻断双触发；`onClose` 传**稳定引用**（useCallback）仍是推荐写法，但不再是硬性要求
- Dialog 的 Esc 关闭与 SettingsView 的全局 Esc 返回会**同时触发**：设置页内的弹窗消费方应在自身的 keydown 处理中 `stopPropagation` 或先关弹窗再由状态判定是否返回
- Dialog 不内置焦点陷阱（focus trap）与滚动锁定；多层弹窗叠加时，Esc 由**最外层（最先注册 capture 监听）**的弹窗响应并阻断其余层——逐层关闭自外向内；消费方无需自行管理 Esc 层级

## 7. P4 机制生效（v2.1 收官，2026-09）

三层机械强制全部落地，规范从「约定 + 渐进分档」转为「编译 / Lint / e2e 三重封锁」：

- **Tailwind `theme.colors` 独占**（`renderer/tailwind.config.js`）：语义 token 完全替换默认色阶
  （`transparent` / `current` 显式保留、`inverse: '#ffffff'` 为字面 token）——裸色号类
  （`bg-gray-800` / `text-neutral-400` 等）自此在**编译层不生成任何 CSS**（物理灭绝，非仅 Lint 约束）。
  防回潮锁：`renderer/src/styles/tokens.test.ts` 断言 config 无 `extend` 且无 deprecated 键。
- **ESLint 全局 error**（根目录 `eslint.config.mjs`）：三条 `no-restricted-syntax`（标准色阶类 /
  inline 硬编码颜色 / emoji）对 `renderer/src/**` 全覆盖 `error`，`ui/` 专属子块已删；
  任意 src 路径触发裸色阶类 → eslint exit 1（stdin 探针反向验证，P4 Task 3）。
- **双主题启动 e2e 基线**（`tests/e2e/theme.spec.ts`，构建产物 + xvfb 运行）：
  (a) 默认浅色启动——无存储值 + 系统 light → `<html>` 无 `.dark`、body 计算背景 `rgb(255,255,255)`；
  (b) `localStorage['momo.theme']='dark'` 持久化深色启动——`<html class="dark">`、body 背景 `rgb(8,9,10)`
  （colorScheme 固定 light，同时锁「存储值优先于系统偏好」）。运行时切换语义由
  `renderer/src/stores/theme.store.test.ts` 单测锁定（page.evaluate 直调 store 脆弱、设置页点击路径
  过深，PRAGMATIC 裁定不进 e2e）。⚠️ e2e 写 localStorage 必须用 `--user-data-dir` 隔离 Chromium
  profile——`AP_USER_DATA_DIR` 只路由应用级路径（state.db / logs / skills），不含 Local Storage。
- **Esc capture 语义**（P2 终审 sweep 后已修；消费方指引见 §6）：`components/ui/Dialog.tsx` 在
  capture 阶段拦截 Esc 并阻断同窗口其余 Esc 监听（如 SettingsView 全局返回）——弹窗内 Esc 只关弹窗；
  多层弹窗自外向内逐层关闭。回归锁：`ui/Dialog.test.tsx`「Esc 只关弹窗」。

## 8. Agent 工具调用授权/确认提示——两级提示规则（2026-09-15 起生效）

**用户裁定**：所有「agent 工具调用需要用户授权或确认」的提示，交互必须统一，且阻断类必须居中弹出（右下角用户不会留意到）。设计全文与决策依据：`docs/specs/2026-09-15-unified-notice-tiers-design.md`。

**分级判定（唯一标准：提示出现时 agent 是否停摆等用户决定）**：

| 级 | 判定 | 形态 | 载体 |
|---|---|---|---|
| **Tier A 阻断确认** | agent 已停等（工具挂起/驻留，有超时兜底） | **居中对话框**：强决策类带遮罩且**点击遮罩不消散**（如浏览器信任授权）；等待类无遮罩不剥夺输入（如接管释放等待） | `notices/CenterPromptLayer`（z-50，与 Dialog 同层） |
| **Tier B 告知** | 不阻断，错过无碍 | 右下角 toast 堆叠（6s 自动消散，上限 4） | `notices/NoticeStack`（z-40） |

**硬性规则（新增提示必须遵守）**：

1. **禁止新增 `fixed right-4 bottom-4` 类裸窗口坐标提示卡**——一律挂入 CenterPromptLayer（阻断类）或 NoticeStack（告知类）。历史教训：原生 WebContentsView（浏览器侧栏）在 OS 合成层盖住一切 renderer DOM（z-index 无效），裸坐标卡落入侧栏 rect 即被盖死（两次实测翻车：拖拽手柄、释放提示卡）；且四卡同锚并发互盖。
2. **定位一律经安全区**：`useSafeArea()`（`stores/browser-sidebar-rect.store.ts`）——窗口减浏览器侧栏 rect，动态避让原生视图。
3. **遮罩实现逐字复用 `ui/Dialog.tsx`**（`fixed inset-0 z-50 bg-backdrop`），有字节级契约测试锁；阻断卡自带 transform 居中（`absolute` + `-translate-x/y-1/2`），**锚点/祖先禁止 transform**（transform 祖先会成为 fixed 后代的 containing block，遮罩会缩成卡区大小——jsdom 测不出，真机必炸）。
4. **`browser:notice` 新 kind 默认落 NoticeStack**（前向兼容，零 renderer 改动可见）；授权/等待类 kind 归 Tier A——路由表单点常量在 `NoticeStack.tsx`（INFO_KINDS），同 kind 禁止双渲染。
5. **决策必须显式**：Tier A 授权卡不吃「点击外部 = 取消」——用户要么选按钮要么等超时；取消也是显式决定。

现有 Tier A 消费方：`BrowserTrustNotice`（信任授权，带遮罩）、`BrowserWaitReleasePrompt`（接管释放等待，无遮罩）。回归锁：`NoticeStack.test.tsx`（路由/上限/消散/避让数值）、`CenterPromptLayer.test.tsx`（居中锚/无 transform 结构锁）、`BrowserSidebar.test.tsx`（安全区生产者三锁）。
