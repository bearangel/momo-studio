# 任务委派信息闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除「agent 创建无指派任务 → draft 死局 → agent 死等」——新枚举工具 + create_task 描述纠偏 + 无指派创建返回 warning。

**Architecture:** 全部落点在 `electron/src/main/agent/tools/task-tools.ts`（TaskTools 模块内新增第 8 个工具 + 修改 create_task 语义）。查询复用现成 repo 函数（listMembers / listTeams / listSessionsByWorkspace / listSessionMembers / listAgentDefinitions），本文件保持「不含 SQL」既有约束。

**Tech Stack:** Electron 主进程（CommonJS / TS strict）、better-sqlite3、vitest。

**Spec:** `docs/specs/2026-09-08-task-delegation-info-loop-design.md`

## Global Constraints

- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）
- 全部代码注释中文；标识符英文
- task-tools.ts 顶层「本文件不含 SQL」约束——新工具查询只准调 repo 函数
- 测试环境：Node 20（`nvm use 20`）；vitest 跑法 `cd electron && npx pnpm@9.0.0 vitest run <path>`
- 测试文件用真实 SQLite（tmpdir + runMigrations + closeDb），禁止 mock DB——沿用 task-tools-context.test.ts 已验证模式
- 提交规范：Conventional Commits 中文语义（`feat: 中文描述——补充说明`）

---

### Task 1: list_delegation_targets 新工具

**Files:**
- Modify: `electron/src/main/agent/tools/task-tools.ts`（import 块 26-44 行 + 顶层函数区 + getDefs + execute + 文件头注释）
- Test: `electron/tests/agent/tools/task-tools-delegation.test.ts`（新建）

**Interfaces:**
- Consumes（全部现成，只 import 不改）:
  - `listMembers(workspaceId: string): WorkspaceAgentMember[]`（agent/crud.ts:413；含 `instanceId` / `agentName` / `agentDefinitionId`）
  - `listAgentDefinitions(workspaceId?: string): AgentDefinition[]`（agent/crud.ts:231；含 `id` / `description`）
  - `listTeams(workspaceId: string): Team[]`（agent/team.ts:218；`Team` 含 `id` / `name` / `leaderInstanceId` / `members: WorkspaceAgentMember[]`）
  - `listSessionsByWorkspace(workspaceId: string): SessionRow[]`（storage/sessions/repo.ts:68；含 `id` / `title` / `kind` / `lastMessageAt` / `createdAt`）
  - `listSessionMembers(sessionId: string): Array<{ instanceId: string; isLeader: boolean; addedAt: number }>`（storage/sessions/repo.ts:123）
- Produces（Task 2 引用）: 工具名 `list_delegation_targets`（字符串，写入 create_task 描述与 warning 文案）

- [ ] **Step 1: 写失败测试（新建文件，脚手架复制自 task-tools-context.test.ts 已验证模式）**

```typescript
// electron/tests/agent/tools/task-tools-delegation.test.ts
//
// 任务委派信息闭环回归锁（spec 2026-09-08）：
// agent 此前无工具发现可指派目标——create_task 留空指派落 draft 死局。
// 本文件锁 list_delegation_targets 的三类清单 / isSelf·isCurrent 标记 /
// workspace 收窄 / 空类目提示。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import { saveAgentDefinition, addMember, generateAgentUserId, type AgentDefinition } from '../../../src/main/agent/crud';
import { createTeam } from '../../../src/main/agent/team';
import type { ToolContext } from '../../../src/main/agent/tools/types';

/** 构造最小可用 AgentDefinition（模式取自 capabilities-rebuild.test.ts makeDef） */
function makeDef(id: string, name: string, description: string): AgentDefinition {
  return {
    id,
    name,
    slug: id,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description,
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
  };
}

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-delegation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let REAL_WORKSPACE_ID = '';

function seedCtx(wsId: string, roomId: string): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: wsId,
    workspaceDir: '/tmp/ws',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ss-1',
    roomId,
    sendStreamChunk: () => undefined,
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '@real-owner:home',
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('list_delegation_targets（委派信息闭环）', () => {
  const tools = new TaskTools();

  it('工具已注册且无必填参数（workspaceId 走 ctx 注入）', () => {
    const def = tools.getDefs().find((d) => d.name === 'list_delegation_targets');
    expect(def).toBeDefined();
    expect(def!.inputSchema.required ?? []).toHaveLength(0);
    expect(tools.handles('list_delegation_targets')).toBe(true);
  });

  it('返回三类清单：agents 带 name 与 isSelf、teams 带 leaderName、sessions 带 isCurrent 且按最近活跃排序截 20', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const { insertSession, addSessionMember } = await import('../../../src/main/storage/sessions/repo');

    const ws = await createWorkspace(
      { name: 'T', directoryPath: '/tmp/ws-delegation', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    REAL_WORKSPACE_ID = ws.id;

    saveAgentDefinition(makeDef('def-exec', '测试执行者', '测试用 agent'));
    const member = await addMember(REAL_WORKSPACE_ID, 'def-exec', generateAgentUserId('test-executor'));
    const session = insertSession({ workspaceId: REAL_WORKSPACE_ID, title: '当前会话', kind: 'chat' });
    addSessionMember(session.id, member.instanceId);
    createTeam(REAL_WORKSPACE_ID, '执行团队', '👥', [member.instanceId], member.instanceId);

    const result = JSON.parse(await tools.execute('list_delegation_targets', {}, seedCtx(REAL_WORKSPACE_ID, session.id)));

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ instanceId: member.instanceId, name: '测试执行者', description: '测试用 agent', isSelf: true });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({ name: '执行团队', memberCount: 1, leaderName: '测试执行者' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: session.id, title: '当前会话', kind: 'chat', isCurrent: true });
    expect(result.notes).toHaveLength(0);
  });

  it('workspace 收窄：成员属于本 ws 才出现；空类目带提示', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const { insertSession } = await import('../../../src/main/storage/sessions/repo');

    const wsA = await createWorkspace(
      { name: 'A', directoryPath: '/tmp/ws-a', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    saveAgentDefinition(makeDef('def-a', 'A 的成员', ''));
    await addMember(wsA.id, 'def-a', generateAgentUserId('ws-a-member'));

    // 在另一个 workspace 视角查询：agents 应为空 + 有提示
    const wsB = await createWorkspace(
      { name: 'B', directoryPath: '/tmp/ws-b', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    const otherSession = insertSession({ workspaceId: wsB.id, title: 'B 会话', kind: 'chat' });

    const result = JSON.parse(await tools.execute('list_delegation_targets', {}, seedCtx(wsB.id, otherSession.id)));
    expect(result.agents).toHaveLength(0);
    expect(result.notes).toContain('本工作空间暂无 agent 成员，无法指派 assigneeAgentId');
    expect(result.notes).toContain('本工作空间暂无团队');
  });
});
```

注意：`makeDef` 的 `modelProviderId: 'prov-1'` 不需要真实 provider 行——`saveAgentDefinition` 是纯 insert 不校验 FK（capabilities-rebuild.test.ts 同款模式，无外键约束问题）。

- [ ] **Step 2: 跑测试确认失败**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
```

预期：FAIL——`list_delegation_targets` 工具不存在（getDefs 找不到 / execute 抛「未知工具」）。

- [ ] **Step 3: 实现**

`task-tools.ts` import 区（26-44 行附近）追加：

```typescript
import { listMembers, listAgentDefinitions } from '../crud';
import { listTeams } from '../team';
import { listSessionsByWorkspace, listSessionMembers } from '../../storage/sessions/repo';
```

顶层函数区（`listTasks` 之后、`parseStringArgOptional` 之前）追加：

```typescript
/** list_delegation_targets 的 agents 条目 */
export interface DelegationTargetAgent {
  instanceId: string;
  name: string;
  description: string;
  /** 当前会话（ctx.roomId 的 session_members）内的成员 = agent 视角的「自己」 */
  isSelf: boolean;
}

/** list_delegation_targets 的 teams 条目 */
export interface DelegationTargetTeam {
  id: string;
  name: string;
  memberCount: number;
  leaderName: string;
}

/** list_delegation_targets 的 sessions 条目 */
export interface DelegationTargetSession {
  id: string;
  title: string;
  kind: 'chat' | 'task_execution';
  isCurrent: boolean;
}

/** list_delegation_targets 返回结构（紧凑，直接 JSON.stringify 给 LLM） */
export interface DelegationTargetList {
  agents: DelegationTargetAgent[];
  teams: DelegationTargetTeam[];
  sessions: DelegationTargetSession[];
  /** 空类目提示（agent 区分「没有」与「查询失败」）；全非空为空数组 */
  notes: string[];
}

/**
 * list_delegation_targets：一次返回三类可指派委派目标（agent 成员 / 团队 / 会话）。
 *
 * 委派信息闭环（spec 2026-09-08）：agent 此前无工具发现指派目标 ID，
 * create_task 留空指派 → draft 死局。查询全部走 repo 函数（本文件不含 SQL）。
 * sessions 按 COALESCE(last_message_at, created_at) DESC 取最近 20 条。
 */
export function listDelegationTargets(workspaceId: string, roomId: string): DelegationTargetList {
  const members = listMembers(workspaceId);
  const descByDefId = new Map(listAgentDefinitions().map((d) => [d.id, d.description]));
  const selfIds = new Set(roomId ? listSessionMembers(roomId).map((m) => m.instanceId) : []);
  const agents: DelegationTargetAgent[] = members.map((m) => ({
    instanceId: m.instanceId,
    name: m.agentName,
    description: descByDefId.get(m.agentDefinitionId) ?? '',
    isSelf: selfIds.has(m.instanceId),
  }));

  const teams: DelegationTargetTeam[] = listTeams(workspaceId).map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: t.members.length,
    leaderName:
      t.members.find((m) => m.instanceId === t.leaderInstanceId)?.agentName ?? '（无 leader）',
  }));

  const sessions: DelegationTargetSession[] = listSessionsByWorkspace(workspaceId)
    .map((s) => ({ row: s, sortKey: s.lastMessageAt ?? s.createdAt }))
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 20)
    .map(({ row }) => ({ id: row.id, title: row.title, kind: row.kind, isCurrent: row.id === roomId }));

  const notes: string[] = [];
  if (agents.length === 0) notes.push('本工作空间暂无 agent 成员，无法指派 assigneeAgentId');
  if (teams.length === 0) notes.push('本工作空间暂无团队');
  return { agents, teams, sessions, notes };
}
```

`getDefs()` 数组追加（放 `create_task` 之前——agent 读 defs 列表时先见信息源）：

```typescript
{
  name: 'list_delegation_targets',
  description:
    '列出当前工作空间全部可指派的委派目标（agent 成员 / 团队 / 会话，含各自 ID 与名称）。create_task 前先调用本工具获取真实 ID——系统没有自动指派机制，无指派目标任务不会被调度执行。',
  inputSchema: { type: 'object', properties: {} },
},
```

`handles()` 加分支；`execute()` switch 加分支：

```typescript
case 'list_delegation_targets': {
  return JSON.stringify(listDelegationTargets(ctx.workspaceId, ctx.roomId));
}
```

文件头注释「7 个工具的语义」块更新为 8 个（补一行 `list_delegation_targets() → 三类委派目标清单`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
```

预期：3 passed。seed 函数签名与推断不符时按真实签名调整（断言不变）。

- [ ] **Step 5: 回归 + typecheck + 提交**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/ && cd /workspace && npx pnpm@9.0.0 typecheck
```

预期：agent/tools 全绿、typecheck 双 clean。然后：

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/task-tools.ts electron/tests/agent/tools/task-tools-delegation.test.ts
GIT_MASTER=1 git commit -m "feat: list_delegation_targets 工具——agent 可发现可指派目标" -m "委派信息闭环 ①：agent 此前无工具获知工作空间有哪些 agent/团队/会话可指派，create_task 只能留空指派 → draft 死局。一次返回三类目标紧凑清单（含 isSelf/isCurrent 标记、最近 20 条会话、空类目提示）。"
```

---

### Task 2: create_task 描述纠偏 + 无指派 warning

**Files:**
- Modify: `electron/src/main/agent/tools/task-tools.ts`（create_task 的 def 269-312 行 + execute 的 create_task 分支 411-437 行）
- Test: `electron/tests/agent/tools/task-tools-delegation.test.ts`（Task 1 新建的文件里追加 describe）

**Interfaces:**
- Consumes: Task 1 的工具名 `list_delegation_targets`（文案引用）
- Produces: 无（终端任务）

- [ ] **Step 1: 追加失败测试（同一测试文件末尾）**

```typescript
describe('create_task 无指派 warning（委派信息闭环）', () => {
  const tools = new TaskTools();

  it('无指派创建 → 返回 TaskRow 字段仍在顶层 + warning 字段说明死局与出路', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'W', directoryPath: '/tmp/ws-warn', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    const result = JSON.parse(
      await tools.execute('create_task', { title: '无目标任务' }, seedCtx(ws.id, 'room-x')),
    );
    // 形状向后兼容：TaskRow 字段仍在顶层
    expect(result.id).toMatch(/^T-/);
    expect(result.status).toBe('draft');
    // warning 存在且包含关键事实
    expect(result.warning).toContain('没有自动指派机制');
    expect(result.warning).toContain('list_delegation_targets');
    expect(result.warning).toContain('draft');
  });

  it('有指派创建 → 无 warning 字段 + 落 assigned（K1 决策表对齐——否则 executor 不消费，死局换形态）', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'W2', directoryPath: '/tmp/ws-warn2', description: '', iconEmoji: '📁' },
      '@real-owner:home',
    );
    saveAgentDefinition(makeDef('def-warn', '执行者', ''));
    const member = await addMember(ws.id, 'def-warn', generateAgentUserId('warn-executor'));
    const result = JSON.parse(
      await tools.execute(
        'create_task',
        { title: '有目标任务', assigneeAgentId: member.instanceId },
        seedCtx(ws.id, 'room-y'),
      ),
    );
    expect(result.id).toMatch(/^T-/);
    expect(result.status).toBe('assigned');
    expect(result.warning).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
```

预期：新 describe 两个用例 FAIL（`result.warning` 为 undefined）。

- [ ] **Step 3: 实现**

`task-tools.ts` 的 `createTask` 函数（154-168 行）改为应用 K1 决策表 + 终态钩子：

```typescript
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  // 委派信息闭环 ④：与 IPC task:create 的 K1 落态决策对齐（决策表注释见
  // task/ipc.handlers.ts）——scheduler 只消费 pending、executor 只消费
  // assigned；agent 建的带目标任务此前落 draft 两个调度器都不认（死局换形态）
  const hasTarget =
    input.assigneeAgentId != null ||
    input.targetTeamId != null ||
    input.targetSessionId != null;
  const row = insertTask({
    workspaceId: input.workspaceId,
    title: input.title,
    status: input.scheduledAt != null ? 'pending' : hasTarget ? 'assigned' : undefined,
    description: input.description ?? '',
    creatorUserId: input.creatorUserId,
    priority: input.priority ?? 0,
    assigneeAgentId: input.assigneeAgentId,
    targetTeamId: input.targetTeamId,
    targetSessionId: input.targetSessionId,
    recurrenceRule: input.recurrenceRule,
    scheduledAt: input.scheduledAt,
  });
  // assigned 落态即时触发放行评估（100ms 去抖合并；丢了有 30s 兜底扫描自愈）
  if (row.status === 'assigned') notifyExecutor();
  return row;
}
```

模块常量区（parseStringArgOptional 附近）加：

```typescript
/** 无指派创建的 warning 文案（委派信息闭环 ③：让 agent 立即知道死局与出路） */
const NO_ASSIGNMENT_WARNING =
  '任务未指派委派目标（assigneeAgentId / targetTeamId / targetSessionId 均为空）。' +
  '系统没有自动指派机制——此任务将停留在 draft，永远不会被调度执行。' +
  'draft 任务无法用工具取消（状态机不允许），请：' +
  '1) 调用 list_delegation_targets 查看可指派目标，重新创建携带指派的新任务；' +
  '2) 告知用户在看板手动处理本条死任务（取消或编辑指派）。';
```

`execute()` 的 `create_task` 分支，`const result = await createTask(input); return JSON.stringify(result);` 改为：

```typescript
const result = await createTask(input);
// 委派信息闭环 ③：无指派 → TaskRow 顶层附加 warning（形状向后兼容，
// 有指派时返回纯 TaskRow——现有消费方直接 parse 顶层字段不破坏）
const hasTarget = Boolean(input.assigneeAgentId || input.targetTeamId || input.targetSessionId);
if (!hasTarget) {
  return JSON.stringify({ ...result, warning: NO_ASSIGNMENT_WARNING });
}
return JSON.stringify(result);
```

`getDefs()` 的 `create_task` 描述三处修改：

主 description 改为：

```
创建新任务。返回刚创建的 TaskRow（含 id / status=draft；未指派委派目标时返回对象额外含 warning 字段——任务不会被调度执行）。workspaceId 与 creatorUserId 由工具上下文自动注入（LLM 无需填、也不应填——args 中的同名键会被忽略以防 FK 违约与跨用户冒名）。assigneeAgentId / targetTeamId / targetSessionId 三者必须提供其一，创建前先调用 list_delegation_targets 获取真实 ID。
```

`assigneeAgentId` 子描述改为：

```
指派目标 agent 的 instance ID（从 list_delegation_targets 查询）。三者必须提供其一——系统没有自动指派机制，无指派任务将永远停留在 draft 不会被调度执行
```

`targetTeamId` / `targetSessionId` 子描述末尾各补 `（从 list_delegation_targets 查询）`。

文件头注释第 9 行 `create_task(input) → 新建任务（draft 状态）` 改为 `create_task(input) → 新建任务（K1 落态：有目标 assigned / 有计划 pending / 否则 draft）`。

- [ ] **Step 4: 跑测试确认通过**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
```

预期：5 passed（Task 1 的 3 + Task 2 的 2）。

- [ ] **Step 5: 全量回归 + typecheck + 提交**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1 && cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/ && cd /workspace && npx pnpm@9.0.0 typecheck
```

预期：tests/agent 全绿（含 task-tools-context.test.ts / task-tools.test.ts 既有回归——warning 附加在顶层不破坏既有断言）、typecheck 双 clean。然后：

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/task-tools.ts electron/tests/agent/tools/task-tools-delegation.test.ts
GIT_MASTER=1 git commit -m "fix: create_task 描述纠偏 + 无指派返回 warning——消除调度器幻觉" -m "委派信息闭环 ②③：旧描述『不指定则由调度器决定』是假话（dispatcher 是 2.1 未接线预留），agent 据此留空指派并死等调度。改为真相描述 + 无指派创建时 TaskRow 顶层附 warning（含 list_delegation_targets 行动指引），形状向后兼容。"
```

---

## 完成标准

- 两个 commit 落库；`tests/agent/` 全绿；typecheck 双 clean
- 手工验证（macOS 主机，可选）：快速会话让 agent「委派 5 个任务」→ agent 应先调 `list_delegation_targets` 再创建带指派的任务，不再出现 draft 死局
