# SessionTodoBar 交互改版（活清单 + 仅活跃页签 + 折叠限高）设计

- 日期：2026-09-18
- 状态：已定稿（视觉伴侣方案 A 经用户确认）
- 前置：`docs/specs/2026-09-18-session-todo-bar-design.md`（v1 已上线，commit ab44978）
- 范围：renderer `im` 视图 SessionTodoBar 交互改版；不改数据模型 / IPC / 主进程

## 1. 背景：v1 上线后的两个体验痛点

1. **长清单遮挡会话**：TodoSection 流式中自动展开且高度无限——清单一长（10+ 项）底部条吃掉大半消息区
2. **页签堆积**：每个产生过 todos 的消息都是一个常驻候选页签；一个会话多轮对话后页签轻松上 8 个，而用户只关心最新清单

## 2. 市面调研结论（12 工具，2026-09）

| 结论 | 依据 |
|---|---|
| 没有主流工具做「历史清单页签堆积」；通行做法是**每会话一份活清单，新清单替换旧的** | Claude Code（单活清单，旧数据落盘 `~/.claude/tasks/` 不显示）、Gemini CLI（living document）、Cursor Plan（一次一份）、VS Code Copilot Plan agent（按会话隔离）、Windsurf Cascade（单活清单） |
| 长列表通行做法：**默认折叠 + 快捷键/点击展开 + 展开态限高滚动** | Claude Code CLI 与 Gemini CLI 均用 `Ctrl+T` 切换；Gemini 文档明言「full todo list might be hidden to save space」；Claude Code 展开硬裁 5 条无滚动是其已知缺陷（issue #54355），不学 |
| 多 agent 并发只对**正在活跃**的做可见性 | Claude Code VS Code「N agents 指示 + agent map 树」；Replit Agent 4 共享看板；均不给历史轮次留常驻位 |

备选与否决：B「单行摘要 + popover 浮层」（浮层遮消息、无历史回看、并行细节弱）；C「计划落 Markdown 文件」Cursor 式（把流式动态快照文件化，改动面远超交互调整，否决）。

## 3. 交互语义（定稿）

| 维度 | v1 | v2（本设计） |
|---|---|---|
| 默认显示 | 全部候选进页签 | **最新一份活清单**（按消息时间序取最后候选；新轮次 todowrite 直接替换） |
| 页签 | 候选 >1 即出现 | **仅当 ≥2 个候选同时 `streaming`** 时渲染页签（每个流式候选一个）；全部转终态后页签消失，回到最新清单 |
| 展开/折叠 | 流式中自动展开 | **默认折叠**（流式中也折叠）；摘要行 = 「任务」图标 + `n/m` + 进度条 + **▶ 当前进行项**（首个 `in_progress` 项，超长截断）；点击摘要行或 `Ctrl+T` 切换；用户的展开选择**跨替换保持** |
| 长列表 | 展开无限高 | 展开列表容器 **`max-h` 约 32vh + 内部滚动** |
| 历史 | 占页签常驻位 | **「历史 ▾」下拉**（存在历史候选即候选数 >1 时显示）：下拉面板（限高滚动）列出历史候选「agent 名 · n/m · 终态」；点击**临时查看**该快照，摘要区显示「正在查看历史 · 返回最新」；**任何新活动**（候选增员 / 新流式开始）自动清除历史查看态回到 live |
| ✕ 关闭 / 增员重现 / 切会话重置 | — | 不变（沿用 v1 语义） |

## 4. 组件与文件

| 文件 | 改动 |
|---|---|
| `renderer/src/components/im/SessionTodoBar.tsx` | 重写编排：活清单推导、仅流式页签 + 固定、新增 `expanded` / `historyViewId` 局部状态、摘要行渲染、`Ctrl+T` 键监听、限高滚动容器 |
| `renderer/src/components/im/TodoSection.tsx` | 退化为**纯列表渲染**（删除 header 按钮与内部 expanded state、`isStreaming` 自动展开语义）——摘要行与展开控制归 bar |
| `MiddlePanel.tsx` / `AgentStreamBubble.tsx` / `SubAgentSection.tsx` | **不动** |

## 5. 状态推导

```
active = historyViewId 对应候选
       ?? pinned（仅多流式时可设；该流转终态自动解除——复用 v1 prevPinnedStatusRef 逻辑）
       ?? 最后一个 streaming 候选
       ?? 最后一个候选（最新快照）
```

- 页签候选集 = `candidates.filter(streaming)`，仅当其长度 ≥2 时渲染页签行
- 新增局部状态：`expanded: boolean`（默认 false，切换后跨候选替换保持）、`historyViewId: string | null`
- `historyViewId` 清除时机：候选增员、任一候选开始流式、切换会话、点击「返回最新」
- `Ctrl+T`：组件挂载时 window keydown 监听切换 `expanded`；**实施第一步先核对全局快捷键冲突**（浏览器侧栏 / 编辑器 tab / 全局 accelerator），冲突则放弃快捷键仅保留点击

## 6. 边界情况

- 无候选：不渲染（不变）
- 单个流式候选（无并行）：无页签，active = 该流式候选，摘要行实时更新
- 流式候选早于历史候选（子 agent 仍在跑、主 agent 已完成新一轮）：active 仍取流式者（推导序保证）
- 历史查看中列表为完成态：正常渲染快照，无流式光标
- 页签超过 4 个（≥5 并行流式）：`flex-wrap` 换行（沿用 v1）
- dismissed 状态下历史增员：清 dismissed 重现（v1 语义，候选增员判据不变）

## 7. 设计系统合规

语义 token、lucide 图标（ListTodo / ChevronDown / History / X）、无 emoji、无硬编码色；摘要行密度对齐 InputToolbar 既有紧凑样式。

## 8. 测试计划（renderer 贴源 colocated）

**`SessionTodoBar.test.tsx`（大改）：**

1. 默认折叠——即使 active 候选 streaming，也只渲染摘要行不渲染列表
2. 摘要行内容——n/m、进度文本、当前进行项 subject、无进行项时不显示 ▶ 段
3. 点击摘要行切换展开；展开渲染完整列表；限高滚动容器在场（class 断言）
4. 页签仅多流式——单流式/全终态无页签；≥2 流式出页签；全部转终态后页签消失且 active 回最新候选
5. 多流式固定/解除语义沿用（v1 用例改造：setupTwo 全终态组合不再产生页签）
6. 历史 ▾——单候选不显示；多候选显示；点开列出条目；点击临时查看（摘要区出现「返回最新」）；新候选增员自动退出历史；新流式开始自动退出
7. v1 生命周期用例回归——✕ 隐藏/增员重现/切会话重置在新语义下成立
8. 新清单替换——上一轮 5/5 完成态被新一轮清单替换为摘要行

**`TodoSection.test.tsx`（改契约）：** 纯列表渲染（条目图标三态 / 完成态样式 / 空数组返回 null）；删除 header/自动展开用例（职责已移走）

**不动：** `AgentStreamBubble.test.tsx`、`SubAgentSection.test.tsx`（v1 反向断言继续有效）

## 9. 验收口径

- `npx pnpm@9.0.0 typecheck` 双 workspace 0 error
- `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全绿
- 手工 GUI（macOS 主机）：长清单（12 项）默认折叠不遮挡、展开限高滚动；多轮对话后无页签堆积、最新清单自动替换；并行子 agent 时页签出现/消失；历史下拉临时查看与自动退回
