# 会话与任务联动优化设计（变更显示统一 / 双锚点定位 / 撤回联动取消）

- 日期：2026-09-29
- 状态：已评审（brainstorming 三节逐节确认）
- 关联：`docs/specs/2026-09-28-journal-rollback-redesign.md`（回滚重构，本设计的直接上游）、`docs/specs/2026-09-18-session-todo-header-button-design.md`（定位闪烁模式先例）

## §1 背景与动机

任务域与会话域各自有成熟的单侧能力，但联动断层：

1. 任务详情抽屉的「变更与回滚」分区折叠态无信息量，用户无法一眼知道任务改了哪些文件；会话侧 `ChangesChip`（「N 处变更 · M 个文件」+ 逐文件 diff）的视觉语言已被验证友好。
2. `TaskRow` 已存 `sourceSessionId` / `sourceMessageId`（来源）与 `executionSessionId`（执行），但 UI 只有一个「进入执行会话」入口，且仅 `in_progress` / `paused` 可见——完结任务回不去，来源消息完全没有定位入口。
3. 撤回（`TurnUndoDialog`，撤最后一组对话：journal 还原 + 硬删消息）后，从该组对话创建的任务 `sourceMessageId` 悬空，任务状态与来源对话脱钩。

## §2 目标与非目标

**目标**

- G1：任务变更显示与 `ChangesChip` 视觉统一，折叠态可见「N 处变更 · M 个文件」与文件路径清单。
- G2：任务双锚点定位——来源消息（切会话 + 滚动 + 闪烁）与执行会话（全状态可见）。
- G3：撤回确认框显式联动——列出受影响任务，未启动的默认勾选一并取消，进行中/已完结明示不动。

**非目标（YAGNI）**

- 不做任意历史轮次撤回（仍只有最后一组）。
- 不做任务状态流转在会话时间线内的卡片化。
- 不做执行会话内按任务过滤消息。
- 不删任务侧 `sourceMessageId` 数据（悬空指针用降级显示消化，不毁数据）。
- 无 schema 迁移、无新表。

## §3 G1：任务变更显示统一 ChangesChip 视觉

### §3.1 现状

- 会话侧 `renderer/src/components/im/ChangesChip.tsx`：折叠一行「N 处变更 · M 个文件」，展开逐文件行（rename 显示 `old → new` + 条数），点开 `DiffBlock`。数据：`ipc.journal.list({workspaceId, streamSessionId})`。
- 任务侧 `renderer/src/components/task-board/TaskChangesPanel.tsx`：折叠态是普通按钮行（零信息），展开主角是 `JournalRollbackSection`（回滚），明细次之。数据：`ipc.journal.list({workspaceId, taskId})` + `ipc.journal.scan`（懒执行）。
- 两处的文件行渲染是近重复代码（同用 `groupByPath` + `DiffBlock`）。

### §3.2 共享组件 `JournalFileChangesList`

新文件 `renderer/src/components/common/JournalFileChangesList.tsx`：

- props：`entries: JournalEntryView[]`（内部 `groupByPath`）+ 可选 `testId?: string`（宿主专属 testid）。**组件只负责文件行渲染**——摘要计数由宿主自己的头行承担（chip 折叠头 / 任务分区头形态不同），避免双份计数与多态 prop。
- 文件行列表：每行 = 路径（rename：`old → new`）+ 条数 + 就地展开 `DiffBlock`。
- `groupByPath` / `DiffBlock` / `FileChangeGroup` 继续从 `common/JournalChangeViews.tsx` 导入，不搬动。

### §3.3 TaskChangesPanel 信息架构调整

- **挂载时机变更**：`TaskDetailPanel` 不再按 `changesOpen` 条件渲染 `TaskChangesPanel`——面板随任务详情常驻挂载（`journal.list` 即查，本地 SQLite 按 taskId 索引，轻）；「变更与回滚」分区头（含计数徽标）的渲染职责移入 `TaskChangesPanel`。
- 分区折叠态改为**摘要常显**：分区头行右侧显示「N 处变更 · M 个文件」（无变更显示「无变更记录」），头行下方常显紧凑文件路径清单（`JournalFileChangesList` 文件行，可就地展开 diff；`font-mono text-[11px]`，容器 `max-h-40 overflow-y-auto`）。
- 展开态：文件明细（`JournalFileChangesList` 完整版，含就地 diff）→ `JournalRollbackSection`（原样保留，回滚能力不变）→ 未入账区（原样保留）。
- `journal.scan` 保持**展开后**懒执行（git 交叉核对贵，原 2026-09-28 spec §5.5 语义不变）。
- 空态文案保持现有语义（「会话内直接对话产生的变更不计入任务」）。

### §3.4 ChangesChip 收敛为薄壳

- 保留：journal 查询 + 挂载懒查 + 失败降级逻辑。
- 文件行 / 摘要渲染替换为 `JournalFileChangesList`（其外层 chip 容器与折叠交互仍由 ChangesChip 自己持有——会话侧 chip 整体折叠、任务侧分区独立展开，折叠语义不同，不强行合并外壳）。

## §4 G2：任务双锚点定位到会话

### §4.1 入口矩阵（TaskDetailPanel）

| 入口 | 可见条件 | 行为 |
|---|---|---|
| 来源消息（新增，信息网格行，样式同「母任务」链接） | `sourceSessionId != null` | `locateMessage(sourceSessionId, sourceMessageId)` |
| 执行会话（调整，现有底部链接） | `executionSessionId != null`，全状态 | 进入会话后定位：锚点 = 已加载消息中 `taskId === task.id` 的**最后一条顶层可渲染消息**（复用 MessageList 过滤口径，抽 `isTopLevelMessage` 共享；最新命中必在首屏窗口，无需向历史翻页）；无命中或锚点无 DOM 行 → 只切会话不定锚 |

- 执行会话定位依赖 `ImMessage.taskId` 字段：electron `MessageRow` 已有 `taskId` 列且 renderer `ImMessage` 已透出（`types.d.ts:425`），无需类型补齐。
- **锚点 DOM 归一**：现状 `msg-<id>` 只挂在 `AgentStreamBubble` 根节点（owner 静态气泡无锚点）。锚点移到 `MessageList` 的消息行包装 div（全部可见行都有），`AgentStreamBubble` 根节点移除原 `id`（防重复 id）。

### §4.2 `locateMessage` helper

新文件 `renderer/src/lib/locate-message.ts`，导出：

- `locateMessage(sessionId: string, messageId: string | null): Promise<'located' | 'entered' | 'message-missing'>`
- `revealMessage(messageId: string): Promise<boolean>`（切 IM 视图 + 双 rAF 等 DOM 提交 + scrollIntoView + 闪烁；DOM 行不存在返回 false——嵌套/被过滤行）
- `isTopLevelMessage(msg: ImMessage): boolean`（MessageList 顶层渲染口径单源，两处消费防漂移）

`locateMessage` 流程：

1. `messageId == null` → 仅 `selectSession(sessionId)` + `setActiveView('im')`，返回 `entered`。
2. 会话未激活 → `await selectSession(sessionId)`（首屏消息入 store）；抛错 → toast「进入会话失败」+ 返回 `message-missing`。
3. 已加载消息中未命中且 `hasMoreBySession` 为 true → 循环 `await loadOlder(sessionId)` 直到命中或 `hasMore === false`；防御性批数上限 50（正常由服务端 `hasMore` 权威终止）。
4. 命中 → `revealMessage(messageId)`：成功返回 `located`，DOM 行缺失（被过滤）返回 `entered`。
5. 未命中（到底无此消息）→ 切 IM 视图 + toast「定位失败：消息不存在（可能已被撤回）」，返回 `message-missing`。

- 闪烁动画通用化：新共享 `msg-flash`（`components/common/MessageFlash.tsx`：keyframes `<style>` 组件 + `flashMessage` 工具 + class 常量，style 挂载于 `MessageList`），`TaskProgressButton` 的 `todo-flash` 一并切换（统一消息定位视觉，测试同步改）。

### §4.3 边界

- 来源会话与任务同 workspace（创建路径保证），不做跨 ws 跳转；会话不存在（极端异常）→ catch 后 toast。
- `sourceMessageId` 悬空（G3 撤回后）→ 走第 5 步降级 toast；任务侧链接保留可点（不预判、不加后台探测 IPC）。
- jsdom 无 `scrollIntoView`：测试按 `TaskProgressButton.test` 先例 mock（`momo-test-rules` 收窄 mock）。

## §5 G3：撤回联动取消

### §5.1 主进程：sourceMessageIds 过滤

- `listTasks` repo（`electron/src/main/storage/tasks/repo.ts`）加可选过滤 `sourceMessageIds?: string[]`（`source_message_id IN (...)`，空数组跳过该条件）。
- `task.list` IPC 契约同步：`renderer/src/ipc/types.d.ts` 的 `TaskApiSurface.list` 加 `sourceMessageIds?: string[]`（两侧 typecheck，`momo-boundary-rules`）。

### §5.2 执行顺序

TurnUndoDialog 确认后按序执行，**取消失败不回滚已成功的撤回**：

1. 现有流程不变：`journal.revert`（有 entries 时）→ `session.deleteMessages` → `reloadMessages`。
2. 全部成功后，对勾选的未启动任务逐个 `ipc.task.cancel`；失败逐条收集（`#T-id + 标题 + 错误信息`）。
3. 有取消失败 → error phase 如实列出（对话已撤回的事实保留）；全成功 → 关闭对话框。

顺序理由：先取消后撤会出现「任务取消了但对话没撤掉」的更脏状态；反之「对话撤了、任务取消失败」用户可手动取消兜底。

### §5.3 TurnUndoDialog 分层展示

- 预检阶段（loading）：与 journal 预检并行 `ipc.task.list({workspaceId, sourceMessageIds: turn.messageIds})`。
- 确认阶段新增「关联任务」区块（空列表不渲染），每行：`#id` + 标题 + 状态徽标 + 分层控件：

| 状态 | 控件 |
|---|---|
| 未启动（draft / pending / assigned） | checkbox，**默认勾选**，标注「撤回时一并取消」 |
| 进行中（session_queued / in_progress / paused） | 无勾选框，文案「仍在执行，不会被自动取消」 |
| 终态（completed / failed / cancelled） | 灰显，文案「已结束，不受影响」 |

- 状态分类用本地常量（与 `state-machine.ts` TERMINAL 集合同步，先例：TaskDetailPanel 的 `TERMINAL_STATUSES`）。

### §5.4 悬空来源处理

- 不改任务数据；悬空 `sourceMessageId` 的降级显示 = §4.2 第 5 步 toast。
- P2P 远端任务只读镜像不涉及（联动仅在本地任务域）。

## §6 错误处理汇总

| 场景 | 行为 |
|---|---|
| journal.list 失败（G1） | 摘要不渲染 + console.warn 留痕（同 ChangesChip 现状） |
| journal.scan 失败（G1） | 未入账区不渲染 + warn（现状保持） |
| locateMessage 未命中（G2） | toast「消息不存在（可能已被撤回）」 |
| locateMessage 会话不存在（G2） | catch → toast 错误信息 |
| task.cancel 失败（G3） | 逐条收集进 error phase，不静默（红线：错误路径不硬编码吞状态） |

## §7 测试计划

| 面 | 用例 |
|---|---|
| electron `listTasks` sourceMessageIds | 命中 / 空集 / 不传参数（回归） |
| TurnUndoDialog（新建测试，组件原为零覆盖） | 分层渲染矩阵（未启动默认勾选 / 进行中无勾选 / 终态灰显）；确认后取消调用序（撤回成功才取消）；取消失败的错误呈现；空列表不渲染区块 |
| locate-message（新建测试） | 已激活会话直达；未激活先 selectSession；loadOlder 循环命中 / 到底未命中 toast；messageId null 只切会话 |
| TaskDetailPanel | 入口可见性矩阵（sourceSessionId / executionSessionId × 任务状态） |
| TaskChangesPanel | 折叠态摘要常显 + scan 懒执行（展开才调）；空态文案保持 |
| ChangesChip | 既有测试重构后保持绿 |
| TaskProgressButton | flash class 切换为 msg-flash 后断言同步 |

测试位置遵守仓库规范：electron 集中 `electron/tests/`（镜像 src），renderer 贴源 colocated。

## §8 涉及文件清单

**renderer**

- 新增：`components/common/JournalFileChangesList.tsx`、`lib/locate-message.ts`、msg-flash 共享注入
- 修改：`components/im/ChangesChip.tsx`（薄壳化）、`components/task-board/TaskChangesPanel.tsx`（摘要常显 + 承接分区头）、`components/task-board/TaskDetailPanel.tsx`（双锚点入口 + 常驻挂载 TaskChangesPanel）、`components/im/TaskProgressButton.tsx`（flash 切换）、`components/im/TurnUndoDialog.tsx`（关联任务区块）
- 预计无需改 `stores/session.store.ts`：`locateMessage` 所需 `selectSession` / `loadOlder` / `messagesBySession` / `hasMoreBySession` 均为既有公开接口
- 类型：`renderer/src/ipc/types.d.ts`（`TaskApiSurface.list` 扩展；`ImMessage.taskId` 如缺）

**electron**

- 修改：`src/main/storage/tasks/repo.ts`（listTasks 过滤）、`src/main/task/ipc.handlers.ts`（透传参数）

## §9 版本纪律

合入后按 `docs/dev/release.md` 研发期策略：三处 `package.json` alpha 号 +1，不动终版号，CHANGELOG 记研发账本条目。
