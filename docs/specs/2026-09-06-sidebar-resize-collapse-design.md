# 统一侧边栏宽度调整与完全收起 — 设计文档

- **日期**：2026-09-06
- **状态**：设计已批准（交互预览会话确认），待实施
- **范围**：renderer 工作区（UI 交互增强，无主进程 / IPC 改动）

## 1. 背景与目标

v2.0 P2 引入的统一侧边栏（`Sidebar.tsx`）展开宽度硬编码 260px，无法调整；收起态为 48px 图标轨且重启后重置。用户要求：

1. 会话 / 文件 / 看板三个视图的侧边栏**统一支持鼠标拖拽调整宽度**（有最小/最大范围钳制）；
2. **收起后侧边栏完全消失**（不再是 48px 图标轨），并提供明确的恢复按钮。

## 2. 非目标

- 不改动 agents / marketplace / settings 视图（本就无侧边栏）
- 不做主区面板（编辑器/消息区）的宽度调整
- 不引入 zustand persist 中间件（沿用项目手写 localStorage 惯例）
- 不做拖拽过程的动画/弹性效果

## 3. 已确认决策（交互预览会话拍板）

| # | 决策 | 备注 |
|---|---|---|
| D1 | 拖拽调宽，clamp **200–480px**，默认 260px | 到边界显示「最小/最大」提示 |
| D2 | 收起 = **完全消失**（组件 return null） | 废弃现有 48px 图标轨形态 |
| D3 | 恢复按钮 = **顶行内联停靠**（预览方案 A） | 作为各视图主区顶行第一个元素参与布局，零遮挡 |
| D4 | 三视图**独立宽度** + localStorage 持久化；`sidebarCollapsed` 一并持久化 | key `ui.sidebar.v1` |
| D5 | 保留 `Ctrl/Cmd+B`；双击分隔条重置该视图默认 260px；活动栏点击当前视图图标恢复 | demo 中验证过的交互全集 |

## 4. 现状（改动基线）

- `renderer/src/components/layout/Sidebar.tsx`：展开 `style={{ width: 260 }}` 硬编码；收起渲染 48px 图标轨（`icon` / `label` / `onToggle` props 服务于此）
- `renderer/src/stores/ui.store.ts`：`sidebarCollapsed: boolean` + `toggleSidebar()`，无持久化
- `renderer/src/components/layout/MainLayout.tsx`：全局 Ctrl/Cmd+B 监听（保留不动）
- `renderer/src/components/layout/ActivityBar.tsx`：`onSelect` 直连 `setActiveView`，点击当前视图为 no-op
- `renderer/src/components/editor/CodeEditor.tsx`：tab 栏为 `flex` 容器（`role="tablist"`），tab 为直接子元素；无 tab 时渲染空态（无顶行）

## 5. 设计

### 5.1 状态模型（`stores/ui.store.ts`）

```ts
/** 有侧边栏的视图（单一真相源，SidebarRestoreButton / ActivityBar 共用） */
export type SidebarViewKey = 'im' | 'files' | 'tasks';
export const SIDEBAR_VIEWS: readonly SidebarViewKey[] = ['im', 'files', 'tasks'];

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 260;

interface UiState {
  // …现有 activeView / sidebarCollapsed / toggleSidebar 不变…
  /** 各视图独立宽度（px），越界值在 setSidebarWidth 内钳制 */
  sidebarWidths: Record<SidebarViewKey, number>;
  setSidebarWidth: (view: SidebarViewKey, width: number) => void;
}
```

**持久化**（手写，跟随 `file.store` 惯例）：

- key：`ui.sidebar.v1`，值 `{ sidebarWidths: Record<SidebarViewKey, number>, sidebarCollapsed: boolean }`
- 读：store 创建时读一次；解析失败 / 字段缺失 / 单项 NaN 或超 `[MIN, MAX]` 范围 → 该项回默认 260；`sidebarCollapsed` 缺失回 `false`
- 写：`toggleSidebar` 与 `setSidebarWidth` 内写（try/catch 静默，写失败不影响内存状态）

### 5.2 组件改动（逐文件）

| 文件 | 改动 |
|---|---|
| `layout/Sidebar.tsx` | 只负责**展开态**：宽度改 props 驱动；顶部新增头部行（§5.5）；右缘新增 4px 拖拽分隔条；收起判定上移到 ViewSidebar。props 调整：移除 `icon` / `onToggle` / `collapsed`，保留 `label`，新增 `width: number`、`onWidthCommit: (width: number) => void`、`onCollapse: () => void` |
| `layout/ViewSidebar.tsx` | `sidebarCollapsed` 为 true 时 `return null`（完全消失）；否则从 store 取 `sidebarWidths[activeView]` 传给 `Sidebar`，`onWidthCommit` 绑定 `setSidebarWidth(activeView, …)` |
| `layout/SidebarRestoreButton.tsx`（新，~30 行） | 收起恢复按钮：`!collapsed \|\| activeView ∉ SIDEBAR_VIEWS` 时 return null；否则渲染 28×28 icon-btn（lucide `PanelLeftOpen`，size 16 / strokeWidth 1.75），`aria-label="展开侧边栏"`，`title="展开侧边栏（Ctrl/Cmd+B）"`，点击 `toggleSidebar()`。自读 store，无 props |
| `editor/CodeEditor.tsx` | `<SidebarRestoreButton />` 插入 tab 栏（`role="tablist"` flex 容器）**第一个子元素**位；`tabs.length === 0` 空态分支补一个顶行（同 tab 行高度、`border-b border-subtle`）容纳按钮 |
| `layout/MiddlePanel.tsx` | im 分支会话头部行（「会话名 + 工具上限徽标 + 导出」那行）**首位**插入 `<SidebarRestoreButton />` |
| `task-board/TaskBoardView.tsx` | 顶部状态栏行（「任务看板 + 并发」）**首位**插入 `<SidebarRestoreButton />` |
| `layout/ActivityBar.tsx` | `onSelect` 包一层：点击**当前视图**且 `sidebarCollapsed` 且该视图 ∈ `SIDEBAR_VIEWS` → `toggleSidebar()`（恢复）；否则 `setActiveView(view)` |
| `layout/MainLayout.tsx` | 无改动 |

### 5.3 拖拽交互（`Sidebar.tsx` 内实现）

- **分隔条**：4px 宽、`cursor: col-resize`、`touch-action: none`；默认 `bg-subtle`，hover / 拖拽中 `bg-accent-500`
- **拖拽**（Pointer Events + `setPointerCapture`）：
  - `pointerdown`：记录起点，capture，进入拖拽（外层 `user-select: none` 防误选文本；capture 已保证后续事件全部路由到分隔条，无需屏蔽主区）
  - `pointermove`：**本地 state** 驱动预览宽度（clamp 到 `[200, 480]`）——拖拽过程不写 store / localStorage
  - `pointerup` / `pointercancel`：一次性 `onWidthCommit(预览宽度)` 提交 store 并持久化，退出拖拽
- **宽度角标**：拖拽中于分隔条上方显示当前宽度（如 `312 px`；触界时 `200 px · 最小` / `480 px · 最大`），`bg-surface-3` + `border-accent-500`，松手淡出
- **双击分隔条**：`onWidthCommit(260)` 重置当前视图
- 收起状态下分隔条随 Sidebar 一并卸载（无拖拽入口）

### 5.4 视觉规格（v2.1 设计系统合规）

- 全部语义 token：`bg-surface-1/2/3`、`border-subtle`、`bg-accent-500`、`text-tertiary` / `hover:text-primary` 等，禁裸色阶
- 图标一律 lucide-react：恢复按钮 `PanelLeftOpen`、收起按钮 `PanelLeftClose`（Sidebar 头部，随本改造一并补上——见 §5.5）
- 恢复按钮 28×28（`h-7 w-7`）、圆角、hover `bg-surface-3`

### 5.5 收起入口（展开态的 Sidebar 头部）

现有展开态无可见收起按钮（仅快捷键），且侧边栏内容直接顶到上沿、无标题行。本设计在 Sidebar 顶部**新增 36px 头部行**（`border-b border-subtle`，三视图统一）：左侧视图标题（`VIEW_META` 既有 label），右侧 `PanelLeftClose` 收起按钮（28×28 icon-btn，`aria-label="收起侧边栏"`，`title="收起侧边栏（Ctrl/Cmd+B）"`，点击 `onCollapse()`）。该头部行在交互预览 v1/v2 中已随整体方案确认。

## 6. 边界与错误处理

| 场景 | 行为 |
|---|---|
| localStorage 值缺失 / JSON 解析失败 / 单项 NaN 或超范围 | 该视图宽度回默认 260；`sidebarCollapsed` 回 false |
| `pointercancel`（指针捕获丢失） | 与 `pointerup` 同路径：提交当前预览宽度 |
| 拖拽中视图切换 / Ctrl+B 收起 | Sidebar 卸载 → pointer capture 自动释放、预览丢弃不提交（宽度保持拖拽前值），可接受 |
| 文件视图无打开 tab（空态） | 恢复按钮渲染于空态上方顶行（§5.2 CodeEditor 行） |
| agents / marketplace / settings 视图 | ViewSidebar 本就 return null；恢复按钮也 return null（`SIDEBAR_VIEWS` 判定），互不影响 |
| 主区重排 | 侧边栏 `shrink-0` + 主区 `flex-1` 现有结构天然支持，tab 行不错位 |

## 7. 测试策略（renderer 贴源 colocated）

| 文件 | 覆盖 |
|---|---|
| `src/stores/ui.store.test.ts`（无则新建） | clamp 边界（199/200/480/481）、持久化 round-trip、localStorage 非法值回默认、`sidebarCollapsed` 持久化、写失败静默 |
| `src/components/layout/Sidebar.test.tsx`（新建，现无覆盖） | 真实 `pointerdown/move/up` 事件序列拖拽改宽并提交；拖拽中不触发 `onWidthCommit`、仅 up 后触发一次；双击重置 260；越界钳制；收起时组件卸载由 ViewSidebar 负责 |
| `src/components/layout/SidebarRestoreButton.test.tsx`（新建） | 收起 + 三侧边栏视图 → 渲染且点击调用 `toggleSidebar`；未收起 / 非侧边栏视图 → return null |
| `src/components/layout/ViewSidebar.test.tsx`（既有，更新） | 48px 折叠轨断言改为「收起时不渲染侧边栏」；宽度从 store 透传 |
| `src/components/layout/ActivityBar.test.tsx`（无则新建） | 收起时点击当前视图 → 恢复；点击其它视图 → 正常切换 |

Mock 规范遵循 `momo-test-rules`：store 用真实 zustand store 或完整 state 替换，不做「方便测试」的接口简化；pointer 事件用真实 DOM 事件（`pointerdown` 等需 jsdom 支持，若不支持则用 `MouseEvent` 构造 + `PointerEvent` polyfill 判定，实现时以测试实际跑通为准）。

## 8. 验收标准

1. 会话 / 文件 / 看板侧边栏均可拖拽调宽，范围 200–480px，越界钳制并提示；双击重置 260px
2. `Ctrl/Cmd+B` 或 Sidebar 头部按钮收起后，侧边栏**完全消失**，主区占满全宽
3. 收起后当前视图主区顶行首位出现恢复按钮（文件视图含空态），点击恢复且宽度回到收起前
4. 收起时点击活动栏当前视图图标可恢复
5. 各视图宽度独立、重启后保持；收起状态重启后保持
6. 文件视图下 tab 不被恢复按钮遮挡（按钮参与顶行 flex 布局）
7. `npx pnpm@9.0.0 typecheck` 双 clean；`--filter momo-studio-renderer test` 全绿
