# Agent 模块重构：去编排 + 团队 + 双会话类型 设计文档

- 日期：2026-08-31
- 状态：已确认（界面设计经用户逐屏确认）
- 上游依据：v2.0.0 现行架构 `2026-08-23-v2.0.0-platform-refactor-design.md`；本文档为 agent/会话域的概念模型更换，无旧数据兼容负担（用户明确）

## 1. 背景与目标

现行 agent 模型以「编排」为中心：definition（身份）→ assignment 实例（role=standalone/main/sub + parentInstanceId 父子链）。该模型与实际使用不符：编排概念重、创建流程角色心智负担大、团队会话（workspace.teamSessionId）半成品。

新模型一句话：**agent 全局化 + 工作空间成员制（无角色）+ 团队（leader+成员）替代编排 + 会话双类型（快速/协作）**。

目标：

1. agent 创建无角色概念、名称自定义
2. 每个工作空间可指定唯一「默认会话 agent」支撑快速会话
3. 团队 = ws 内多 agent 分组，leader 自动获得对成员的调度权（dispatch）
4. 会话分「快速会话」（免弹窗直达默认 agent、动态命名）与「协作会话」（指定单 agent 或团队）；团队会话概念退役
5. 所有界面经用户确认（已完成：双 Tab、双按钮入口、三弹窗形态）

非目标：P2P 协议变更（agent 定义 JSON 结构不变）、任务看板/task_execution 会话语义变更、能力三层配置模型变更（仅挂载点从 assignment 平移到成员）。

## 2. 需求澄清决策记录

| # | 问题 | 决策 |
|---|---|---|
| D1 | agent 与 ws 关系 | 全局 agent 为主，按需加入 ws（membership 层保留、角色退役） |
| D2 | 默认会话 agent 指定 | 三入口：创建表单勾选 + 成员列表「设为默认」+ 未设置时快速会话弹一次性选择 |
| D3 | 团队变更对已建会话 | 创建时快照（session_members 展开），团队编辑不回溯 |
| D4 | 快速会话命名 | 首条消息截断（前 20 字符）占位 + 接待 agent 首次回复完成后 LLM 异步生成标题替换（失败静默保持截断名）；用户手动改名后 LLM 不再覆盖 |
| D5 | 团队协作会话接待语义 | 非 @ 消息 leader 接待并自主 dispatch；@ 成员则该成员直接响应 |
| D6 | 单 agent / 快速会话接待 | 唯一 agent 默认接待，无需 @ |
| D7 | 架构方案 | A：干净重构（membership 新表替换 assignment，role/parent 从 schema 消失） |

## 3. 数据模型（migration v25）

### 3.1 `agent_assignments` 退役 → `workspace_agent_members`

```sql
CREATE TABLE workspace_agent_members (
  instance_id         TEXT PRIMARY KEY,      -- 原样继承 assignment 的 instance_id
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_user_id       TEXT NOT NULL,         -- 会话消息 sender 标识
  api_key_override    INTEGER NOT NULL DEFAULT 0,
  last_running        INTEGER NOT NULL DEFAULT 1,  -- 在线语义权威源
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wam_unique ON workspace_agent_members(workspace_id, agent_definition_id);
```

- 无 role / parent_instance_id 列。同一 agent 每 ws 仅一份（新约束，重复添加报错）。
- 迁移按 instance_id 原样搬运，session_members 外键 / keychain 槽位 / 运行态引用无缝；role/parent 数据丢弃。

### 3.2 团队（ws 级）

```sql
CREATE TABLE teams (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  icon_emoji         TEXT NOT NULL DEFAULT '👥',
  leader_instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL
);
CREATE TABLE team_members (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (team_id, instance_id)
);
```

leader 必须同时在 team_members 中（建团/换 leader 同事务保证）。

### 3.3 `workspaces` / `sessions` 变更

- `workspaces.default_agent_instance_id` 新增（nullable，FK → workspace_agent_members）；`coordinator_instance_id` / `team_session_id` 退役
- `sessions.title_auto INTEGER NOT NULL DEFAULT 0`（1=自动命名，可被 LLM 替换；0=用户命名/已手动改名）
- `session_members.is_leader INTEGER NOT NULL DEFAULT 0`（快照记 leader，接待判定依据）
- `session_members` FK 改指 workspace_agent_members（SQLite 改 FK 需重建表：新建+搬运+换名，事务内）
- `sessions.kind` 保留 `chat | task_execution` 不动；快速/协作是创建方式差异，不进枚举

### 3.4 `agent_definitions` 全局化

`workspace_id` 列退役（agent 定义恒全局）。自定义 agent 创建即全局，ws 按需加入。

### 3.5 默认 agent 初始化迁移

`default_agent_instance_id` ← 原 `coordinator_instance_id`（语义最近，升级后快速会话开箱可用；无对应值为 NULL）。

## 4. 后端服务层

### 4.1 membership CRUD（重构 `agent/crud.ts`）

- `addMember(workspaceId, agentDefinitionId, agentUserId, apiKeyOverride?)`；重复添加报错
- `removeMember(instanceId)`：**leader 守卫**——是任一团队的 leader 则拒绝（返回 blocked + 团队名）；非 leader 直接移除（团队级联退出，已建会话快照不受影响）
- `listMembers(workspaceId)`、能力 Layer3 deltas、API key override、start/stop、lastRunning 语义平移
- 删除：`updateAssignmentRole`、循环引用校验、`assignMain` 自动跟注

### 4.2 团队服务（新 `agent/team.ts`）

- `createTeam(workspaceId, name, iconEmoji, memberInstanceIds, leaderInstanceId)`：单事务，leader 必须在成员集内；成员数 ≥2（leader + ≥1 子）
- `renameTeam` / `setLeader` / `addTeamMember` / `removeTeamMember`（leader 走守卫）/ `deleteTeam`（不动成员与已建会话）

### 4.3 默认会话 agent

`setDefaultAgent(workspaceId, instanceId | null)`；随 workspace:get 返回；成员移除命中 default → 置 NULL。

### 4.4 会话创建（`im/session-ops.ts` 扩展）

- `createQuickSession(workspaceId)`：无 default → 结构化错误（UI 转引导）；有 → kind=chat、title=「新会话」、title_auto=1、单成员 is_leader=1
- `createCollabSession(workspaceId, title?, target)`：target = `{type:'agent', instanceId}` 或 `{type:'team', teamId}`
  - 单 agent：单成员 is_leader=1
  - 团队：当前成员展开快照写入 session_members，leader 成员 is_leader=1
  - title 留空 → title_auto=1（动态命名）；用户命名 → title_auto=0

### 4.5 命名服务（新 `im/session-naming.ts`）

- 首条用户消息落库后：title 仍为占位 → rename 为首条消息前 20 字符（去换行）
- 接待 agent 首次回复 `final` 后：fire-and-forget 用该 agent 的 provider/model 发极简 prompt（生成 ≤12 字标题）；成功且 title_auto=1 且用户未手动改名 → rename；失败静默
- 竞态锁：rename 条件带 title_auto=1 检查；用户手动改名置 title_auto=0

### 4.6 接待路由（RouterService）

- 非 @ 消息 → 会话内 `is_leader=1` 成员接待（快速/单 agent 会话唯一成员即 leader）
- @ 成员 → 该成员直接响应，leader 不插嘴（沿用，实例引用换表）
- coordinatorInstanceId 引用全部切到会话内 leader 判定
- 目标成员离线时自动拉起（fire-and-forget start 后派发）

### 4.7 运行时 spawn

- dispatch 工具注入条件：`role==='main'` → 「本会话成员数 >1 且自己是 leader」
- `subAgents` 来源：parent 链 → 当前 session_members 快照（除自己）
- WarmPool / AgentRunner / task-reply 事件桥不动（只认 instance_id）

## 5. IPC 面 + 类型契约

退役：`agent:addToWorkspace`（→ `agent:addMember`）、`agent:removeAssignment`（→ `agent:removeMember`）、`agent:updateAssignmentRole` / `agent:assignMain`（消失）、`agent:listAssignments`（→ `agent:listMembers`）、`workspace:setCoordinator`（→ `workspace:setDefaultAgent`）、泛化 `session:create`（→ `session:createQuick` / `session:createCollab`）。

新增：`team:list/create/rename/delete/setLeader/addMember/removeMember`、`agent:setMemberDeltas / setMemberApiKeyOverride`（原 assignment 系列平移更名）。

类型：`AgentRole` 删除；`AgentAssignment` → `WorkspaceAgentMember`（去 role/parent）；新增 `Team`；`SessionMemberInfo.role` → `isLeader`；`SessionRow/Summary` 加 `titleAuto`；`AddToWorkspaceInput` → `AddMemberInput`；`assignmentId` 字样统一改 `instanceId`（含 `mentionedAssignmentIds` → `mentionedInstanceIds`）。双 workspace typecheck 锁对齐。

## 6. 界面设计（已逐屏确认）

1. **AgentsView 双 Tab**：「Agent 成员」/「团队」。成员行：icon + 名称 + ⭐默认会话标记 + 在线状态 + 行内操作（启动/停止、设为默认、调整能力、API key、移出）。团队 Tab：团队卡片（icon + 名称 + 👑leader 标记 + 成员 chips + 编辑/删除）+ 新建团队
2. **会话入口双常驻按钮**：侧边栏头部 `⚡`（快速）+ `👥`（协作）；⚡ 一键直达（无默认 agent 时弹一次性选择）。会话列表项图标语义派生、不持久化创建方式：单成员会话显示该 agent 的 emoji；多成员会话显示成员 icon 组（leader 带 👑 前缀）
3. **创建 Agent 弹窗**：名称*、图标、模型服务*、提示词、默认工具集（安全最小集/全部/自选）、「设为默认会话 agent」勾选（已有默认提示替换）；Agent 管理 Tab 创建 → 自动加入当前 ws；资源库入口创建 → 纯全局
4. **创建/编辑团队弹窗**：图标+名称*、成员勾选（≥2）、leader 从已勾选中单选（未勾选时禁用）
5. **创建协作会话弹窗**：名称（留空动态命名）、「单个 agent / 团队」页签单选目标

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 快速会话无默认 agent | 一次性选择弹窗（选成员设默认并继续）；ws 无成员 → 引导去 Agent 管理 |
| 默认 agent 被移出/删除 | default 置 NULL；进行中快速会话不受影响（快照） |
| 移除团队 leader | blocked + 团队名列表，提示先解散或转移 |
| 删除团队 | 仅删定义；已建会话快照无感 |
| 会话成员失效（被移出 ws） | 新消息不派发失效成员；全部失效 → 会话只读（历史可看，输入禁用） |
| 目标成员离线 | 自动拉起后派发 |
| LLM 命名失败/超时 | 静默保持截断名 |
| 团队编辑 | 不回溯旧会话；新会话用新成员集 |

## 8. 测试策略

- 迁移：v25 搬运正确性（instance_id 无缝、FK 重建引用不断、coordinator→default、role/parent 确实丢弃）
- 服务层：membership（unique/leader 守卫/默认置空）、team（建团事务/leader 必在集/换 leader）、会话创建（quick 无默认结构化错误、团队快照展开+is_leader+title_auto）
- 命名服务：截断规则、LLM 失败静默、title_auto=0 不覆盖（竞态专项）
- 路由：非 @ → leader；@ 直答；失效成员过滤；全失效只读
- runtime：dispatch 注入条件（成员>1 且 leader）、subAgents 来自快照（契约测试）
- IPC：退役通道零残留（grep 锁）、双端 typecheck
- UI：双 Tab、三弹窗校验提交、快速会话免弹窗直达、无默认引导弹窗

## 9. 实施切分建议（供 writing-plans 展开)

1. migration v25 + 类型层（membership/team/默认 agent/会话字段）
2. membership + team + 默认 agent 服务层与 IPC
3. 会话创建双流程 + 命名服务 + 路由改造（leader 接待/自动拉起）
4. runtime dispatch 条件切换 + spawn 快照
5. renderer：AgentsView 双 Tab + 三弹窗 + 会话入口 + 列表图标
6. 清理退役代码（编排视图/协调链路/teamSessionId）+ 全量回归
