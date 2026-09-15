# 提示交互分级统一设计（阻断类居中 / 告知类堆叠 + 安全区避让）

- 日期：2026-09-15
- 状态：待评审
- 范围：纯 renderer（新容器组件 + 六张卡迁移 + 死信补渲染）；主进程 notice 生产者零改动
- 上游讨论：2026-09-14/15 浏览器接管优雅等待及遮挡修复（docs/specs/2026-09-14-browser-takeover-graceful-wait-design.md §4.3）；用户裁定：交互统一 + 阻断类提示需居中

## 1. 背景与问题

### 1.1 现状盘点（2026-09-15 核实）

| 提示 | 现位置 | 类型 | 问题 |
|---|---|---|---|
| 浏览器信任卡 | `fixed` 右下角 | **阻断**（agent 停等授权 3min） | 右下角太安静，易错过；与释放提示位置形态不一致 |
| 浏览器释放条幅 | 侧栏 chrome 列内 | **阻断**（agent 驻留 120s） | 与信任卡形态不一致（用户反馈的直接起因） |
| 沙箱首启 / 升级迁移 / 任务恢复卡 | `fixed` 右下角 | 告知 | 四卡同锚 `right-4 bottom-4` **并发互盖**（终审备案 M1 旧债） |
| crash 重载 / popup 拦截 / 导航失败 | **无消费者（死信）** | 告知 | 主进程在推 `browser:notice`，renderer 无人渲染 |

### 1.2 结构性约束（已两次踩坑）

原生 `WebContentsView`（浏览器侧栏）按占位区 rect 在 **OS 合成层高于一切 renderer DOM**（z-index 无效；先例：拖拽手柄 bug 1、释放卡遮挡 bug）。右下角 / 窗口居中等任何「按窗口裸坐标定位」的提示都可能落进侧栏 rect 被盖死——**新体系必须按「安全区」定位**。

## 2. 目标 / 非目标

**目标**
1. 交互统一：同类提示同形态、同层级语义（用户裁定方向）。
2. 阻断性确认**居中显示**（注意力与阻断性匹配）；告知性提示右下堆叠不打扰。
3. 安全区定位：所有提示锚点动态避让浏览器侧栏 rect，构造上不可被原生视图遮挡。
4. 清债：四卡同位叠放、三个死信 kind 一并解决。

**非目标**
- 不动主进程 notice 生产者与 `browser:notice` 契约（kind 集合不变）。
- 不做 OS 级系统通知（窗口失焦 escalate 仍在路线图）。
- 不引入新状态管理库；不改侧栏常驻接管徽标（状态指示器不是提示）。

## 3. 设计总览

```
安全区（SafeArea）= 窗口可视区 − 浏览器侧栏 rect（仅 im 视图且展开时存在）
   ├─ Tier A · CenterPromptLayer：安全区几何居中，阻断性确认卡
   │     · 信任授权卡（轻遮罩，显式三选一，不点外部不消散）
   │     · 释放等待卡（无遮罩，不剥夺用户输入——此刻用户可能在用浏览器）
   └─ Tier B · NoticeStack：安全区右下角，垂直堆叠（新者在上），告知性
        · 死信补渲染：crash-reloaded / popup-blocked / navigation-error → 自动消散 toast
        · 迁入：沙箱首启 / 升级迁移 / 任务恢复（保留各自自管显隐逻辑）
```

## 4. 详细设计

### 4.1 安全区（renderer 侧单一真相源）

- 新建轻量 store `renderer/src/stores/browser-sidebar-rect.store.ts`（zustand，仓库既有模式）：`{ rect: DOMRect | null }`。
- **写入点**：`BrowserSidebar` 既有 ResizeObserver 回调（它已在为 `setSidebarBounds` 做 getBoundingClientRect）顺带写 store——零新增观察者；侧栏卸载/折叠时写 `null`（折叠仅 40px 竖条，不构成遮挡，视同无侧栏）。
- **消费点**：SafeArea 推导 hook `useSafeArea()`：`rect == null` → 全窗口；否则返回 `{ left: 0, top: 0, right: rect.x, bottom: innerHeight }`（浏览器侧栏右停靠，安全区即其左侧区域）。
- 防遮挡原理：Tier A/B 容器均以此区域定位（居中 / 右下），永不与侧栏 rect 相交——与「手柄移出 rect」「条幅入 chrome 列」同类的构造性解法，但一次覆盖全部提示。

### 4.2 Tier A · CenterPromptLayer

- 新组件 `renderer/src/components/notices/CenterPromptLayer.tsx`：固定层（`fixed inset-0 z-50 pointer-events-none`），内部按 `useSafeArea()` 计算居中锚点渲染子卡（卡自身 `pointer-events-auto`）。
- **信任授权卡迁移**（BrowserTrustNotice → 居中 + 轻遮罩）：
  - 遮罩：`fixed inset-0` 半透明层（设计系统语义色 + 透明度修饰符实现，实现时对照 ResumeNotice/SandboxNotice 既有先例）；**点击遮罩不消散**（决策必须显式——超时兜底已存在）；Esc 不关闭（同理）。
  - 三按钮（本次会话允许 / 永久允许 / 取消）与失败错误行、busy 逻辑逐字保留（既有测试只改容器断言）。
- **释放等待卡迁移**（BrowserWaitReleaseBanner → BrowserWaitReleasePrompt，居中无遮罩）：
  - 逻辑逐字保留（kind 过滤 / durationMs 兜底计时 / state 卸载 / 失败错误行 / busy 防抖）；渲染形态回到卡式（标题 + 说明 + 释放并继续按钮）。
  - **移除侧栏内挂载**（BrowserSidebar 还原）；侧栏测试的 onBrowserState 订阅计数断言回退为 1（该文件 2026-09-15 改 2 的注释一并回退）。
- 并发（理论不同现，防御）：多张 Tier A 卡垂直排列居中。

### 4.3 Tier B · NoticeStack

- 新组件 `renderer/src/components/notices/NoticeStack.tsx`：按 `useSafeArea()` 右下锚定（`fixed` 定位值由安全区动态计算——style left/top 数值，非 Tailwind 任意值 class），纵向堆叠、最大可见数 4（超出时最旧条目隐藏，堆叠顶部显示「+N 条更早」计数行；条目本身 6s 自动消散，积压有限），条目间距 8px。
- **死信补渲染**：NoticeStack 订阅 `browser:notice`，消费 `crash-reloaded | popup-blocked | navigation-error` 三 kind → 文本 toast（信息图标 + text + 手动关闭 ×），**6 秒自动消散**（悬浮暂停计时可选，首版不做）。
- **kind 路由表（契约注记）**：`trust-request` → Tier A 信任卡；`agent-waiting-release` → Tier A 释放卡；上述三 kind → NoticeStack；未来新 kind 默认进 NoticeStack（前向兼容，主进程加 kind 零 renderer 改动即可见）。路由表以常量单点定义。
- **既有三卡迁入**（Sandbox / Upgrade / Resume）：改为 NoticeStack 的条目形态（去 `fixed` 定位、由容器锚定），各自显隐逻辑、IPC、行为锁逐字不动；App.tsx 挂载点收敛为 `<CenterPromptLayer />` + `<NoticeStack>`（含三卡条目）。

### 4.4 层级与视觉

- z 序：Tier A 遮罩（信任）> Tier A 卡 > Tier B 堆叠 > 页面内容；同层多卡按渲染序。z-index 具体数值以仓库既有最高层级对话框（ConflictDialog / ConflictDialogMount）的既有约定为基准上浮一档，实现时对齐——不发明独立体系。
- 视觉遵循 v2.1 设计系统：语义 token、lucide 16/1.75、ui 原子组件；居中卡与堆叠条目形态对齐既有信任卡（圆角卡、surface 底、subtle 边）。
- 动效：首版仅淡入（既有卡有则保留），不做弹跳。

## 5. 契约影响评估（boundary-rules 自查）

- **零跨进程契约变更**：`browser:notice` kind 集合、载荷、生产者均不动；本次纯 renderer 消费侧重组。
- **kind 路由表**是 renderer 内部单点常量（新增消费者 NoticeStack 与既有两卡在同一 PR 成对，路由注释写明每 kind 的唯一渲染归属，防双渲染）。
- 组件更名一义一名：`BrowserWaitReleaseBanner` → `BrowserWaitReleasePrompt`（位置与形态语义变更即改名，沿 boundary-rules 第 3 条精神）。

## 6. 测试矩阵

1. **安全区 store**：侧栏写 rect / 卸载写 null；`useSafeArea` 推导（null → 全窗口；rect → 左侧区域）。
2. **NoticeStack 定位**：无侧栏 → 右下角窗口锚；有侧栏（stub rect x=800）→ 容器右边界 = 800−16（jsdom 数值断言容器 style）。
3. **死信 toast**：三 kind 各自渲染 + 6s 自动消散（fake timers）+ 手动关闭；`trust-request`/`agent-waiting-release` kind 不在堆叠出现（防双渲染）。
4. **Tier A 居中**：安全区居中锚（含侧栏 stub 时的偏移）；信任卡遮罩点击不消散、三按钮与错误行行为锁迁移后全绿；释放卡逻辑锁迁移后全绿（含 durationMs 计时/失败错误行/busy）。
5. **防遮挡回归锁（结构性）**：全部提示组件渲染于 CenterPromptLayer/NoticeStack 容器内，容器定位由安全区驱动；断言容器与侧栏 rect 不相交（数值断言）。
6. **既有三卡**：迁移后各自既有测试（显隐/IPC/按钮）全绿，仅容器断言适配。
7. **侧栏还原**：释放条幅移除后，BrowserSidebar 的 onBrowserState 订阅计数回 1；条幅集成锁（contains 断言）随挂载移除而删除——遮挡防线由第 5 条安全区锁接替。

## 7. 风险与取舍

- **居中 vs 打扰**：信任卡带遮罩是全应用首个近模态提示——裁定依据：它阻断 agent 执行且 3 分钟超时，注意力缺口已造成实际问题（用户反馈）；升级/沙箱等非阻断提示明确排除在遮罩外。
- **释放卡居中但用户可能正在用浏览器**：无遮罩 + 不获焦点，纯视觉提示；侧栏常驻徽标仍是最短释放路径。
- **DOM 探测代替 IPC 同步侧栏 rect**：store 由侧栏自身写入（单一写入者），避免主进程回传（`browser:state` 不含侧栏宽度——加字段即跨进程契约变更，违反非目标）。
- **动效/堆叠上限等细节**：首版从简（淡入、上限 4），留迭代空间。

## 8. 里程碑

- **M1**：安全区 store + useSafeArea + NoticeStack + 死信三 kind toast（矩阵 1-3、5）。
- **M2**：CenterPromptLayer + 信任卡/释放卡迁移 + 侧栏还原（矩阵 4、7）。
- **M3**：沙箱/升级/恢复三卡迁入 + App 挂载收敛 + 全量验证 + CHANGELOG（矩阵 6）。
