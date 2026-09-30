# 看板泳道语义重构：待办=草稿 / 排队中=已启动队列（2026-09-30）

> 状态：待评审
> 范围：任务生命周期落态 / 入队通道 / executor 闸门 / 看板 UI / 存量迁移
> 上游讨论：2026-09-30 看板泳道逻辑梳理（用户裁定 A/B 选项与三项修正）

## 1. 背景与问题

1. **命名与语义错位**：「已分配」列实际语义是「已放行、排队等执行」（assigned 池），但命名暗示「已指派委派目标」——用户心智模型（已分配=已指派）与实现（已分配=已放行）冲突。
2. **创建即执行**：现状 K1 落态决策下，表单创建带目标任务直接落 `assigned` 入队自动跑；带 scheduledAt 落 `pending` 在待办列等到点自动入队。用户模型应为「创建/编辑=草稿，启动=显式动作」两段式。
3. **拖拽无效感**：无目标 draft 拖入已分配列被主进程拒绝（仅一闪而过的 toast + 卡片回弹）。
4. **计划时间对已入队任务失效**：executor `peekNextAssigned` 只把 scheduledAt 当排序键，无「到点才放行」闸门——assigned 池里未来时间的任务会被立即放行。
5. **pending 状态多余**：新模型下定时不再需要 pending 中转（assigned + 未来时间 + 闸门即可表达）。
6. **deadlineAt 无执行语义**：仅详情展示 + kickoff 元信息，表单字段冗余。

## 2. 目标 / 非目标

**目标**

1. 泳道语义与命名对齐：待办=草稿区（创建/编辑永不改变停留），排队中（原「已分配」改名）=已启动等待执行池。
2. 「启动」成为唯一入队动作，入口两个：拖拽到排队中 / 详情面板启动按钮；入队后三种等待原因（并发满 / 计划时间未到 / 会话车道占）统一由 executor 闸门表达。
3. 无目标 draft 拖入排队中 → 弹指派弹框（目标 + 可选计划时间），取消零副作用。
4. pending 状态退役：不再产出 + 存量迁移（状态机枚举保留为死态）。
5. 删除新建/编辑表单的「截止时间」字段。

**非目标**

- 不改状态机九态枚举与既有合法转换表（pending 留死态，不删边）。
- 不改 session_queued 车道语义、resume 断点续跑链、pinned 排序模型。
- 不删 deadlineAt DB 列与详情面板展示（存量兼容）；kickoff 截止 meta 保留。
- 不为「排队中任务改期」新增动作（编辑已锁定；见 §6 已知限制）。

## 3. 核心语义表

### 3.1 泳道 × 状态

| 泳道 | 底层状态 | hint | 语义 |
|---|---|---|---|
| 待办 | draft | 草稿 | 用户创建/编辑的任务草稿，永不自动离开 |
| 排队中（原「已分配」） | assigned + session_queued | 等并发 / 等计划时间 / 等车道 | 已启动、等待执行的任务池 |
| 进行中 / 已完成 / 已关闭 | 不变 | 不变 | 不变 |

### 3.2 启动语义（executor 闸门统一表达）

```
入队 = transition(draft → assigned) + notifyExecutor（scheduledAt 原样保留）
  ├─ scheduledAt 为 NULL 或 ≤ now → 并发有空位立即放行；满则停排队中
  └─ scheduledAt > now            → 停排队中，到点自动放行（闸门 + 30s 扫描精度）
```

「在待办停留太久、计划时间已过」的场景由 `≤ now` 分支自然覆盖（立即放行）。

## 4. 变更设计

### 4.1 创建落态（K1 决策表重写）

| 入口 | 新落态 | 现状落态 |
|---|---|---|
| 表单创建（看板新建 / 会话内创建按钮 / InlineTaskSuggestion → IPC `task:create`） | **一律 draft**（无论目标/定时） | 有目标→assigned；有定时→pending；否则 draft |
| agent `create_task` 工具：有目标 | **assigned**（建即入队；scheduledAt 为未来时间时由闸门等到点） | 有定时→pending；否则 assigned |
| agent `create_task` 工具：无目标 | draft（不变） | draft |

实现：`ipc.handlers` 的 `task:create` 决策表改为「表单路径一律 draft」；`task-tools.createTask` 改为 `hasTarget ? 'assigned' : undefined`（scheduledAt 原样透传，不再产 pending）。

### 4.2 启动入口统一 = 入队

- 详情面板「启动」按钮：`canStart` 收敛为 **draft 且有委派目标**（pending 迁移后不存在；assigned/session_queued 已在队列由 executor 管，不再显示启动按钮）。点击改调 `task.move({ column:'assigned', groupId: 当前组 })`——复用 executeMove 单点（目标校验 / transition / notify / 换组原子），不新增 IPC 通道。
- 无目标 draft：**保持现状**——不显示启动按钮，仅「编辑 / 取消任务」+ 引导文案（「任务尚未指派委派目标——点击『编辑』选择…」）；不弹框。
- `startTask` 函数保留为 executor 放行内部消费（assigned→in_progress）；K2 的 draft 快捷路径分支保留（agent 侧与兼容调用）。

### 4.3 executor 闸门与 scheduler 改造

- `peekNextAssigned` SQL 增加闸门：`AND (scheduled_at IS NULL OR scheduled_at <= ?now)`；排序 `priority DESC, COALESCE(scheduled_at, created_at) ASC` 不变。
- `TaskScheduler.checkOnce` 重写为 **due-wakeup**：扫 `status='assigned' AND scheduled_at <= now` 命中即 `notifyExecutor()`（纯加速器；不转状态、不广播——executor 30s 兜底扫描天然覆盖）。原「pending→assigned 升级 + 快照广播」路径退役。
- 循环续期：`spawnNextInstanceIfRecurring` 下一实例落 **assigned + 下次时间**（现状 pending），闸门自然等到点自动跑。
- 时钟注入沿用 `opts.now` 既有模式（闸门与 due-wakeup 均可测）。

### 4.4 看板 UI

- **列改名**：「已分配」→「排队中」，hint「已分配+排队中」→「等并发/等计划时间/等车道」；待办 hint「草稿+待分配」→「草稿」。两份 board-columns 镜像（renderer/electron）同步 + `board-columns-sync.test` 锁死。`STATUS_LABEL.assigned` 状态徽标同步「已分配」→「排队中」；`STATUS_LABEL.pending` 词条保留（存量徽标兼容，迁移后不再出现）。
- **AssignTargetDialog**（新组件，`renderer/src/components/task-board/`，P1 预览门禁——出 HTML 静态预览确认后实现）：
  - 触发：`useBoardDrop.dragEnd` 预判 draft 无委派目标 + 落点为排队中列 → 进 `pendingAssign` 状态，不发 move。
  - 字段：委派类型三选（agent/团队/会话）+ 目标下拉（数据源与 CreateTaskDialog 同：`agent.listMembers` / `team.list` / `session.list`）+ 可选计划时间（`datetime-local`，min=当前时间，预填 `task.scheduledAt` 已有值）。
  - 确定：`task.update` 写互斥目标三列（+scheduledAt 若填写）→ `task.move(排队中, 落点组)`；任一步失败 toast（目标已写入可重试）。
  - 取消：零副作用（照 `pendingConfirm` 确认框先例——弹框期间不发任何 IPC）。
- **表单瘦身**：CreateTaskDialog / EditTaskDialog 删除「截止时间」输入字段；CreateTaskDialog「计划开始」保留（草稿定时，启动时由闸门消费）。
- BoardCard 徽标/菜单无变化（编辑资格已收敛为 draft/pending；pending 退役后自然只剩 draft）。

### 4.5 迁移 051

- `UPDATE tasks SET status='draft' WHERE status='pending'`（显式事务包裹，沿迁移 050 纪律）。
- **补挂 `DROP COLUMN board_position`**（同事务）：迁移 050 上线时其 up 中的 DROP 语句因脚本事故丢失且已按 ADD-only 版本应用到存量库（050 测试 3 用例红）；050 不可追改语义（版本已记录），DROP 收敛到 051 对新旧库统一生效，050 的误导注释与测试断言同步修正。
- 语义无损性：带定时存量的 scheduledAt 保留——用户启动时由闸门消费（过去时间立即跑，未来时间等到点）。
- 迁移测试：051 专项（pending→draft + board_position 删除 + 其余状态不动）+ 047/050 回归照常。

### 4.6 测试策略

**electron**

- `move.test`：draft 无目标拒绝文案不变；draft 有目标→assigned（现状已有）；新增「带未来 scheduledAt move → assigned 停留，executor 不捞」。
- `executor.test`：闸门三态（NULL 立即 / 过去立即 / 未来不捞、到点后捞）。
- `scheduler.test`：checkOnce 新语义（due→notify；非 due 不 notify；零转态零广播）。
- `task-tools` / `ipc.handlers`：K1 新决策表（表单路径 draft / agent 有目标 assigned / 定时不再产 pending）。
- `recurrence.test`：下实例 assigned + scheduledAt。
- `migration-051` 专项测试。

**renderer**

- `AssignTargetDialog.test`：三选互斥 / 未选禁用 / 计划时间预填与 min / 确定链 update+move / 取消零调用。
- `useBoardDrop.test`：无目标 draft 拖排队中拦截弹框不 move。
- `TaskDetailPanel.test`：canStart 收敛（draft+目标显示启动并改调 move；assigned 无启动）。
- `STATUS_LABEL` / 列名断言更新；CreateTaskDialog / EditTaskDialog 截止字段移除断言。

## 5. 实施注意（plan 阶段清点项）

1. `ipc.task.start` 的 renderer 调用方逐一清点（TaskProgressButton 等），UI 直调点改 move；通道保留（executor 内部为主进程函数直调，不经 IPC）。
2. scheduler 广播退役后，核查放行链转态（assigned→in_progress）是否需要补任务快照广播触发点（p2p task-broadcast）。
3. 迁移 051 与既有迁移挂载序（050 之后）、vitest threads 池基建注意事项沿用（见 vitest.config.ts 注释）。
4. UI 门禁分级：AssignTargetDialog 为 P1（新组件，预览先行）；列改名/hint/表单删字段为 P2 文案变更（豁免预览，事后截图验收）。

## 6. 风险与已知限制

- **行为变化（均已裁定）**：表单创建带目标不再自动跑（核心目标）；agent 定时任务从「待办等到点」变「排队中等到点」（更符合模型）。
- **排队中任务不可编辑**（编辑资格收敛的既定约束）→ 连带不可改期；需要改期时「取消任务→重建」。如未来高频需要，可加「撤回排队」动作（拖回待办），本期不做。
- **到点精度 30s**：闸门由 executor 30s 兜底扫描 + scheduler due-wakeup 加速，与现状定时任务精度一致，无回退。
- **pending 死态**：枚举与状态机边保留（draft→pending、pending→assigned 合法边不删），仅停止产出；避免九态类型全端波及。
