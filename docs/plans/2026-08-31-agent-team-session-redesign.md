# Agent 模块重构实施计划（去编排 / 团队 / 双会话类型）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/specs/2026-08-31-agent-team-session-redesign.md` 落地 agent 概念模型更换：membership 无角色 + 团队 leader 调度 + 快速/协作双会话。

**Architecture:** 单次 migration v25 完成 schema 变形（assignments→members 换表搬运、teams 新表、sessions/workspaces 加列）；服务层沿 instance_id 无缝平移；路由与 runtime 的「角色」判定全部替换为「会话内 is_leader 快照」；renderer 重构 AgentsView 与会话入口。无旧数据兼容负担。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React + zustand + Vite、vitest 双 workspace、Playwright e2e。

## Global Constraints

- Node 20 LTS（容器默认 26 必须先 `nvm use 20`）；包管理 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`
- 所有代码注释与文档中文；标识符英文
- Conventional Commits：`feat:` / `test:` / `refactor:` / `chore:` / `docs:`
- 单测位置铁律：electron 集中 `electron/tests/**`（镜像 src 结构）；renderer 贴源 `src/**/*.test.{ts,tsx}`——vitest include 机械强制，放错不执行
- 每个 Task 收尾必须：`npx pnpm@9.0.0 typecheck` 双 clean + 本 Task 测试绿，才可 commit
- 提交信息与迁移注释引用 spec 节号（§N）
- 退役概念词全清：`role`/`standalone`/`parentInstanceId`/`coordinator`/`teamSessionId`/`编排` 在代码与 IPC 面不得残留（Task 15 grep 锁验收）

---

### Task 1: migration v25——schema 变形

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（在 version 24 后追加 v25）
- Test: Create `electron/tests/storage/migration-v25.test.ts`

**Interfaces:**
- Produces: 表 `workspace_agent_members` / `teams` / `team_members`；列 `workspaces.default_agent_instance_id`、`sessions.title_auto`、`session_members.is_leader`；`agent_assignments` / `agent_definitions.workspace_id` / `workspaces.coordinator_instance_id` / `workspaces.team_session_id` 消失

- [ ] **Step 1: 写失败测试**（沿用现有迁移测试模式——内存库逐版本升到 v25 后断言结构）

```ts
// electron/tests/storage/migration-v25.test.ts
import { describe, it, expect } from 'vitest';
import { runMigrationsOn } from '../../src/main/storage/migrations'; // 若无此导出，按现有 db.test.ts 的迁移入口仿写

describe('migration v25：去编排 + 团队 schema', () => {
  it('workspace_agent_members 存在且无 role/parent 列', async () => {
    const db = await buildMigratedDb();
    const cols = db.prepare('PRAGMA table_info(workspace_agent_members)').all()
      .map((c: { name: string }) => c.name);
    expect(cols).toContain('instance_id'); expect(cols).toContain('agent_user_id');
    expect(cols).not.toContain('role'); expect(cols).not.toContain('parent_instance_id');
    expect(db.prepare('SELECT name FROM sqlite_master WHERE name=? AND type=?').get('agent_assignments', 'table')).toBeUndefined();
  });
  it('assignments 数据按 instance_id 原样搬入 members（role 丢弃）', async () => {
    const db = await buildMigratedDbWithAssignmentFixture(); // 预置 v24 库插入一条 assignment 再升 v25
    const row = db.prepare('SELECT * FROM workspace_agent_members WHERE instance_id=?').get('inst-1') as Record<string, unknown>;
    expect(row['agent_definition_id']).toBe('def-1');
    expect(db.prepare('SELECT COUNT(*) c FROM workspace_agent_members').get()).toMatchObject({ c: 1 });
  });
  it('teams/team_members/default_agent/title_auto/is_leader 就位', async () => { /* 同上 PRAGMA + 列断言 */ });
  it('coordinator_instance_id 迁移到 default_agent_instance_id', async () => { /* 预置 coordinator 值 → 升级 → 断言 default 相等且原列消失 */ });
  it('重复 assignment（同 ws 同 def）去重保留最早一条', async () => { /* 预置两条 → 升级 → 断言剩 1 条且 created_at 最早 */ });
});
```

- [ ] **Step 2: 跑测试确认失败**：`cd electron && npx vitest run tests/storage/migration-v25.test.ts` → FAIL（无 v25）
- [ ] **Step 3: 实现 v25**（追加到 migrations 数组，SQL 全文如下）

```sql
-- ─── v25：agent 概念模型更换（spec 2026-08-31 §3）─────────────────────────
-- 去编排：agent_assignments → workspace_agent_members（无 role/parent）
CREATE TABLE workspace_agent_members (
  instance_id         TEXT PRIMARY KEY NOT NULL,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_user_id       TEXT NOT NULL,
  api_key_override    INTEGER NOT NULL DEFAULT 0,
  last_running        INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 去重：同 ws 同 def 保留 created_at 最早一条（被删行的 session_members 级联清理）
DELETE FROM agent_assignments WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM agent_assignments GROUP BY workspace_id, agent_definition_id
);
INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override, last_running, created_at)
SELECT instance_id, workspace_id, agent_definition_id, agent_user_id, has_api_key_override, last_running, created_at
FROM agent_assignments;
CREATE UNIQUE INDEX idx_wam_unique ON workspace_agent_members(workspace_id, agent_definition_id);
CREATE INDEX idx_wam_agent ON workspace_agent_members(agent_definition_id);

-- 团队（§3.2）
CREATE TABLE teams (
  id                 TEXT PRIMARY KEY NOT NULL,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  icon_emoji         TEXT NOT NULL DEFAULT '👥',
  leader_instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE team_members (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (team_id, instance_id)
);

-- sessions / session_members（§3.3；FK 改指需重建表）
ALTER TABLE sessions ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;
CREATE TABLE session_members_v25 (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  instance_id    TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  is_leader      INTEGER NOT NULL DEFAULT 0,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, instance_id)
);
INSERT INTO session_members_v25 (session_id, instance_id, is_leader, added_at)
SELECT session_id, assignment_id, 0, added_at FROM session_members;
DROP TABLE session_members;
ALTER TABLE session_members_v25 RENAME TO session_members;

-- workspaces：默认会话 agent（coordinator 语义就近迁移）；协调/团队会话列退役
ALTER TABLE workspaces ADD COLUMN default_agent_instance_id TEXT REFERENCES workspace_agent_members(instance_id);
UPDATE workspaces SET default_agent_instance_id = (
  SELECT coordinator_instance_id FROM workspaces w2 WHERE w2.id = workspaces.id
);
ALTER TABLE workspaces DROP COLUMN coordinator_instance_id;
ALTER TABLE workspaces DROP COLUMN team_session_id;

-- agent_definitions 全局化（§3.4）
ALTER TABLE agent_definitions DROP COLUMN workspace_id;

DROP TABLE agent_assignments;
```

注意：SQLite 不支持 `UPDATE ... SELECT 自表子查询列`（coordinator 列在同一表）——实际写成
`UPDATE workspaces SET default_agent_instance_id = coordinator_instance_id;`（同表列直拷，支持）。

- [ ] **Step 4: 跑测试绿** → **Step 5: commit** `feat(storage): migration v25——members/teams/默认agent/会话标记 schema 变形（spec §3）`

---

### Task 2: electron 类型层与 repo 映射

**Files:**
- Modify: `electron/src/main/agent/types.ts`（删 `AgentRole`/`BuiltinSuggestion.role`，`AgentAssignment` → `WorkspaceAgentMember`）
- Modify: `electron/src/main/workspace/types.ts`（`defaultAgentInstanceId: string | null`；删 coordinatorInstanceId/teamSessionId）
- Modify: `electron/src/main/storage/sessions/repo.ts`（`SessionRow.titleAuto`；`addSessionMember(sessionId, instanceId, isLeader?)`；row 映射）
- Test: `electron/tests/storage/sessions-repo.test.ts`（补 is_leader/title_auto 用例）

**Interfaces (Produces):**
```ts
export interface WorkspaceAgentMember {
  instanceId: string; workspaceId: string; agentDefinitionId: string;
  agentUserId: string; hasApiKeyOverride: boolean; lastRunning: boolean; createdAt: string;
}
export interface Team {
  id: string; workspaceId: string; name: string; iconEmoji: string;
  leaderInstanceId: string; members: WorkspaceAgentMember[]; createdAt: string;
}
// SessionRow 增：titleAuto: boolean
```

- [ ] **Step 1:** repo 测试先行（isLeader 写读回、titleAuto 默认 false）→ 红
- [ ] **Step 2:** 类型与映射实现（全文件 `AgentAssignment` 引用暂以 `WorkspaceAgentMember` 别名过渡：`export type AgentAssignment = WorkspaceAgentMember;` 供 Task 3-5 逐步消除，Task 15 删别名）
- [ ] **Step 3:** typecheck + 测试绿 → commit `refactor(electron): 类型层切换——WorkspaceAgentMember/Team/titleAuto（spec §3）`

---

### Task 3: membership CRUD + leader 守卫

**Files:**
- Modify: `electron/src/main/agent/crud.ts`（`assignAgentToWorkspace`→`addMember`、`updateAssignmentRole` 删除、`removeMember` 守卫）
- Test: Create `electron/tests/agent/membership-crud.test.ts`

**Interfaces (Produces):**
```ts
export function addMember(workspaceId: string, agentDefinitionId: string, agentUserId: string, apiKeyOverride?: string): WorkspaceAgentMember; // 重复添加 throw
export function removeMember(instanceId: string): { ok: true } | { ok: false; blockedTeams: string[] }; // leader 守卫
export function listMembers(workspaceId: string): WorkspaceAgentMember[];
```

- [ ] **Step 1:** 失败测试（用例：加成员→列表可见 / 重复添加 throw / 无团队时删除 ok / 为 leader 时删除返回 blockedTeams 含团队名 / 非 leader 删除后 team_members 级联为空）
- [ ] **Step 2:** 实现（leader 守卫 SQL：`SELECT t.name FROM teams t WHERE t.leader_instance_id = ?`；删除事务内同时 `UPDATE workspaces SET default_agent_instance_id=NULL WHERE default_agent_instance_id=?`）
- [ ] **Step 3:** 绿 + typecheck → commit `feat(agent): membership CRUD——加成员/leader守卫/默认agent联动置空（spec §4.1）`

---

### Task 4: 团队服务

**Files:**
- Create: `electron/src/main/agent/team.ts`
- Test: Create `electron/tests/agent/team-crud.test.ts`

**Interfaces (Produces):**
```ts
export function createTeam(workspaceId: string, name: string, iconEmoji: string, memberInstanceIds: string[], leaderInstanceId: string): Team; // leader∈members 校验、成员≥2、单事务
export function renameTeam(teamId: string, name: string, iconEmoji?: string): void;
export function setLeader(teamId: string, leaderInstanceId: string): void; // 事务保证 leader 在成员表
export function addTeamMember(teamId: string, instanceId: string): void;
export function removeTeamMember(teamId: string, instanceId: string): void; // leader 走守卫（throw）
export function deleteTeam(teamId: string): void; // 仅删定义
export function listTeams(workspaceId: string): Team[]; // JOIN 成员展开
```

- [ ] **Step 1:** 失败测试（7 个公共函数全覆盖：建团事务原子性——成员 FK 不存在整笔回滚 / leader 外集 throw / <2 成员 throw / 换 leader / 删团队不动成员 / listTeams 展开成员与 leader 标记）
- [ ] **Step 2:** 实现（better-sqlite3 `db.transaction`；memberInstanceIds 先去重再校验）
- [ ] **Step 3:** 绿 → commit `feat(agent): 团队服务——建团事务/leader约束/增删改查（spec §4.2）`

---

### Task 5: 默认会话 agent 服务

**Files:**
- Modify: `electron/src/main/workspace/crud.ts`（`setDefaultAgent`/随 `getWorkspace` 返回）
- Test: Create `electron/tests/workspace/default-agent.test.ts`

**Interfaces (Produces):** `setDefaultAgent(workspaceId, instanceId | null): void`（校验成员属于该 ws）

- [ ] **Step 1:** 失败测试（设置→getWorkspace 返回 / 跨 ws 成员 throw / null 清除 / Task 3 已锁移除联动）
- [ ] **Step 2:** 实现 → 绿 → commit `feat(workspace): 默认会话 agent 读写（spec §4.3）`

---

### Task 6: IPC 面 + preload + 类型契约

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`、`electron/src/main/im/session.ipc.handlers.ts`、`electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts`
- Test: Modify `electron/tests/agent/ipc-handlers.test.ts`、`electron/tests/im/session.ipc.handlers.test.ts`

**Interfaces (Produces — renderer `ipc` 命名面):**
```ts
agent.addMember(input: AddMemberInput): Promise<WorkspaceAgentMember>      // AddMemberInput { workspaceId, agentDefinitionId, apiKeyOverride? }
agent.removeMember(instanceId): Promise<{ ok: true } | { ok: false; blockedTeams: string[] }>
agent.listMembers(workspaceId): Promise<WorkspaceAgentMember[]>
agent.setMemberDeltas / setMemberApiKeyOverride / start / stop             // 原 assignment 系列平移
team.list(wsId): Promise<Team[]>; team.create/rename/delete/setLeader/addMember/removeMember
workspace.setDefaultAgent(wsId, instanceId | null): Promise<void>
session.createQuick(wsId): Promise<SessionSummary>                         // 无默认 → reject { code:'NO_DEFAULT_AGENT' }
session.createCollab(wsId, title?, target: CollabTarget): Promise<SessionSummary> // CollabTarget = {type:'agent';instanceId} | {type:'team';teamId}
```
类型契约同步：`AgentRole` 删除、`SessionMemberInfo { instanceId, agentName, iconEmoji, isLeader, lastRunning }`（删 role/isCoordinator）、`SessionRow.titleAuto`、`mentionedAssignmentIds`→`mentionedInstanceIds`。

- [ ] **Step 1:** ipc.handlers 测试改造（旧通道用例删除，新通道 happy+error 用例：removeMember blocked / createQuick NO_DEFAULT_AGENT）→ 红
- [ ] **Step 2:** handlers + preload + types.d.ts 全量对齐（session 创建的 handler 此 Task 先接线到 Task 7 的占位实现——直接调用 session-ops 现有 createSession 泛化形态，Task 7 落真正双流程）
- [ ] **Step 3:** 双 workspace typecheck 绿 + 测试绿 → commit `feat(ipc): agent/team/默认agent/双会话通道面 + 退役通道删除（spec §5）`

---

### Task 7: 会话创建双流程（快照 + is_leader）

**Files:**
- Modify: `electron/src/main/im/session-ops.ts`
- Test: Modify `electron/tests/im/session-ops.test.ts`

**Interfaces (Produces):**
```ts
export class NoDefaultAgentError extends Error { code = 'NO_DEFAULT_AGENT' as const }
export function createQuickSession(workspaceId: string): SessionRow;   // 无默认 throw NoDefaultAgentError；单成员 is_leader=1、title='新会话'、title_auto=1
export function createCollabSession(workspaceId: string, title: string | null, target: CollabTarget): SessionRow; // 团队→展开快照，leader 成员 is_leader=1；title 空→title_auto=1
export function getSessionMembersInfo(sessionId): SessionMemberInfo[]; // 换表 JOIN + is_leader
```

- [ ] **Step 1:** 失败测试（quick：有默认建会+成员 is_leader+title_auto / 无默认 throw NoDefaultAgentError；collab 单 agent / collab 团队快照展开与 leader 标记 / title 空与实名的 title_auto 差异 / 团队后续变更不影响已建会话（建会后改团队再断言 session_members 不变））
- [ ] **Step 2:** 实现（事务：insertSession + 按 target 写 session_members；团队路径 `listTeams` 取当前成员）
- [ ] **Step 3:** 绿 → commit `feat(im): 快速/协作会话创建——默认agent直达与团队快照（spec §4.4）`

---

### Task 8: 命名服务（截断占位 + LLM 异步替换）

**Files:**
- Create: `electron/src/main/im/session-naming.ts`
- Test: Create `electron/tests/im/session-naming.test.ts`

**Interfaces (Produces):**
```ts
export const PLACEHOLDER_TITLE = '新会话';
export function applyFirstMessageTitle(sessionId: string, body: string): void; // title 仍为占位 → rename 前 20 字符（去换行）
export function scheduleLlmTitle(sessionId: string): void; // fire-and-forget：接待 agent 首次 final 后由路由调用；成功且 title_auto=1 → rename
```
内部：`generateTitle(provider, model, 首条用户消息+首次回复摘录)` 极简 prompt「生成≤12字中文标题，只输出标题」；rename 守卫 `UPDATE sessions SET title=?, title_auto=0 WHERE id=? AND title_auto=1`（行数=0 即被手动改名/已替换，竞态锁）。

- [ ] **Step 1:** 失败测试（截断规则：20 字/去换行/占位才替换 / LLM 成功路径：title_auto=1 被替换并置 0 / 失败静默保持 / title_auto=0 时 LLM 结果不覆盖 / 并发双 final 只生效一次）
- [ ] **Step 2:** 实现（LLM 调用 mock 进程边界；真实 prompt 拼装逻辑不 mock）
- [ ] **Step 3:** 绿 → commit `feat(im): 会话动态命名——截断占位+LLM异步替换+title_auto竞态锁（spec §4.5）`

---

### Task 9: 路由改造（leader 接待 / @ 直答 / 自动拉起 / 失效过滤）

**Files:**
- Modify: `electron/src/main/agent/router-service.ts`（或现接待判定的实际所在文件——执行时以 `grep -rn "coordinator\|isCoordinator" electron/src` 定位全量引用）
- Test: Create `electron/tests/agent/router-leader.test.ts`

**Interfaces (Consumes):** Task 7 `getSessionMembersInfo`；Task 3 `listMembers`/start 链
**行为契约：**
1. 非 @ 消息 → 会话内 `isLeader && 有效` 成员接待；无 leader（历史会话）→ 不派发任何 agent
2. @ 成员 → 该成员直答，leader 不插嘴
3. 接待者 `lastRunning=false` → 自动 start（fire-and-forget）后派发
4. 成员已不在 ws（失效）→ 跳过；全部失效 → 消息仅落库不派发，`sendMessage` IPC 返回 `read_only: true` 提示
5. 首条用户消息触发 Task 8 `applyFirstMessageTitle`；接待者首次 final 触发 `scheduleLlmTitle`

- [ ] **Step 1:** 失败测试（5 条契约各一用例，mock 仅限进程/LLM 边界）→ 红
- [ ] **Step 2:** 实现 → 绿 → commit `feat(agent): 会话路由——leader接待/@直答/自动拉起/失效过滤（spec §4.6）`

---

### Task 10: runtime dispatch 条件切换 + subAgents 快照

**Files:**
- Modify: `electron/src/main/agent/spawn-helpers.ts`、`electron/src/main/agent/runtime-spawner.ts`（以 `grep -rn "role === 'main'\|subAgents" electron/src/main/agent` 定位）
- Test: Create `electron/tests/agent/dispatch-snapshot.test.ts`（契约测试）

**Interfaces (行为契约):**
1. dispatch 工具注入条件 = `会话成员数 > 1 && 自己 is_leader`（取代 `role==='main'`）
2. `config.subAgents` = 当前 session_members 快照除自己（取代 parent 链查询）
3. WarmPool / AgentRunner / task-reply 桥不动

- [ ] **Step 1:** 失败契约测试（生产者 spawn-helpers 真实产出 subAgents 配置 → 消费者 runtime-entry 工具注册直接消费，不经手写中间数据——momo-test-rules #4）→ 红
- [ ] **Step 2:** 实现 → 绿 → commit `refactor(agent): dispatch 注入切会话快照——leader+多成员条件（spec §4.7）`

---

### Task 11: renderer 类型 + stores

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（Task 6 已对齐，此处补 store 消费面）
- Modify: `renderer/src/stores/agent.store.ts`（`assignments`→`members`、`loadTeams`/`createTeam`…、`setDefaultAgent`）
- Modify: `renderer/src/stores/session.store.ts`（`createQuick`/`createCollab` action、NO_DEFAULT_AGENT 错误态 `needsDefaultAgent`）
- Test: Modify `renderer/src/stores/agent.store.test.ts`、`renderer/src/stores/session.store.test.ts`（贴源）

- [ ] **Step 1:** 失败测试（members 加载 / team CRUD action 触发 IPC / createQuick 成功激活会话 / NO_DEFAULT_AGENT → needsDefaultAgent=true）→ 红
- [ ] **Step 2:** 实现 → 绿 + typecheck → commit `feat(renderer): agent/session stores——成员/团队/双会话动作（spec §5-6）`

---

### Task 12: AgentsView 双 Tab 重构

**Files:**
- Modify: `renderer/src/components/agent/AgentsView.tsx`（Tab 容器：「Agent 成员」/「团队」）
- Create: `renderer/src/components/agent/MembersPanel.tsx`（拆自 WorkspaceAgentsPanel：成员行=emoji+名称+⭐默认标记+在线+行内操作）
- Create: `renderer/src/components/agent/TeamsPanel.tsx`（团队卡片：icon+名称+👑leader+成员 chips+编辑/删除+新建）
- Delete: `renderer/src/components/agent/WorkspaceAgentsPanel.tsx`、`AgentOrchestrator*`、`AssignmentRoleEditor.tsx`、`AddToWorkspaceDialog.tsx`（被新弹窗取代）
- Test: 贴源 `MembersPanel.test.tsx`、`TeamsPanel.test.tsx`（删除对应旧测试文件）

- [ ] **Step 1:** 失败测试（双 Tab 切换 / 成员行操作触发 store action / ⭐默认标记 / 团队卡片 leader 标记与成员 chips / 空态）→ 红
- [ ] **Step 2:** 实现 → 绿 → commit `feat(renderer): AgentsView 双 Tab——成员面板+团队面板（spec §6.1）`

---

### Task 13: 三弹窗 + 默认 agent 一次性选择

**Files:**
- Create: `renderer/src/components/agent/CreateAgentDialog.tsx`（名称*/图标/模型*/提示词/默认工具集三档/「设为默认会话 agent」勾选；`defaultAgentSource: 'agentView' | 'library'` 决定是否自动入 ws）
- Create: `renderer/src/components/agent/TeamDialog.tsx`（创建/编辑同表单回填；成员勾选≥2；leader 从已勾选单选）
- Create: `renderer/src/components/im/CollabSessionDialog.tsx`（名称可空 + 「单个 agent/团队」页签单选）
- Create: `renderer/src/components/im/DefaultAgentPickerDialog.tsx`（ws 成员单选 → 设默认并继续建快速会话）
- Test: 贴源四件套 `.test.tsx`

- [ ] **Step 1:** 失败测试（各弹窗校验与提交路径：必填/勾选联动/leader 禁用态/创建成功回调 onClose）→ 红
- [ ] **Step 2:** 实现 → 绿 → commit `feat(renderer): 创建Agent/团队/协作会话弹窗+默认agent引导（spec §6.3-5）`

---

### Task 14: 会话入口双按钮 + 列表项图标派生

**Files:**
- Modify: `renderer/src/components/layout/ViewSidebar.tsx`（会话区头部 `⚡`+`👥` 双常驻按钮）
- Modify: `renderer/src/components/im/SessionList.tsx`（或实际列表组件）：列表项图标=单成员该 agent emoji / 多成员 icon 组+👑；只读会话输入禁用
- Test: 贴源对应 `.test.tsx`；Modify `renderer/src/components/im/MentionInput.test.tsx`（@ 目标换 instanceId 语义）

- [ ] **Step 1:** 失败测试（⚡ 无默认 → 弹 picker；有默认 → 免弹窗直接建会并聚焦输入；👥 弹 CollabSessionDialog；列表项图标派生；只读态）→ 红
- [ ] **Step 2:** 实现 → 绿 → commit `feat(renderer): 快速/协作会话入口+列表图标派生（spec §6.2/§7）`

---

### Task 15: 退役清理 + 全量回归

**Files:**
- 全仓 grep 清理：`AssignmentRole|AgentRole|parentInstanceId|coordinator|Coordinator|teamSessionId|assignMain|addToWorkspace|编排`（electron/src、renderer/src、preload；测试与 docs/specs 归档除外）
- Delete: `electron/src/main/agent/` 内 role 残留函数与 `AgentAssignment` 过渡别名（Task 2）

- [ ] **Step 1:** `grep -rn "AgentRole\|parentInstanceId\|coordinator\|teamSessionId" electron/src renderer/src --include="*.ts" --include="*.tsx"` → 逐个清零（预期仅剩历史 migration SQL 与类型对齐注释）
- [ ] **Step 2:** 全量验证：`npx pnpm@9.0.0 typecheck` 双 clean；`npx pnpm@9.0.0 test` 全绿零 fail；e2e 冒烟 `npx pnpm@9.0.0 e2e`
- [ ] **Step 3:** commit `refactor: 退役编排概念全清——role/parent/coordinator/teamSessionId 零残留（spec §4）` + 更新 README 特性描述与 AGENTS.md 架构要点（agent 域三行）

---

## Self-Review 记录

1. **Spec 覆盖**：§3→Task 1-2；§4.1-4.3→Task 3-5；§4.4-4.5→Task 7-8；§4.6→Task 9；§4.7→Task 10；§5→Task 6/11；§6→Task 12-14；§7 边界分布在 Task 7/9/14 用例；§8 测试即各 Task TDD 步骤——无缺口
2. **占位符扫描**：无 TBD/「适当处理」；Task 1 测试骨架中两处 `/* 同上 */` 为执行者按既有断言模式复写（模式已给全）——已确认为可执行描述
3. **类型一致性**：`WorkspaceAgentMember`/`Team`/`CollabTarget`/`NoDefaultAgentError`/`instanceId` 命名在 Task 2/4/6/7/11 间已对齐；`hasApiKeyOverride` 保持现名减少 renderer 面波动
