# 任务看板重构设计(kanban board redesign)

- 日期:2026-09-27
- 状态:已评审(brainstorm 六问 + UI 静态预览 + agent 工具边界均经用户确认)
- 上游依据:`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`(任务执行运行时)、`docs/dev/design-system.md`(v2.1 UI 规范)
- 范围:任务看板全面重构——真看板(列式画板 + 拖拽)、通用分组(泳道)、任务归档

## 0. 背景与目标

现行「看板」实为侧边栏平铺任务列表(TaskSidebarPanel)+ 主区详情面板(TaskDetailPanel),无列结构、无拖拽、无分组、无归档。任务量增长后暴露两类问题:

1. **结构缺失**:任务只有状态筛选一种维度,无法按「研发版本/模块/主题」等用户自定义维度组织;9 个状态在列表里靠徽标扫视,无流程感
2. **数量失控**:终态任务与活跃任务混列,越积越多,没有退场机制

目标:主区改造为真正的任务看板——5 状态列 × 可选分组泳道,卡片拖拽(跨列=状态转换、列内=排序、跨泳道=换组),任务/分组可归档可恢复;agent 工具面同步补全分组信息。

## 1. 需求决策记录(brainstorm 定案)

| # | 决策点 | 定案 |
|---|---|---|
| D1 | 看板列语义 | **状态列(经典 Kanban)**:列=状态分组,跨列拖动=状态转换,与调度系统天然咬合;否决自定义列(与状态机/调度冲突)与纯视图分组(表达不了版本) |
| D2 | 列映射 | **5 列**:待办(draft+pending) · 已分配(assigned+session_queued) · 进行中(in_progress+paused) · 已完成(completed) · 已关闭(failed+cancelled);中间态以卡片徽标表达,不单独成列 |
| D3 | 分组模型 | **单分组**:`task_groups` 表 + tasks.group_id,看板按组渲染横向泳道;通用性来自「组=用户自由命名容器」(版本/模块/主题/客户皆可);否决多标签(泳道归属歧义) |
| D4 | 归档边界 | **仅终态任务可归档**(运行时安全:归档任务保证不被调度器/执行器触碰);**归档分组**=确认后非终态任务自动 cancel 再整组归档(版本收尾一站式) |
| D5 | 列内排序 | **手动排序为看板默认**:tasks 加 board_position(REAL 浮点中值插入);纯视觉,调度排序(priority→scheduled_at→created_at)原封不动 |
| D6 | 布局 | 详情走**右侧滑出抽屉**(~380px,TaskDetailPanel 内容复用);侧边栏改「看板管理面板」(分组管理+归档入口+远端节点只读区保留);筛选上移画板工具栏 |
| D7 | 实现策略 | **@dnd-kit + 乐观更新 + 聚合 `task.move` IPC**:换列语义映射(start/resume/cancel/transition)集中在主进程一处裁决,renderer 只发落点不指定动作 |
| D8 | agent 工具 | **补信息、不给能力**:create_task 加 groupId、新增 list_task_groups、list_tasks/read_task 返回组信息;不开放组管理/归档/排序类工具 |

UI 静态预览(三屏:泳道模式+抽屉、平铺模式+拖拽瞬态、归档面板)已经用户确认,存档于 `.superpowers/brainstorm/61176-1790480617/content/kanban-board.html`(gitignored,仅设计期参考)。

## 2. 数据模型与迁移

迁移沿用 `electron/src/main/storage/migrations/index.ts` 内联 SQL 常量风格(原因见 AGENTS.md:tsc 只输出 .js,外部 .sql 不进 dist)。

```sql
CREATE TABLE task_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,               -- 可空;语义色名('accent'/'success'/'warning'/'violet'…),泳道头色标用
  position REAL NOT NULL,   -- 泳道顺序
  archived_at INTEGER,      -- NULL = 活跃组
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_task_groups_ws ON task_groups(workspace_id);

ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id);
ALTER TABLE tasks ADD COLUMN board_position REAL;   -- NULL = 老任务,列内排尾部按 created_at 兜底
ALTER TABLE tasks ADD COLUMN archived_at INTEGER;   -- NULL = 活跃
CREATE INDEX idx_tasks_ws_archived ON tasks(workspace_id, archived_at);
```

要点:

- **不建独立归档表**:25 字段结构不复製,引用链(消息、会话、变更账本)不断
- ID 复用现有跨模块 ID 生成器单点(实施时对齐既有前缀风格,如 `G-` 系)
- `TaskRow`(electron repo + renderer types.d.ts 两侧)镜像新增 `groupId: string | null`、`boardPosition: number | null`、`archivedAt: number | null`;新增 `GroupRow` 镜像
- **board_position 插入算法**:落点取可见邻居(board 前后卡)的中值 `(prev+next)/2`;列首插入取 `first - gap`、列尾 `last + gap`(gap=1024);相邻中值差 < 1e-9 时对该列一次性重整(等距重写)——单进程 SQLite 单写者,无并发冲突面

## 3. IPC 契约

### 3.1 taskGroup.*(新)

```ts
taskGroup.list(workspaceId: string, opts?: { archived?: 'exclude' | 'only' | 'all' }): Promise<GroupRow[]>
  // 默认 exclude;看板泳道用 exclude,归档面板「恢复整组」用 only
taskGroup.create(input: { workspaceId: string; name: string; color?: string }): Promise<GroupRow>
taskGroup.update(id: string, patch: { name?: string; color?: string }): Promise<GroupRow>
taskGroup.reorder(orderedIds: string[]): Promise<void>
  // 组数量少(个位~十位),直接按入参顺序重写 position 1..N
taskGroup.archive(id: string): Promise<{ cancelledIds: string[]; archivedCount: number }>
  // 单事务:组内非终态任务逐个转 cancelled → 组内全部任务置 archived_at → 组置 archived_at
  // cancelledIds 供 IPC 层对 in_progress 来源补执行中断(abort 是进程级副作用,不入 DB 事务)
  // 任一步失败整体回滚(组与任务都不动)
taskGroup.unarchive(id: string): Promise<GroupRow>
  // 仅组恢复活跃,组内任务保持归档(在归档面板单条/批量/按组捞回)
```

### 3.2 task 面扩展

```ts
task.move(id: string, target: {
  column: BoardColumnKey;        // 目标列(5 列之一)
  groupId: string | null;        // 目标泳道(null = 未分组)
  beforeTaskId?: string;         // 落点前邻居(拖拽时可见邻居)
  afterTaskId?: string;
}): Promise<TaskRow>

task.archive(id: string): Promise<TaskRow>     // 仅终态(isTerminal),否则 Error
task.unarchive(id: string): Promise<TaskRow>   // 清空 archived_at;状态/组/board_position 未动 → 回原列原泳道

task.list(opts): 原参数 + archived?: 'exclude' | 'only' | 'all'   // 默认 'exclude'
```

`task.move` 主进程编排顺序:

1. 读当前行,定位目标列;列未变且组未变 → 纯排序,直接写 board_position 返回
2. 列变化 → 按 §5 语义表执行状态动作(拒绝组合抛 Error,含中文原因)
3. 计算 board_position(可见邻居中值,精度耗尽触发整列重整)
4. 更新 group_id(校验目标组存在且未归档)
5. 返回更新后 TaskRow

### 3.3 契约单源

`BOARD_COLUMNS` 定义在 `renderer/src/ipc/board-columns.ts`(value module 而非 types.d.ts——常量需要运行时值,.d.ts 不产出代码;该目录已被 electron preload 三层相对路径引用,天然双端共享),主进程 move 校验引用同一常量——两侧列语义不可能漂移(momo-boundary-rules:契约单点)。

```ts
export const BOARD_COLUMNS = [
  { key: 'backlog',  label: '待办',   statuses: ['draft', 'pending'] },
  { key: 'assigned', label: '已分配', statuses: ['assigned', 'session_queued'] },
  { key: 'active',   label: '进行中', statuses: ['in_progress', 'paused'] },
  { key: 'done',     label: '已完成', statuses: ['completed'] },
  { key: 'closed',   label: '已关闭', statuses: ['failed', 'cancelled'] },
] as const;
```

## 4. 拖拽语义表(task.move 裁决依据)

行=来源状态,列=落列。「仅列内/换泳道」= 不变状态(排序或换组);✗ = 状态机拒绝(renderer 预判禁投 + 主进程兜底双层防线)。

| from \ 落列 | 待办 | 已分配 | 进行中 | 已完成 | 已关闭 |
|---|---|---|---|---|---|
| draft | 仅列内/换泳道 | transition→assigned(无委派目标则拒,提示先编辑) | ✗ | ✗ | →cancelled |
| pending | 仅列内/换泳道(同列,draft↔pending 互转无拖拽入口) | →assigned + notifyExecutor(手动放行) | ✗ | ✗ | →cancelled |
| assigned / session_queued | ✗ | 仅列内 | **task.start()** 拉起执行会话 | ✗ | task.cancel() |
| in_progress | ✗ | ✗ | 仅列内 | →completed(**先确认**:agent 可能仍在跑) | cancel()(**先确认**:终止运行) |
| paused | ✗ | ✗ | **task.resume()** 断点续跑 | ✗ | cancel() |
| completed / failed / cancelled | ✗ | ✗ | ✗ | 仅列内/换泳道/**可归档**(右键菜单) | 同左 |

关键裁决:

- **待办列只出不进**:状态机不允许任何状态转回 draft/pending;拖悬时该列禁用响应(dnd-kit droppable disabled + 视觉变暗)
- **语义动作在主进程映射**:renderer 只发落点,不指定动作——start/resume/cancel/transition 的调用决策单点收敛在 task.move,防契约漂移(8 个 P0 中 4 个源于契约漂移的教训)
- **两个确认框**(in_progress → 已完成/已关闭):松手时 renderer 弹确认,取消则卡片弹回原位零副作用;确认后才发 IPC
- pending→assigned 手动放行复用 resume() 同款 notifyExecutor 机制触发现有 executor 评估
- 同列跨泳道拖 = 换分组;同列同泳道拖 = 纯排序
- **调度器、findNextAssignedTask、并发徽标计数一概不动**:board_position 纯视觉,调度排序仍是 priority DESC → scheduled_at ASC → created_at ASC

## 5. 看板 UI 结构

### 5.1 组件树

```
TaskBoardView(主区,改造)
├── BoardToolbar
│     新建任务(复用 CreateTaskDialog)/ 搜索 / 指派人筛选
│     分组开关(泳道模式 ↔ 平铺模式)/ 并发徽标(保留现状)/ 归档入口
├── BoardCanvas(DndContext 包裹整个板)
│   ├── Lane × N(泳道模式:活跃组按 position 排 + 「未分组」垫底泳道;平铺模式:单一全任务道)
│   │   ├── LaneHeader — 组名/色标/任务计数/折叠开关/组菜单(重命名·换色·归档组)
│   │   └── Column × 5
│   │       ├── ColumnHeader — 列名 + 卡片数 + 灰字标注合并的底层状态(与 BOARD_COLUMNS 一致)
│   │       └── SortableContext → BoardCard × N
│   └── DragOverlay — 拖拽浮层(微倾跟手卡片,原位留虚线洞)
├── TaskDetailDrawer — 现有 TaskDetailPanel 内容原样复用,外包右侧滑入壳
│                      (~380px;点遮罩/ESC 关闭;selectedTaskId 驱动,已在 task.store)
└── ArchivePanel(overlay)— 归档视图:搜索 + 组/状态过滤 + 单条恢复 + 勾选批量恢复 + 恢复整组

TaskSidebarPanel(侧边栏,改造)
├── GroupManageList — 组列表:新建/重命名/换色/调序/归档/取消归档;点组滚动定位泳道
├── ArchiveEntry    — 打开归档面板(显示归档计数)
└── RemoteTaskSection — 原样保留(P4 只读镜像铁律:远端任务不进本地 tasks 表)
```

TaskList/TaskCard 平铺列表退役(已核实 TaskList 的 3 个调用方全在 TaskSidebarPanel,无外部引用)。

### 5.2 卡片与视觉

- BoardCard 从 TaskCard 派生:独立圆角卡片(bg-surface-2 + border-subtle),保留优先级徽标([高]/[中]/[低])、#短ID·标题、状态徽标、元信息行(agent/日程/循环/委派目标/排队名次)
- 中间态徽标:已分配列卡显「排队中」、进行中列卡显「已暂停」——不占列,复用 task-status.ts 词表
- **平铺模式**下卡片补显所属组 chip(色点+组名);泳道模式下组即道,省略
- 全部走语义 token + lucide-react(16px / stroke 1.75),状态色一律 task-status.ts 单源;ESLint 机械强制(v2.1 设计系统)
- 终态列(已完成/已关闭)卡片右键菜单含「归档」

### 5.3 视图模式

- 默认:有活跃组 → 泳道模式;无组 → 平铺模式;用户手动切换的选择记 localStorage(纯 UI 偏好,不入库)

## 6. 状态管理与数据流

- **新 `renderer/src/stores/group.store.ts`**(zustand):groups + create/update/reorder/archive/unarchive 动作;TaskBoardView mount 时与 task.store.load 并行拉取
- **拖拽乐观更新**:onDragEnd → 快照 tasks → 本地预估变更(状态/组/位置)立即生效 → ipc.task.move → 成功用返回 TaskRow 覆盖;**失败回滚快照 + toast 中文原因**
- **轮询共存**:现有 5s 轮询保留(状态由运行时推进,必须轮询);「手持卡片拖拽中」或「move IPC 未返回」时跳过本轮应用,防列表在手上跳动
- **列组装纯函数 `renderer/src/lib/board.ts`**:columnOf(status) / 泳道分组 / 列内排序(board_position NULLS LAST → created_at 兜底)/ 可见邻居中值 placeBetween——纯函数,单测主战场

## 7. 错误处理

- 非法落点:renderer dragover 预判禁用目标列(禁止光标 + 列变暗);主进程 move 仍权威校验,Error → 回滚 + toast——双层防线
- 两个确认框路径:取消 = 卡片动画弹回原位,零副作用
- 归档非终态任务:IPC 层 isTerminal 校验拒绝,toast「仅终态任务可归档」
- 组归档事务失败:整体回滚(cancelledCount/archivedCount 不落一半)
- IPC 失败路径全部回滚 + toast,保留用户操作上下文;错误路径与空输入必须有专项测试用例(研发红线)

## 8. Agent 工具契约同步(补信息、不给能力)

现有 8 工具(list_delegation_targets / read_task / read_task_history / read_task_progress / create_task / complete_task / fail_task / list_tasks)变更 4 处:

| 工具 | 变更 | 理由 |
|---|---|---|
| `create_task` | 加可选 `groupId` 入参(须为活跃组;不存在/已归档 → Error) | agent 执行组内任务时拆解子任务自动落同组,免用户手动归组 |
| `list_task_groups`(新) | 返回 id/名称/颜色/归档态 | 无发现机制则 groupId 无从获得 |
| `list_tasks` | 加 `groupId` 过滤;返回体附 `groupName` | agent 查组内任务,只回 id 不可读 |
| `read_task` | 返回体加 `groupId`/`groupName` | 分组语境补全 |

**明确不开放**(边界纪律):组的 create/archive/update(组是用户结构性资产,agent 自主建组 = 组列表污染)、task.archive/unarchive(整理动作无执行语义)、board_position 操作(纯视觉)。

**零成本继承**:list_tasks 与 IPC 走同一 repo 层默认排除归档——agent 自动不见归档任务,一致性由 repo 单点保证。

## 9. 迁移与兼容

- 老任务三新列全 NULL → 未分组泳道、列尾排序(created_at 兜底)、活跃状态——开箱即用,零手工处理
- **归档不可见是默认契约**:task.list 默认 exclude,# 菜单(MentionInput)、IM TaskChip、P2P 快照发布、调度器、agent list_tasks 全部自动继承;task.get 不受影响(drawer 深链仍可打开归档任务)
- 调度器与归档天然无交集:归档仅终态,调度按状态捞,终态永不被捞——边界自洽,无需额外防御
- task-tools 的 list_tasks 类型 ListTasksOptions 透传 repo 参数,archived/groupId 过滤随之同步

## 10. 测试策略(momo-test-rules:仿真真实运行时语义)

| 层 | 覆盖 |
|---|---|
| electron 单测 | 迁移测试(老库升列/默认 NULL/索引);**move 语义表逐格断言**(每个 from×列:合法动作调用/拒绝原因;start/resume/cancel 联动按 this 绑定与 ID 唯一性仿真,拒绝「方便测试」的简化 mock);board_position 中值/列首尾/精度重整;归档边界(非终态拒/终态成功/组归档事务含自动 cancel 计数/unarchive 不复活任务);group CRUD/reorder/list archived 三态;repo listTasks archived 过滤 |
| renderer 单测 | lib/board.ts 纯函数(列映射/排序兜底/中值);task.store 乐观更新+失败回滚+轮询跳过窗口;group.store;BoardCanvas 拖拽组件测试(@dnd-kit 官方测试模式:传感器模拟);TaskDetailDrawer/ArchivePanel |
| 一致性 | BOARD_COLUMNS 主进程与 renderer 引用同一常量——无两份定义可漂移 |
| e2e | 拖拽换列冒烟一条(Playwright drag API,可选) |

单元测试位置:electron 集中 `electron/tests/`(镜像 src 结构);renderer 贴源 colocated(与组件同目录)——遵守仓库既有 include 机械强制。

## 11. 非目标(本期明确不做)

WIP 列限制 · 列配置自定义 · 列头快速建卡 · 自动归档策略(如完成 N 天自动归档) · 卡片多标签 · 看板虚拟化 · 跨 workspace 移动任务 · 触屏优化(桌面 Electron)

## 12. 残余风险(明示)

- `task.start()` 默认 `createNewRoom` 行为从拖拽触发——复用现有逻辑;若实际 UX 不符,后续迭代在松手确认框中扩展(不阻塞本期)
- 500 卡无虚拟化的 DOM 压力:React 18 可承受,留观察点,超出再做虚拟化
- 浮点中值重整写入:单列 ≤500 条,量级可忽略
- task.move 单点聚集了语义映射,实现时须以语义表逐格测试锁死(否则单点变单点故障)
