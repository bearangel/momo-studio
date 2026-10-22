# 2026-10-22 会话体验优化设计（类型图标 / 置顶 / 分组 / 多选建会 / agent 能力展示）

- 状态：设计已评审通过（方案四轴 + 设计五节均获用户确认），待 spec 审阅
- 上游诉求（六项）：
  1. 不同会话类型使用不同图标标记
  2. 会话支持置顶（全局顶置）
  3. 会话支持分组（手动分组）
  4. 创建协作会话时 agent 从单选改多选；所选 >1 时指定一个主 agent
  5. agent 列表提供描述
  6. agent 能力（MCP / 工具 / 技能）的友好展示
- 关联文档：
  - `docs/specs/2026-08-31-agent-team-session-redesign.md`（v25 会话/团队域现行设计，`session_members.is_leader` 快照语义以此为准）
  - `docs/dev/design-system.md`（UI 设计系统，语义 token / lucide 16px stroke 1.75）
  - `docs/dev/rules/engineering.md`（研发红线）

## 1. 背景与现状要点（探索结论）

- `sessions` 表无「快速/协作」区分：`kind` 只有 `chat | task_execution`；快速会话与「单 agent 协作会话」结构同形（单成员 + `is_leader=1`），**运行时推断永远无法正确区分**——类型必须落库。
- 会话列表排序键 = `COALESCE(last_message_at, created_at) DESC`，契约单点在主进程 `storage/sessions/repo.ts`；renderer `receiveMessage` 只做「上浮」不做全量 sort。
- 协作会话创建：`CollabSessionDialog` 单选一个 agent 或一个团队（`CollabTarget = { type:'agent' } | { type:'team' }`）；团队展开为成员快照写入 `session_members`，leader 落 `is_leader`。
- `RoomList` 在 v2.2 曾按用户要求移除会话项全部图标（成员 emoji / Crown / +N 等下线）——**本次类型图标必须克制**：每项至多一个类型图标 + 一个置顶标记。
- agent 定义已含 `description / defaultTools / defaultMcps / defaultSkills / deniedTools`；`capability-merger.mergeCapabilities`（Layer1 def ∪ Layer2 workspace 分配 ± Layer3 成员 delta）与 spawn 同源。
- renderer 原子件：Badge / Tooltip（单行纯文本）/ Dialog / Input / Button / Avatar / EmptyState；**无 Popover/DropdownMenu**——能力展示避开浮层方案。
- 任务看板已有成熟 `taskGroup` CRUD + `(i+1)*1024` position 重排契约（`group.store.ts` 镜像），会话分组照此模式实现。
- 迁移最新版本 066（独立模块 0NN_*.ts 注册制，内联 SQL 常量），本设计新增 **067**（`067_session_groups_pin_type.ts`）。

## 2. 非目标（out of scope）

- 组间拖拽排序（`position` 列预留，UI 后续可加）。
- 建会后修改 leader（`is_leader` 是建会快照，接待判定依据，语义不变）。
- 智能体页 MembersPanel 卡片补能力徽标（首版可选后续项）。
- hover 富 popover、独立 agent 档案抽屉（首版不做；展开区清单过长时再评估档案 Dialog）。
- 自动分组（按时间/类型/agent 聚类）。
- 会话跨分组多属（一会话至多属于一个分组）。

## 3. 数据模型与迁移（067）

```sql
-- migration 067（独立模块 067_session_groups_pin_type.ts，与 032-066 同机制）
CREATE TABLE session_groups (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,   -- (i+1)*1024 步进，镜像 task_groups
  created_at   INTEGER NOT NULL
);
ALTER TABLE sessions ADD COLUMN pinned_at INTEGER NULL;      -- 非空即置顶，值=置顶时间戳
ALTER TABLE sessions ADD COLUMN group_id TEXT NULL REFERENCES session_groups(id);
ALTER TABLE sessions ADD COLUMN session_type TEXT NULL;      -- 'quick' | 'collab' | NULL
-- 存量回填（仅 chat 行；task_execution 行保持 NULL 由 kind 判定）
UPDATE sessions SET session_type =
  CASE WHEN (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = sessions.id) > 1
  THEN 'collab' ELSE 'quick' END
WHERE kind = 'chat';
```

### 3.1 `session_type` 写入定型矩阵

| 创建路径 | session_type | 说明 |
|---|---|---|
| `createQuickSession` | `'quick'` | 快速会话 |
| `createCollabSession`（三种 target 形态） | `'collab'` | 协作会话 |
| `createSession` 泛化（task dispatcher 等） | 不写（NULL） | 图标按 `kind` 判定 |

渲染判定顺序：`kind === 'task_execution'` → 任务图标；否则读 `session_type`；NULL 兜底按成员数推断（>1 → 协作）——仅防御旧库/异常数据。

### 3.2 契约扩展（两端同步）

- `SessionRow`（electron repo + renderer `types.d.ts` 镜像）：加 `pinnedAt: number | null`、`groupId: string | null`、`sessionType: 'quick' | 'collab' | null`。
- `SessionSummary`：在 SessionRow 扩展之上加 `groupName: string | null`（JOIN 带出，免二次查询）。
- 修改 IPC 接口后 electron / renderer 两个 workspace 都要 typecheck（preload 三层 `../../../` 引用 `types.d.ts`）。

## 4. 会话列表（RoomList）

### 4.1 排序契约（主进程 SQL 单点）

```sql
SELECT s.*, g.name AS group_name, g.position AS group_position
FROM sessions s
LEFT JOIN session_groups g ON g.id = s.group_id
WHERE s.workspace_id = ?
ORDER BY
  (s.pinned_at IS NULL) ASC,               -- 置顶区在前（0=置顶）
  s.pinned_at DESC,                         -- 置顶区内：后置顶在上（重置顶=手动上浮）
  (g.position IS NULL) ASC,                 -- 非置顶：有组在前、未分组殿后
  g.position ASC,
  g.created_at ASC,                         -- 组间同 position 按建组时间
  COALESCE(s.last_message_at, s.created_at) DESC,
  s.created_at DESC
```

- repo 提供该 JOIN 查询供 SessionSummary 组装消费；`listAllSessions` 同步换同源 ORDER BY（排序契约唯一性）。
- 置顶区语义（微信式全局顶置）：置顶项脱离原分组位置固定列表最上，**置顶区内顺序由置顶时间决定**（新消息不改变置顶区内部顺序；重置顶可上浮）；置顶项上显示所属分组小标识（groupName 非空时以 title 提示，避免视觉噪音）。
- `pinned_at` 与 `group_id` 相互独立：置顶不清分组，取消置顶回落原分组位置。
- repo 层新函数：`setSessionPinned(id, pinned: boolean)`（置顶 = `Date.now()`，取消 = NULL）、`setSessionGroup(id, groupId: string | null)`；两者与 `renameSession` 同习惯更新 `updated_at`。
- `session_groups` CRUD：`insertSessionGroup`（position = max+1024）、`renameSessionGroup`、`deleteSessionGroup`（**事务**：`UPDATE sessions SET group_id = NULL WHERE group_id = ?` → 删组行）、`listSessionGroups(workspaceId)`（`ORDER BY position ASC, created_at ASC`）。

### 4.2 receiveMessage 桶内上浮（session.store 演进）

现有「只上浮、禁全量 sort」约束保留并细化：

- 会话**置顶**：收到新消息只原地更新 `lastMessageAt`，不移动位置。
- 会话**非置顶**：移动到所属桶（其分组内 / 未分组区）顶部；不得越过置顶区、不得越组。

### 4.3 类型图标（克制原则）

- 标题左侧一个 14px / stroke 1.75 / `text-tertiary` 图标：快速 `Zap`、协作 `Users`（与 SessionSidebarHeader 创建按钮同款，认知映射）、任务执行 `ListTodo`。
- 置顶标记：标题右侧 10px `Pin`（`text-tertiary`）。
- 除以上两个标记外不渲染任何其他图标（遵守 v2.2 移除图标的用户约束）。

### 4.4 交互入口

- 会话项 hover 工具条（现有 Pencil/Trash2 前插入两钮，共 4 钮，12px）：
  - `Pin` / `PinOff`：置顶切换（`session:setPinned`）。
  - `FolderInput`：打开「移动到分组」弹窗（`session:moveToGroup`）。
- 搜索框旁 `FolderPlus`（14px）：新建分组（PromptDialog 复用，输入组名）。
- 组头：`ChevronDown/ChevronRight` 折叠开关 + 组名 + `(n)` 计数；hover 出 `Pencil`（重命名，PromptDialog）与 `Trash2`（删除组，ConfirmDialog——**只删组，组内会话回落未分组，不删会话**，文案明示）。空组保留显示（计数 0）。
- 「移动到分组」弹窗：复用 Dialog 原子件——分组列表单选 + 内联「新建分组」输入行 + 「移出分组」选项（radio 选「未分组」）。
- 折叠态持久化：localStorage，键 `momo.sessionGroups.collapsed.<workspaceId>`（值：折叠组 id 集合 JSON）；切 workspace 不互相影响。

### 4.5 搜索态

过滤非空时分组结构拍平，纯匹配列表（保持现行为）：不渲染组头与置顶区结构，但匹配的置顶/分组会话照常显示（含类型图标与 Pin 标记），顺序仍按主进程全局序。

## 5. 协作会话创建（多选 + 主 agent）

### 5.1 CollabTarget 第三态

```typescript
export type CollabTarget =
  | { type: 'agent'; instanceId: string }                                  // 保留兼容
  | { type: 'team'; teamId: string }                                       // 保留
  | { type: 'members'; instanceIds: string[]; leaderInstanceId: string };  // 新增
```

### 5.2 主进程校验与写入（createCollabSession 扩展）

`{ type: 'members' }` 分支：

- 校验（全部中文 Error.message，走既有 IPC error 通道）：
  - `instanceIds` 非空、去重后无重复（重复直接去重容错，不报错）；
  - `leaderInstanceId ∈ instanceIds`（否则「主 agent 必须是所选成员之一」）；
  - 所有 instanceId 均为该 workspace 有效成员（否则「成员不存在或不属于当前工作空间：<instanceId>」）。
- 写入：逐成员 `addSessionMember`（leader `is_leader=1`，其余 0），复用既有事务核心 `insertSessionWithMembers`；`session_type='collab'`、`kind='chat'`。
- **不落 teams 表**（建会时临时组队；session_members 快照本就是单一真相源）。
- 团队分支同时补写 `session_type='collab'`（与 members/agent 分支一致）。

### 5.3 对话框交互（CollabSessionDialog）

- agent 页签：radio → **checkbox 多选**；页签改名「单个 agent」→「选择成员」、「团队」→「选择团队」（多选化后旧名不符业务，预览 B rev2 批准）；行升级为卡片行（见 §6.2）。
- 选中 1 个：等价现状（自动 leader，无额外 UI）。
- 选中 >1（预览 B rev2 批准交互）：**Crown 为 12px 状态徽标**（紧随当前 leader 名称，accent 色，title=「主 agent：负责接待用户输入与任务分派」，非交互）——指定动作改为**每张已选卡底部「主 agent」radio 行**（radio + 文字标签，互斥单选，可发现性优先）；卡片列表上方引导文案「已选 N 个成员——指定一名主 agent 负责接待与任务分派」（tertiary 12px）；默认主 agent = 第一个选中者，可改。
- 取消选中当前主 agent 时，主 agent 自动回落到剩余选中项的第一个（保持不变量：选中 >1 时必有唯一主 agent）。
- 提交：统一发 `{ type: 'members', instanceIds, leaderInstanceId }`（单选也走此形态）；`'agent'` / `'team'` 形态在 IPC 契约中保留兼容。
- 团队页签原样保留（含 Crown leader 展示与成员数）。

## 6. agent 描述与能力展示

### 6.1 新只读 IPC：`agent:getEffectiveCapabilities`

```typescript
// 入参：instanceIds: string[]
// 返回：Record<instanceId, { tools: string[]; mcps: string[]; skills: string[]; deniedTools: string[] }>
```

- 主进程逐成员：`getAgentDefinition(member.agentDefinitionId)` + `readAllocationLayer(member.workspaceId)` + `readAssignmentDeltas(instanceId)` → `mergeCapabilities`——**与 spawn 同源**，保证「展示 = 实际能用」，合并逻辑单点不漂移（boundary 规则）。
- 成员不存在 → 该条目省略（renderer 对缺失条目降级为 def 级徽标，见 6.3）。

### 6.2 选择器卡片行合同（三个弹窗统一）

对齐 MembersPanel 卡片定值合同（2026-10-22 预览批准版）：

- 结构：icon（iconEmoji / Avatar bot 兜底）+ 名称 + **描述两行截断**（`line-clamp-2`，整行 title 全文；空 → 「暂无说明」斜体占位）+ **能力摘要徽标行** + 原有元信息（在线态 / source 徽标）。
- 能力徽标：`Wrench n · Server n · Sparkles n`——Badge（tone=neutral，11px 图标 + 计数），title 提示「内置工具 n / MCP 服务器 n / 技能 n」；**计数为 0 的分类不渲染**。
- 生效计数：tools 剔除 deniedTools 命中的插件工具（复用 renderer `capability-helpers.deniedMatch`）。
- 覆盖面：`CollabSessionDialog`、`DefaultAgentPickerDialog`（两者从零补描述）、`AddAgentDialog`（已有单行描述，统一为两行合同）。三处**抽共享组件 `AgentPickerCard`**（选择器卡片行 + 展开态），防三份实现漂移；仅元信息位（在线态 / source 徽标 / 「加入」按钮）由各弹窗以插槽传入。
- 「已启用、未加入本工作空间」的 def（无 instanceId）：徽标用 def 级 `defaultTools/defaultMcps/defaultSkills` 计数，title 标注「默认能力（加入后按工作空间合并生效）」。

### 6.3 能力展开区

- 点击徽标行原地展开（同卡片内，无浮层）：三区——「内置工具 / MCP 服务器 / 技能」，各列名称 chip（`bg-surface-2` 小圆角）；被 deniedTools 命中的插件工具灰显 + 删除线。
- 再次点击收起；对话框内同时只展开一行（accordion 单开）。
- 名称直接展示 ref 字符串（已是人读名）。

## 7. IPC 契约变更清单

| 通道 | 入参 | 返回 | 备注 |
|---|---|---|---|
| `session:setPinned` | `(sessionId, pinned: boolean)` | `void` | 置顶=Date.now()，取消=NULL |
| `session:moveToGroup` | `(sessionId, groupId: string \| null)` | `void` | null=移出分组；校验组属同 workspace |
| `sessionGroup:list` | `(workspaceId)` | `SessionGroupRow[]` | position ASC, created_at ASC |
| `sessionGroup:create` | `(workspaceId, name)` | `SessionGroupRow` | position=max+1024；空名报错 |
| `sessionGroup:rename` | `(groupId, name)` | `void` | |
| `sessionGroup:delete` | `(groupId)` | `void` | 事务：组内会话回落未分组 |
| `agent:getEffectiveCapabilities` | `(instanceIds: string[])` | `Record<string, MergedCapabilities>` | §6.1 |
| `session:createCollab` 入参扩展 | `CollabTarget` 增 members 态 | `SessionSummary` | §5.1 |

- `SessionSummary` / `SessionRow` / `CollabTarget` / `SessionGroupRow` 类型变更在 `renderer/src/ipc/types.d.ts` 与 electron 端镜像同步；preload 桥接补通道；**两 workspace typecheck**。
- `session-tools.executeListSessions` 输出行补 `[type]`（quick/collab/task_execution，agent 可读）。

## 8. 消费面矩阵

| 新增/变更面 | 消费方 | 处置 |
|---|---|---|
| `sessions.pinned_at` | 排序 SQL、RoomList Pin 标记、session.store 桶内上浮判定 | 新增消费 |
| `sessions.group_id` + `session_groups` | 排序 SQL、RoomList 分桶/组头、sessionGroup IPC | 新增消费 |
| `sessions.session_type` | RoomList 图标、session-tools 输出、**P5 旧库只读导出路径** | 导出走显式列则零影响，实施时核对确认 |
| `SessionSummary` 扩展字段 | types.d.ts 镜像、session.store、RoomList | 契约两端同步 |
| `CollabTarget` members 态 | types.d.ts、session-ops、CollabSessionDialog、preload | 兼容保留旧两态 |
| `getEffectiveCapabilities` | 三选择器徽标、capability-helpers deniedMatch | 新增 |
| `def.description` 展示 | Collab / DefaultAgent / AddAgent 三弹窗 | AddAgent 统一为两行合同 |

## 9. 测试计划

electron（`electron/tests/` 镜像目录；DB 重度目录 `--pool=forks`）：

- `tests/storage/migration-067-session-groups.test.ts`（模式照抄 migration-047：`applyUpTo(db, 66)` 构造旧库 → 生产注册路径取 067 → 应用断言）：建表、存量回填推断（多成员→collab、单成员→quick、task_execution→NULL）、重复执行幂等。
- `tests/storage/sessions/list-order.test.ts`：排序契约——置顶区 > 分组（position 序）> 未分组 > 组内活跃时间；置顶区内部 pinned_at DESC。
- `tests/im/collab-members-target.test.ts`：members 三态——leader 落库 `is_leader=1`、其余 0；空列表 / leader 不在集合 / 跨 workspace 成员 → 中文错误；`session_type='collab'` 落库。
- `tests/agent/effective-capabilities.test.ts`：与 `mergeCapabilities` 同源（三层合并生效）、批量、未知 instanceId 省略。
- `tests/im/session-group-crud.test.ts`：delete 组事务（会话 group_id 回落 NULL、组行删除）；create position 步进。

renderer（贴源 colocated）：

- `session.store.test.ts`：receiveMessage——置顶会话原地更新不移动；非置顶桶内上浮不越置顶区、不越组。
- `RoomList.test.tsx`：分桶渲染（置顶区/组头/未分组）、组折叠、过滤拍平、类型图标三态、Pin 标记、hover 工具条四钮。
- `CollabSessionDialog.test.tsx`：多选切换、选中 1 隐藏 Crown / >1 显示、leader 切换唯一高亮、提交 payload 为 members 形态。
- `AgentPickerCard.test.tsx`（共享组件）：徽标 0 分类不渲染、展开三区 chip、denied 灰显删除线、描述两行截断与空占位、选中态与 Crown 插槽。
- 「移动到分组」弹窗：单选 + 新建分组内联 + 移出分组。

## 10. 实施分期与门禁

- **Phase 1（#1 #2 #3）**：067 迁移 + repo（JOIN 排序/pin/group CRUD）+ IPC + preload/types 同步 + session.store 演进 + RoomList UI（图标/置顶/分组/移动弹窗）。
- **Phase 2（#4）**：CollabTarget members 态 + 主进程校验 + CollabSessionDialog 多选 + Crown 主 agent。
- **Phase 3（#5 #6）**：getEffectiveCapabilities IPC + 三选择器卡片化（描述 + 徽标 + 展开）。Phase 3 落地后 Phase 2 弹窗同步获得能力徽标。
- **门禁**：
  - RoomList 分组化与选择器卡片化均为 **P1 布局/新形态变更**——按 `momo-ui-preview-rules` 先出静态预览（`.omo/previews/session-list-groups.html`、`.omo/previews/agent-picker-cards.html`，多选 + leader 交互形态并入后者）获批准后实现。
  - IPC / 契约变更按 `momo-boundary-rules`（两端类型同步、生产者先行验证）。
  - 测试按 `momo-test-rules`（回归锁仿真真实运行时语义，禁「方便测试」的 mock 简化）。
  - 版本号：合入大特性仅 alpha +1（`docs/dev/release.md` 研发期策略）。

## 11. 风险与权衡记录

- **session_type 落库而非推断**：单 agent 协作会话与快速会话结构同形，推断必错；存量一次性回填是唯一推断场景，此后由创建路径定型。
- **置顶区顺序 = 置顶时间**（非活跃时间）：SQL 简单且 renderer 上浮规则统一（置顶不移动）；用户可通过重置顶手动上浮。放弃「置顶区内按活跃时间」的 CASE 混合排序（SQL 脆弱）与 renderer 分桶重排（违反主进程排序单点契约）。
- **能力展示走主进程合并**而非 renderer 端自行组装：防三层合并逻辑双端漂移（boundary 规则）。
- **多选建会不落 teams**：临时组队落 `session_members` 快照即达语义；落 teams 会污染团队列表并引入隐藏标记复杂度。
- **无 Popover 组件**：徽标 + 原地展开规避浮层定位成本与 dialog 内误触。
