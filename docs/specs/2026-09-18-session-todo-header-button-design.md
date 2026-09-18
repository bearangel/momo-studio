# 会话头部任务按钮（TaskProgressButton）+ 气泡内联清单恢复设计

- 日期：2026-09-18
- 状态：已定稿（视觉伴侣确认：点击行为 C 浮层+定位链接；徽标带 n/m；呼吸灯/隐藏/移除等 4 条默认裁定）
- 前置：`docs/specs/2026-09-18-session-todo-bar-design.md`（v1）与 `docs/specs/2026-09-18-session-todo-bar-ux-refine-design.md`（v2 底条改版）——**本设计取代 v2 的底条形态**
- 范围：renderer `im` 视图；不改数据模型 / IPC / 主进程

## 1. 背景：三轮反馈

| 轮次 | 痛点 |
|---|---|
| v1 | ① 长清单展开遮挡会话；② 多轮对话页签堆积 |
| v2（底条改版后） | ③ 点击 ✕ 关闭后无任何恢复入口（切会话才重现）；④ 主 agent 与并行子 agent 同时产清单时，入口永远被子 agent（流式优先推导）顶掉——主 agent 才是用户焦点 |

## 2. 决策：回到「清单在气泡内」+ 头部按钮入口

用户提案（经评估为净简化，删多增少）：

- **移除底条**：SessionTodoBar 及其全部交互（✕ 关闭 / 历史下拉 / Ctrl+T / 仅流式页签）整体退役——③ 随 dismiss 语义消失而根治
- **清单回气泡**：AgentStreamBubble / SubAgentSection 恢复 v1 内联 TodoSection（流式自动展开、完成自动折叠）——历史天然随气泡留存，①② 不回归
- **头部任务按钮**：只指向**最新顶层气泡**的清单——④ 根治（子 agent 清单留在嵌套区，不抢入口）；常驻头部无「关闭后无入口」状态

否决记录：继续修补 v2 底条（保留 dismiss 恢复入口 + 调整推导优先级）——保留了两轮争议的复杂度；本方案一次退回简单形态。

## 3. 交互定稿

### 3.1 任务按钮（会话头部，「导出会话」旁）

- 组成：ListTodo 图标 + 文本「任务」+ `n/m` 徽标 + 运行中呼吸灯圆点
- **隐藏规则**：当前会话不存在顶层清单目标时隐藏（仅子 agent 有清单 → 按钮不出现，清单去嵌套区看）
- **呼吸灯**：会话内任一含待办流（含子 agent）`streaming` 时点亮（accent 色呼吸动画）
- **徽标**：目标清单的 `完成数/总数`，不点开即可余光读取

### 3.2 浮层（点击按钮）

- 位置：按钮下方浮层面板（头部容器内绝对定位，不挤压消息流）
- 内容：目标清单完整列表（流式实时刷新）+ 头行（agent 名 + n/m）+ 尾部「定位到消息 ↗」
- 收起：Esc / 点击浮层外 / 再次点击按钮
- 「定位到消息 ↗」：`scrollIntoView` 滚动到目标气泡（`block: 'center'`，smooth）+ 边框闪烁高亮约 2.4s，浮层关闭

### 3.3 恢复内联清单（v1 语义）

- 顶层 agent 气泡：TodoSection 渲染在气泡顶部（流式展开 / 完成折叠 / 手动开合）
- 子 agent 嵌套区：TodoSection 渲染在嵌套工作区顶部

## 4. 组件与文件

| 操作 | 文件 | 说明 |
|---|---|---|
| 新增 | `renderer/src/components/im/TaskProgressButton.tsx`（+ 贴源测试） | 头部按钮 + 浮层 + 定位；props 仅 `sessionId` |
| 改名 | `renderer/src/components/im/TodoSection.tsx`（现纯列表）→ `TodoList.tsx` | 列表渲染单源，测试同步改名迁移 |
| 恢复 | `renderer/src/components/im/TodoSection.tsx`（v1 自包含版，内部用 TodoList） | 从 git 历史 `fbc84ff^` 恢复并适配，测试恢复 v1 用例 |
| 恢复渲染 | `AgentStreamBubble.tsx` / `SubAgentSection.tsx` 重新挂 TodoSection | 测试由 v2 反向断言改回 v1 正向断言 |
| 修改 | `layout/MiddlePanel.tsx` | 头部接入 `<TaskProgressButton />`（导出旁）；移除 `<SessionTodoBar />` 挂载 |
| 修改 | `im/MessageBubble.tsx` | 外层加滚动锚点 `id="msg-{message.id}"` |
| 删除 | `im/SessionTodoBar.tsx` + `SessionTodoBar.test.tsx` | 组件与 20 用例随形态退役 |
| 修改 | ~~`renderer/src/styles/globals.css`~~ | **勘误（终审）**：keyframes 按仓库既有模式以**组件内 `<style>` 标签注入**（先例 `AgentStreamBubble.tsx` momo-stream-blink），不改 globals.css；色用 `rgb(var(--accent-500))` token 形式 |

## 5. 数据推导（零新 store、零 IPC）

- **按钮目标**：`messagesBySession.get(sessionId)` 中满足 `parentStreamSessionId === null && sender !== 'owner'` 且 `streams.get(msg.id)?.todos.length > 0` 的**最后一个**消息（时间序取末位 = 最新顶层清单）
- **呼吸灯**：会话内任一消息（含子 agent 消息）的流 `todos.length > 0 && status === 'streaming'`
- **浮层刷新**：订阅既有 `stream.store`，流式事件实时更新徽标与列表
- **定位**：`document.getElementById('msg-' + targetMessageId)` → `scrollIntoView` → 临时加 flash class（setTimeout 移除）

## 6. 边界情况

- 仅子 agent 有清单：按钮隐藏；子清单在嵌套区可见
- 目标气泡已完成：按钮常显（徽标 n/n），呼吸灯灭，浮层可看可定位
- 浮层打开期间目标被新清单替换（新一轮开始）：浮层内容实时切换为新目标（跟随最新）
- 浮层打开期间会话切换：浮层随按钮状态重算（open 状态保留但内容跟随新会话；实现上 sessionId 变化时收起浮层更干净——采纳收起）
- 流式中滚动定位：允许（用户主动点击）

## 7. 设计系统合规

- 语义 token（accent / surface / border-subtle）；lucide 图标（ListTodo / X / LocateFixed 等，16px/stroke 1.75 基准）；无 emoji、无硬编码色
- 动效 keyframes 定义于 globals.css（不散落 inline），呼吸/闪烁周期与 `momo-stream-blink` 风格一致

## 8. 测试计划（renderer 贴源 colocated）

**`TaskProgressButton.test.tsx`（新增）：**

1. 无顶层清单目标 → 按钮不渲染（含「仅子 agent 有清单」专项）
2. 徽标显示目标 n/m
3. 呼吸灯：目标流式中点亮；目标已完成但子 agent 流式中仍点亮
4. 浮层：点击展开渲染目标清单条目；Esc / 点外部 / 再点按钮收起
5. 「定位到消息」：mock `getElementById` + `scrollIntoView`，断言调用与浮层关闭
6. 目标替换：浮层内容跟随最新顶层清单
7. sessionId 变化 → 浮层收起

**迁移与恢复：**

- `TodoList.test.tsx`：现 TodoSection 纯列表 4 用例改名迁移
- `TodoSection.test.tsx`：恢复 v1 用例（header 进度 / 流式展开 / 完成折叠 / 手动开合 / 空数组）
- `AgentStreamBubble.test.tsx` / `SubAgentSection.test.tsx`：v2 反向断言改回 v1 正向（todos → 渲染「任务」）
- 删除 `SessionTodoBar.test.tsx`

**锚点：** MessageBubble 外层 `id="msg-{id}"`（在 TaskProgressButton 定位用例中经 mock 覆盖，不单测）

## 9. 验收口径

- `npx pnpm@9.0.0 typecheck` 双 workspace 0 error；`--filter momo-studio-renderer test` 全绿
- 手工 GUI（macOS 主机）：主 agent + 2 并行子 agent 同建清单——按钮徽标跟随主 agent、呼吸灯亮、浮层可看可定位、子清单在嵌套区；无底条；多轮对话后各气泡保留各自清单
