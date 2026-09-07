# 任务执行运行时设计（队列调度 + 委派目标 + 循环任务）

- 日期：2026-09-07
- 状态：已评审通过（设计对话逐节确认），待实施
- 上游需求：用户提出看板功能优化四条需求（双源创建 / 双启动方式 / 并发队列 / 单次循环）
- 关联现状：`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（D 子系统任务域）、`docs/specs/2026-08-31-agent-team-session-redesign.md`（v25 团队/会话模型）

## 1. 背景与问题

### 1.1 现状执行链断裂

v2.0 重构砍除 dispatcher 链路后，任务执行管线只剩两端：

```
创建（双源已有）→ 调度触发（半成品）→ [队列 gate 缺失] → [执行驱动缺失] → 循环续期（缺失）
```

- `TaskScheduler` 到点只做 `pending → assigned`，`scanPickup` 是显式 no-op——定时任务到期后**永远停在 assigned，不会执行**
- `startTask` 只做「决策 execution session + 转 in_progress」，之后没有任何东西驱动 agent 干活
- `maxConcurrentTasks` 设置仅用于状态栏展示，无 enforcement；`queue_position` 是占位列
- `recurrence_rule` 字段预留未实现，scheduler 仅支持一次性 `scheduled_at`

### 1.2 看板数据层 P0 缺陷（必须随本项修复）

`task.store.load` 只拉 `PENDING_STATUSES = ['draft','pending','assigned']`，连锁后果：

1. 任务启动（转 in_progress）后从看板列表消失
2. 并发状态栏 `active` 恒为 0
3. TaskFilters 8 态筛选中 5 个永远空结果；TaskCard 进行中分支是死代码
4. completed / failed / cancelled 无任何查看入口

## 2. 需求与澄清结论

| # | 需求 | 澄清结论 |
|---|---|---|
| 1 | 用户 / agent 都能创建任务（如 todo MCP 拉取后 agent 建 task） | 已有双源（CreateTaskDialog + `create_task` 工具）；本项扩展创建入参（目标/计划/循环）使 agent 建的任务可直接携带调度配置 |
| 2a | 会话中 `#T` 加载任务 → agent 启动处理 | #T mention 激活语义：任务在**当前会话**就地执行（详见 §6） |
| 2b | 定时到点自动启动 + 委派 agent / 团队 / 会话 | 三类委派目标模型（详见 §4.2）；executor 补齐最后一跳 |
| 3 | 可配置并发上限 + 队列有序执行 | **全局**「同时运行任务数」一个数字（沿用 `maxConcurrentTasks`），不做 per-agent 维绑 |
| 4 | 单次 / 循环任务 | 自复制实例模型 + 三种预设规则（详见 §7） |
| — | UI 范围 | 只做配套展示修复（修 P0 + 增量信息），**不做** Kanban 列/拖拽形态改造（留下轮） |

## 3. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | executor 触发 = 写触发 + 30s 兜底扫描（方案 B） | 启动即时（<100ms）；与 P2P task-broadcast「写通道触发 + 周期兜底」成熟模式同构；兜底扫描即方案 A 逻辑，丢失通知可自愈 |
| D2 | 委派目标 = 三互斥列（`assignee_agent_id` / `target_team_id` / `target_session_id`），不做通用 kind+id | TaskCard 展示、assignee 筛选、P2P 快照、conflict-detector 等现有消费者零改动 |
| D3 | 不新增 `queued` 状态，`assigned` 即队列；排名读取时计算，`queue_position` 列继续闲置 | 不加新状态、不引入第二份排序真相与 DB 漂移。**实施修订（2026-09-07）**：状态机新增一条边 `assigned → failed`（T4 落地，commit f1405a2）——§5.1/§9 要求目标校验失败/kickoff 失败的任务转 failed，原状态机无此边会导致放行循环热循环（候选滞留 assigned 被无限 re-peek）。D3 原文「状态机零改动」指不加 queued 状态，与算法节冲突时以算法节为准 |
| D4 | 循环任务 = 自复制实例（completed 生成下一实例新行，`recurrence_parent_id` 链接） | 每次运行历史独立可审计；复用既有调度/执行全链路 |
| D5 | 规则格式 = 三预设（`every:Nm/Nh/Nd` / `daily@HH:mm` / `weekly@D,HH:mm`），不做 cron | 覆盖主场景；格式留扩展位 |
| D6 | 并发 gate 全局：`count(in_progress) < maxConcurrentTasks` | 用户裁定：限制只跟任务绑定，不与 agent 绑定 |
| D7 | kickoff 走 `sendUserMessage` 内部路径 | 免费获得落库 / 推送 / P2P 广播 / 冲突检测免疫（自 mention 不触发冲突） |

## 4. 数据模型

### 4.1 Migration v29

```sql
ALTER TABLE tasks ADD COLUMN target_team_id      TEXT;  -- 委派目标=团队（teams.id）
ALTER TABLE tasks ADD COLUMN target_session_id   TEXT;  -- 委派目标=既有会话（sessions.id）
ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT; -- 循环实例 → 母任务 id（纯标记列，不建 FK）

CREATE INDEX IF NOT EXISTS idx_tasks_admission
  ON tasks(status, priority DESC, scheduled_at);
```

三目标互斥用 trigger 模拟 CHECK（SQLite 不支持 ALTER ADD CONSTRAINT，v17 messages.task_id 有同款先例）：

```sql
CREATE TRIGGER trg_tasks_target_exclusive_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN
    ((NEW.assignee_agent_id IS NOT NULL) + (NEW.target_team_id IS NOT NULL)
     + (NEW.target_session_id IS NOT NULL)) > 1
  THEN RAISE(ABORT, '任务委派目标三列（agent/team/session）最多一个非空') END;
END;
-- 同款 BEFORE UPDATE trigger：trg_tasks_target_exclusive_update
```

### 4.2 委派目标语义

| 目标 | kickoff 路由 | execution session 决策 |
|---|---|---|
| agent（`assignee_agent_id`） | mention 该 agent instanceId，路由拉起直跑 | starter 现有决策树（预设 > createNewRoom > source_session > 新建任务会话） |
| 团队（`target_team_id`） | 不 mention，v25 接待路由交 leader，leader 自行 `dispatch` 拆解 | starter 新增团队分支：事务内新建 `kind='task_execution'` 会话，成员=团队快照展开 |
| 会话（`target_session_id`） | 不 mention，目标会话接待成员处理 | starter 优先级 1 路径（显式 `executionSessionId`） |

无目标（三列全空）合法：停留 draft 待配置，或手动启动沿用旧行为。

### 4.3 TaskRow 双端类型扩展

`renderer/src/ipc/types.d.ts` 与 `electron/src/main/storage/tasks/repo.ts` 同步加：`targetTeamId` / `targetSessionId` / `recurrenceParentId`（均 `string | null`）。

### 4.4 队列语义

- `assigned` = 就绪等待放行（队列成员）；`pending` = 定时未到；`draft` = 待配置
- **实施修订（2026-09-07 终审）**：create 入口（IPC / agent 工具）带 `scheduledAt` 的任务直接落 `pending`（原稿恒落 draft，定时链无生产者）；scheduler 到点升级的目标过滤扩为三类目标任一（原 `assignee_agent_id IS NOT NULL` 为 v1 残留，team/session 目标永不到 assigned）；executor 对三目标全空的 assigned 明示转 failed
- 放行序：`priority DESC → COALESCE(scheduled_at, created_at) ASC → created_at ASC`
- 排名「排队 #N」读取时计算，不持久化
- scheduler 职责不变（`pending → assigned` 到点升级），executor 接管 `assigned → in_progress`

## 5. 执行运行时

### 5.1 新模块 `electron/src/main/task/executor.ts`

```
admitOnce():                          // 串行执行（内部互斥，防并发放行超限）
  slots = maxConcurrentTasks - count(status='in_progress')
  if slots <= 0 → return
  candidates = tasks WHERE status='assigned'
               ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC
               LIMIT slots
  for each candidate → launch(task)

launch(task):
  1. 校验目标有效性（agent 仍在 workspace / 团队存在 / 会话存在）
     无效 → transition failed + errorMessage 明示，继续下一个候选
  2. startTask(taskId, opts)           // 复用现有事务化 starter（§5.3）
  3. 注入 kickoff 消息（§5.2）          // 失败 → failed + errorMessage
  4. 重新 count 再决定是否继续           // 以 DB 为准，防中间态超放
```

### 5.2 触发双路

- **写触发**：task 域外部写入口成功后 `void notifyExecutor()`（100ms 去抖合并）——埋点位于 task ipc handlers（create / transition / start / cancel / resolveConflict）、AgentRunner task-end、settings 写并发上限。repo 内部转换不埋（防 executor 自激励）
- **兜底扫描**：30s interval
- **boot 恢复**：主进程启动时跑一次 `admitOnce()`——crash 后 assigned 池自动续跑

### 5.3 starter 决策树扩展

优先级（**实施修订**：与实现/计划一致，`createNewRoom` 前置；原稿把 team 排在 createNewRoom 前为笔误）：`显式 executionSessionId > createNewRoom > target_team_id（事务内新建团队协作会话，快照展开成员）> source_session > 新建任务会话`。团队分支复用 v25 团队快照展开逻辑，三步写（insertSession + addSessionMember×N + transitionTaskStatus）包同一事务（Task 12 原子化模式）。**复用既有会话（显式 sessionId / source_session）且任务有 assignee 时，事务内幂等补 `addSessionMember`（终审 I2）**——否则 kickoff mention 的 agent 非成员会被接待路由错配。

### 5.4 kickoff 注入

复用 `sendUserMessage` 内部路径（不发 IPC），消息体：

```
【任务启动】#T-123 · <标题>
<描述>
优先级:高 截止:2026-09-10（有则显示）
```

- agent 目标：`mentionedInstanceIds=[assignee]`
- 团队 / 会话目标：不 mention，走接待路由
- 冲突检测与 #T 激活免疫：**实施修订（终审 I1）**——kickoff 以 `systemKickoff: true` 调 `sendUserMessage`，显式跳过冲突检测与激活两钩子（原稿「自 mention 不触发冲突」的机制论断不成立：`】#T-xxx` 的 `#` 前非空白，正则本就不解析——免疫是空真；且 description 内嵌的 `#T-` 引用可解析，会误触冲突弹窗并劫持激活）。落库 / 推送 / P2P 广播 / 路由保留

## 6. #T 激活链路

挂点：`sendUserMessage` 落库后、冲突检测同段。`parseTaskMentions(body)`（conflict-detector 唯一权威正则，直接复用）→ 对每个 mention 的任务：

| 任务当前态 | 动作 |
|---|---|
| draft / pending / assigned | 激活：`target_session_id ← 当前会话`（用户显式意图，覆盖原目标）→ 转 assigned → `notifyExecutor()`；slot 有余时 kickoff 立即出现在当前会话 |
| in_progress / 终态 | 仅引用语义（现状），不动作 |

- 幂等：已在队列只更新 `target_session_id`，不重复入队
- 激活动作同步执行（SQLite 同步 API，开销可忽略）；失败 warn 不阻塞消息发送
- MentionInput `#` 菜单本地过滤为可激活态（draft/pending/assigned）

## 7. 循环任务

### 7.1 规则格式（`recurrence_rule`，预设编码）

```
every:30m       -- 间隔型：完成后 30 分钟跑下一次（从 completedAt 起算）
daily@09:00     -- 每天 09:00（从下一个 09:00 起算）
weekly@1,09:00  -- 每周一 09:00（0=周日）
```

### 7.2 续期

挂点：AgentRunner task-end 转 `completed` 处（transition 单点，天然无重复 spawn）：

```
if (task.recurrence_rule && status === 'completed'):
  insertTask({
    ...copy(title, description, priority, 三目标列, recurrence_rule, source_session_id),
    status: 'pending',
    scheduled_at: nextRun(completedAt, rule),
    recurrence_parent_id: 母任务 id,
    deadline_at: 不复制
  })
```

之后走既有链路：scheduler 到点 → assigned → executor 放行。**failed / cancelled 不续期**，链自然停止。

## 8. Renderer 配套

### 8.1 P0 数据修复（task.store）

- `load` 改为不按状态过滤：`ipc.task.list({ workspaceId, orderBy: 'created_at', limit: 500 })`；筛选/排序全部本地 useMemo
- 连锁自愈：并发状态栏真实、8 态筛选有效、TaskCard 进行中分支激活、任务不再「启动即消失」
- 默认筛选语义调整：`status='all'` = 全部**活跃**态（draft/pending/assigned/in_progress/paused）；终态（completed/failed/cancelled）需显式选择——避免历史任务淹没列表

### 8.2 卡片与详情增量

- TaskCard：排队徽标「排队 #N」（按 admission 序对 assigned 任务计算 rank）；循环标记 `Repeat` 图标；pending 循环任务显示「下次 HH:mm」；目标类型图标 + 短码（agent 名尽力从 agent.store 解析）
- TaskDetailPanel：循环规则 / 母任务链接（`#T-xxx`）/ 目标三项展示；运行时长靠既有 5s 轮询自然刷新

### 8.3 CreateTaskDialog 扩展 + 入参同步

- 目标选择器三选一：agent（现有下拉）/ 团队下拉 / 会话下拉
- 循环规则：单次（默认）/ 每 N 分钟 / 每天 HH:mm / 每周 D,HH:mm——纯预设 UI
- IPC `task.create` 与 agent 工具 `create_task` 入参同步扩展（`targetTeamId` / `targetSessionId` / `recurrenceRule`）——agent 建的任务同样可带调度配置

## 9. 错误处理与边界

| 场景 | 行为 |
|---|---|
| kickoff 注入失败 / 目标已删（团队/会话/agent 已移除） | 放行前校验 + 转 failed 带明示 errorMessage；单候选失败不阻塞后续候选 |
| crash 后 in_progress 僵尸任务 | 既有债务不解决（agent runtime 重启恢复是 P2 遗留）；executor 只认 assigned 池不重复 kickoff；用户可取消 |
| paused | 本期不新增暂停触发入口；并发只 count in_progress；恢复队列化留待真需要时做状态机扩展 |
| 并发上限调大 | settings 写通道 notify executor，立即补充放行 |
| executor 每步失败 | 落库可见（failed + errorMessage），不静默吞 |
| UI 实时性 | 保持 5s 轮询兜底，不引入推送依赖；远端镜像链路零改动 |

## 10. 测试策略

| 层 | 覆盖点 |
|---|---|
| electron `tests/task/`（镜像 `src/`） | executor 放行（上限 gate / 排序 / 串行防超放 / 目标校验失败→failed / kickoff 失败→failed）；循环续期（字段复制 + nextRun / failed·cancelled 停链）；#T 激活（三态激活 + 会话覆盖 + in_progress 忽略 + 幂等）；starter 团队分支事务原子性；nextRun 纯函数（跨日/跨周边界）；migration v29（三目标互斥 trigger + 循环链列） |
| renderer 贴源 | task.store 全生命周期 load；TaskCard 排队/循环标记；CreateTaskDialog 目标三选 + 循环预设；TaskBoardView 并发真实计数 |
| 回归锁 | 现有 TaskBoardView / DetailPanel / SidebarPanel / Filters 测试按新 store 语义更新 |

## 11. 范围外（下轮候选）

Kanban 列/拖拽形态 · cron / monthly 规则 · paused 恢复队列化 / 状态机改动 · 僵尸 in_progress 自动恢复 · 任务编辑（改标题/描述/目标）· per-agent 并发限制

## 12. 验收标准

1. 用户 / agent 建的任务带目标 + 计划 + 循环规则，看板可见、8 态可筛
2. 会话中发送含 `#T-xxx` 的消息 → 任务在当前会话被激活；slot 有余时 kickoff 即刻出现、agent 开跑
3. 定时任务到点自动进入执行（无需人工介入）
4. 并发上限 N：第 N+1 个任务排队并显示「排队 #N」；前序完成后按序自动放行；并发状态栏真实
5. 循环任务 completed 后自动生成下一实例（pending + 下次时间）；failed / cancelled 停链
6. 重启后 assigned 池自动续跑
7. typecheck 双 clean；上述新增测试全绿
