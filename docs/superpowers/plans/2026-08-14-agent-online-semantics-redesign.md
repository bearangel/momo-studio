# Agent 在线状态语义重新设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v2 task-driven 切换后所有 agent 显示离线的 bug，重新定义「agent 在线」= DB `last_running=1`，统一 UI/IPC/路由层语义。

**Architecture:** 以 `agent_assignments.last_running` 字段为唯一权威源；task-driven runner 注册/WarmPool 预热是实现细节，不暴露到 UI；删除 renderer 端冗余 `running` state；PM dispatch 列表 + MentionInput 菜单按 `lastRunning` 过滤。

**Tech Stack:** TypeScript（双 workspace：electron CJS + renderer ESM）、SQLite（better-sqlite3）、Vitest、React + Zustand、Electron IPC、matrix-js-sdk v31。

## Global Constraints

- **Node 20 LTS 强制**：先 `nvm use 20` 再跑任何命令。容器默认 Node 26 会破坏 better-sqlite3 native binding。
- **TypeScript strict**：禁 `any`/`@ts-ignore`/`as any`。ESLint `no-explicit-any: error` 已启用。
- **Conventional Commits**：`feat:`、`fix:`、`refactor:`、`test:`、`docs:`。
- **中文注释**：源码内注释使用中文，标识符保持英文。
- **测试运行**：`npx pnpm@9.0.0 test`（双 workspace）；单测 `cd electron && npx pnpm@9.0.0 vitest run tests/xxx.test.ts`。
- **类型检查**：`npx pnpm@9.0.0 typecheck`（双 workspace，先于测试执行）。
- **文档 git add**：`docs/` 在 `.gitignore`，必须 `git add -f docs/path`；源码正常 `git add`。
- **Preload 类型共享**：`electron/src/preload/index.ts` 通过三层 `../../../` 引用 `renderer/src/ipc/types.d.ts`，修改 IPC 类型时两个 workspace 都要 typecheck。
- **Migration SQL 内联**：本次无 migration（last_running 列已存在），仅映射到 TS 接口。

---

## File Structure

### Electron 主进程（8 个）

| 文件 | 责任 | 改动 |
|---|---|---|
| `electron/src/main/agent/types.ts` | AgentAssignment 接口定义 | 加 `lastRunning: boolean` 字段 |
| `electron/src/main/agent/crud.ts` | DB row ↔ 类型映射 + assignment CRUD | AgentAssignmentRow 加 `last_running`；rowToAssignment 映射 |
| `electron/src/main/agent/runtime-manager.ts` | v1 子进程管理 + `isAgentRunning` 导出 | `isAgentRunning` 改为查 DB |
| `electron/src/main/agent/runtime-registry.ts` | v2 task-driven 全局 Map + 创建/销毁 helper | 新增 `destroyTaskDrivenRuntime(id)` + `stopAgentRuntime(id)` |
| `electron/src/main/agent/ipc.handlers.ts` | `agent:*` IPC handler 注册 | `agent:stop` 改用 `stopAgentRuntime`；新增 `maybeRestartMainForSubChange`；start/stop 末尾触发 |
| `electron/src/main/index.ts` | 主进程启动链路 | `initTaskDrivenRuntime` 加 `lastRunning` 过滤 |
| `electron/src/main/agent/spawn-helpers.ts` | 构建 AGENT_CONFIG 通用 helper | `rebuildSubAgents` 过滤 `!sub.lastRunning` |
| `electron/src/main/agent/auto-start.ts` | v1 fallback 自启动入口（task-driven 由 initTaskDrivenRuntime 接管） | 文档注释更新，无行为变化 |

### Renderer（5 个）

| 文件 | 责任 | 改动 |
|---|---|---|
| `renderer/src/ipc/types.d.ts` | renderer 端 IPC 类型定义 | AgentAssignment 加 `lastRunning: boolean` |
| `renderer/src/components/im/MentionInput.tsx` | @/# mention 输入 + 菜单 | 菜单过滤 `!a.lastRunning` |
| `renderer/src/components/im/MembersPanel.tsx` | 群成员侧栏 + 在线状态 badge | 改查 `a.lastRunning` |
| `renderer/src/components/agent/WorkspaceAgentsPanel.tsx` | agent 列表 + 启动/停止按钮 | AssignmentRow 用 `a.lastRunning` |
| `renderer/src/stores/agent.store.ts` | agent state（zustand） | 删除 `running` state + `syncRunningStates` + 相关 set |

### 测试文件（新增 / 更新）

| 文件 | 类型 | 任务 |
|---|---|---|
| `electron/tests/agent/crud-assignment.test.ts` | 更新 | Task 1 验证 rowToAssignment 映射 lastRunning |
| `electron/tests/agent/runtime-manager.test.ts` | 更新 | Task 2 验证新 isAgentRunning 行为 |
| `electron/tests/agent/runtime-registry.test.ts` | 更新 | Task 3 验证 destroyTaskDrivenRuntime + stopAgentRuntime |
| `electron/tests/agent/ipc-stop-start.test.ts` | 新增 | Task 4 + 7 验证 IPC 双轨 + sub 状态触发 main 重启 |
| `electron/tests/integration/agent-online-bootstrap.test.ts` | 新增 | Task 5 验证 initTaskDrivenRuntime 仅注册 last_running=1 |
| `electron/tests/agent/spawn-helpers-sub-filter.test.ts` | 新增 | Task 6 验证 rebuildSubAgents 过滤 |
| `renderer/src/components/im/MembersPanel.test.tsx` | 更新 | Task 9 验证显示逻辑 |
| `renderer/src/components/im/MentionInput.test.tsx` | 更新 | Task 9 验证菜单过滤 |

---

## Task 1: 类型补全 — `lastRunning` 字段贯穿 DB → 类型 → renderer

**Files:**
- Modify: `electron/src/main/agent/types.ts:81-96`（AgentAssignment 接口）
- Modify: `electron/src/main/agent/crud.ts:90-100`（AgentAssignmentRow）+ `:126-138`（rowToAssignment）
- Modify: `renderer/src/ipc/types.d.ts:69-87`（renderer 端 AgentAssignment）
- Test: `electron/tests/agent/crud-assignment.test.ts`

**Interfaces:**
- Produces: `AgentAssignment.lastRunning: boolean`（后续所有 task 消费）

- [ ] **Step 1.1: 写失败测试 — rowToAssignment 映射 lastRunning**

`electron/tests/agent/crud-assignment.test.ts` 末尾追加：

```typescript
import { listAssignments } from '../../src/main/agent/crud';

describe('AgentAssignment.lastRunning 字段映射 (Task 1)', () => {
  it('row.last_running=1 → assignment.lastRunning=true', () => {
    // 准备：在内存 DB 中插入一条 last_running=1 的 assignment
    const db = getDb();
    const wsId = 'ws-test-last-running';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');
    const defId = 'def-test-1';
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run(defId, 'Test', 'test', '1.0.0');

    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run('inst-1', wsId, defId, '@bot1:localhost');

    const list = listAssignments(wsId);
    expect(list).toHaveLength(1);
    expect(list[0].lastRunning).toBe(true);
  });

  it('row.last_running=0 → assignment.lastRunning=false', () => {
    const db = getDb();
    const wsId = 'ws-test-last-running-2';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');
    const defId = 'def-test-2';
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run(defId, 'Test2', 'test2', '1.0.0');

    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 0, 'standalone', NULL, 0)`)
      .run('inst-2', wsId, defId, '@bot2:localhost');

    const list = listAssignments(wsId);
    expect(list[0].lastRunning).toBe(false);
  });
});
```

确认测试文件顶部已导入 `getDb`；若无则补 `import { getDb } from '../../src/main/storage/db';`。

- [ ] **Step 1.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/crud-assignment.test.ts
```

预期：FAIL，错误信息包含 `lastRunning` does not exist on type `AgentAssignment` 或类似 TS 编译错误。

- [ ] **Step 1.3: 类型补全 — electron/src/main/agent/types.ts**

`AgentAssignment` 接口（行 81-96）末尾追加：

```typescript
  /** v2 修复：用户最近运行意图。这是"agent 在线"的唯一权威源。
   *  - true = 用户启动过（在线）
   *  - false = 用户主动停止或从未启动（离线）
   *  DB 列 last_running（INTEGER NOT NULL DEFAULT 1）
   */
  lastRunning: boolean;
```

- [ ] **Step 1.4: 类型补全 — renderer/src/ipc/types.d.ts**

renderer 端 `AgentAssignment` 接口（行 69-87）末尾（在 `agentName?` 之后）追加：

```typescript
  /** v2 修复：用户最近运行意图（true=在线/false=离线）。
   *  来源：DB agent_assignments.last_running；与 electron 端 AgentAssignment 对齐。 */
  lastRunning: boolean;
```

- [ ] **Step 1.5: DB row 映射 — electron/src/main/agent/crud.ts**

`AgentAssignmentRow` 接口（行 90-100）末尾追加字段：

```typescript
  /** v1.5.8 DB 列；v2 修复补映射 */
  last_running: number;
```

`rowToAssignment` 函数（行 126-138）返回对象末尾追加：

```typescript
    lastRunning: row.last_running === 1,
```

- [ ] **Step 1.6: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/crud-assignment.test.ts
```

预期：PASS。

- [ ] **Step 1.7: typecheck 双 workspace**

```bash
npx pnpm@9.0.0 typecheck
```

预期：双 workspace clean。如果有其他文件因新增 `lastRunning` 必填字段报错，记录错误文件清单，下一步处理。

- [ ] **Step 1.8: 修复因 lastRunning 必填导致的类型错误（如有）**

主要可能位置：
- `electron/src/main/agent/auto-start.ts:29-38` 内部 AssignmentRow 是独立定义，不消费 AgentAssignment 类型，不应报错
- 任何手动构造 AgentAssignment 字面量的地方需要补 `lastRunning` 字段
- 测试 fixture 中构造 AgentAssignment 需补字段

逐个修复。

- [ ] **Step 1.9: commit**

```bash
git add electron/src/main/agent/types.ts electron/src/main/agent/crud.ts renderer/src/ipc/types.d.ts electron/tests/agent/crud-assignment.test.ts
# 如有其他文件被修改也加入
git commit -m "feat(agent): AgentAssignment 新增 lastRunning 字段贯穿类型链路

为后续 isAgentRunning 改造打基础。
DB last_running 列已存在（v1.5.8），仅补 TS 类型 + rowToAssignment 映射。
renderer 端 types.d.ts 同步。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.1"
```

---

## Task 2: `isAgentRunning` 改为查 DB（替代 `runtimes.has`）

**Files:**
- Modify: `electron/src/main/agent/runtime-manager.ts:853-856`
- Test: `electron/tests/agent/runtime-manager.test.ts`、`electron/tests/agent/runtime-manager-last-running.test.ts`

**Interfaces:**
- Consumes: `Task 1` 的 `lastRunning` 字段（间接，通过 DB）
- Produces: `isAgentRunning(instanceId): boolean` 新语义（查询 DB）

- [ ] **Step 2.1: 写失败测试 — 新 isAgentRunning 行为**

`electron/tests/agent/runtime-manager.test.ts` 末尾追加：

```typescript
import { isAgentRunning } from '../../src/main/agent/runtime-manager';
import { getDb } from '../../src/main/storage/db';

describe('isAgentRunning DB 查询行为 (Task 2)', () => {
  it('last_running=1 → 返回 true（无论 runtimes Map 是否有 entry）', () => {
    const db = getDb();
    const instId = 'inst-isrunning-1';
    // 准备 DB 行（last_running=1）
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run(instId, 'ws-test-isrunning', 'def-x', '@bot:localhost');

    // runtimes Map 不含此 instId（模拟 task-driven agent）
    expect(isAgentRunning(instId)).toBe(true);
  });

  it('last_running=0 → 返回 false', () => {
    const db = getDb();
    const instId = 'inst-isrunning-0';
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 0, 'standalone', NULL, 0)`)
      .run(instId, 'ws-test-isrunning', 'def-x', '@bot:localhost');

    expect(isAgentRunning(instId)).toBe(false);
  });

  it('instanceId 不存在 → 返回 false', () => {
    expect(isAgentRunning('inst-not-exist')).toBe(false);
  });
});
```

- [ ] **Step 2.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-manager.test.ts
```

预期：FAIL，前两个 case 失败（runtimes.has 返回 false，但期望 true）。

- [ ] **Step 2.3: 改 isAgentRunning 实现**

`electron/src/main/agent/runtime-manager.ts:853-856`：

```typescript
/** 指定 instanceId 的 agent 是否正在运行。
 *  v2 修复：查询 DB last_running 字段（用户启动意图），不再查 v1 runtimes Map。
 *  原因：task-driven agent 在 agentRunners Map（runtime-registry.ts），
 *  旧实现仅查 v1 runtimes 永远返回 false，导致 UI 显示所有 agent 离线。
 *  语义变更：本函数现表示"用户标记为运行"，所有 callers 行为一致。
 */
export function isAgentRunning(instanceId: string): boolean {
  const row = getDb()
    .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return row?.last_running === 1;
}
```

- [ ] **Step 2.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-manager.test.ts
```

预期：PASS。

- [ ] **Step 2.5: 更新 runtime-manager-last-running.test.ts 既有断言**

打开 `electron/tests/agent/runtime-manager-last-running.test.ts`，搜索所有 `isAgentRunning` 调用：
- 之前依赖 "spawn 后 isAgentRunning=true" → 改为依赖 "spawn 后 DB last_running=1 → isAgentRunning=true"
- 之前依赖 "stopAgent 后 isAgentRunning=false" → 改为依赖 "stopAgent 后 DB last_running=0 → isAgentRunning=false"

既有断言大部分应仍成立（spawn 写 last_running=1，stopAgent 写 last_running=0），但若有 mock 注入 runtimes Map 的场景需更新为 mock DB。

具体步骤：
1. 运行 `cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-manager-last-running.test.ts`
2. 若 FAIL，定位失败 case，更新断言或 fixture
3. 重跑直到 PASS

- [ ] **Step 2.6: 跑 runtime-manager-restart.test.ts**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-manager-restart.test.ts
```

若有 FAIL，按 Step 2.5 同样方式更新。

- [ ] **Step 2.7: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：clean。

- [ ] **Step 2.8: commit**

```bash
git add electron/src/main/agent/runtime-manager.ts electron/tests/agent/runtime-manager.test.ts electron/tests/agent/runtime-manager-last-running.test.ts electron/tests/agent/runtime-manager-restart.test.ts
git commit -m "fix(agent): isAgentRunning 改为查 DB last_running（替代 runtimes.has）

修复 v2 task-driven 切换后所有 agent 显示离线的表层 bug。
原因：旧实现仅查 v1 runtimes Map，task-driven agent 永远不在该 Map。
新实现以 DB last_running 字段为权威源，与用户启动意图直接对应。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.2"
```

---

## Task 3: 新增 `destroyTaskDrivenRuntime` + `stopAgentRuntime` 双轨销毁

**Files:**
- Modify: `electron/src/main/agent/runtime-registry.ts`（新增两个导出函数）
- Test: `electron/tests/agent/runtime-registry.test.ts`

**Interfaces:**
- Consumes: `agentRunners` + `agentWarmPools` Map（同模块）；`stopAgent`（runtime-manager.ts）
- Produces: `destroyTaskDrivenRuntime(instanceId: string): void`、`stopAgentRuntime(instanceId: string): Promise<void>`

- [ ] **Step 3.1: 写失败测试**

`electron/tests/agent/runtime-registry.test.ts` 末尾追加：

```typescript
import {
  agentRunners,
  agentWarmPools,
  createTaskDrivenRuntime,
  destroyTaskDrivenRuntime,
  stopAgentRuntime,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { getDb } from '../../src/main/storage/db';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-manager';

// 测试用的最小化 AgentRuntimeOpts fixture
function makeOpts(instanceId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: 'ws-test',
    workspaceDir: '/tmp',
    botUserId: `@${instanceId}:localhost`,
    botAccessToken: 'fake-token',
    homeserverUrl: 'http://localhost:8008',
    systemPrompt: '',
    modelName: 'gpt-4',
    llmApiKey: 'fake-key',
    teamRoomId: '!team:localhost',
    ownerUserId: '@owner:localhost',
    role: 'standalone',
  };
}

describe('destroyTaskDrivenRuntime + stopAgentRuntime (Task 3)', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
  });

  it('destroyTaskDrivenRuntime 移除 runner + pool', () => {
    // 准备：mock spawn 让 createTaskDrivenRuntime 不真 fork 子进程
    const opts = makeOpts('inst-destroy-1');
    // 注意：createTaskDrivenRuntime 内部 spawn 会真 fork；测试需要 mock spawnForAgent
    // 或使用 Vitest 的 vi.mock 替换 runtime-spawn 模块
    // 简化策略：直接 set agentRunners + agentWarmPools 的 entry（绕过 create）
    const fakeRunner = {
      assignmentId: 'inst-destroy-1',
      botUserId: '@bot:localhost',
      workspaceId: 'ws-test',
      destroy: vi.fn(),
      executeTask: vi.fn(),
      abortStream: vi.fn(),
      activeTaskCount: vi.fn().mockReturnValue(0),
      notifyTaskReply: vi.fn(),
    };
    const fakePool = {
      warm: vi.fn(),
      acquire: vi.fn(),
      release: vi.fn(),
      size: vi.fn().mockReturnValue(0),
      destroyAll: vi.fn(),
    };
    agentRunners.set('inst-destroy-1', fakeRunner as any);
    agentWarmPools.set('inst-destroy-1', fakePool as any);

    destroyTaskDrivenRuntime('inst-destroy-1');

    expect(agentRunners.has('inst-destroy-1')).toBe(false);
    expect(agentWarmPools.has('inst-destroy-1')).toBe(false);
    expect(fakeRunner.destroy).toHaveBeenCalledOnce();
    expect(fakePool.destroyAll).toHaveBeenCalledOnce();
  });

  it('destroyTaskDrivenRuntime 对不存在的 instanceId 是 no-op', () => {
    expect(() => destroyTaskDrivenRuntime('inst-not-exist')).not.toThrow();
  });

  it('stopAgentRuntime 写 last_running=0 + 调用 destroyTaskDrivenRuntime', async () => {
    const db = getDb();
    const instId = 'inst-stop-1';
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run(instId, 'ws-test-stop', 'def-x', '@bot:localhost');

    // 准备 fake runner + pool
    const fakeRunner = { destroy: vi.fn(), assignmentId: instId, botUserId: '', workspaceId: '', executeTask: vi.fn(), abortStream: vi.fn(), activeTaskCount: vi.fn(), notifyTaskReply: vi.fn() };
    const fakePool = { destroyAll: vi.fn(), warm: vi.fn(), acquire: vi.fn(), release: vi.fn(), size: vi.fn() };
    agentRunners.set(instId, fakeRunner as any);
    agentWarmPools.set(instId, fakePool as any);

    await stopAgentRuntime(instId);

    // 验证 DB 已写 0
    const row = db.prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?').get(instId) as { last_running: number };
    expect(row.last_running).toBe(0);
    // 验证 runner + pool 已移除
    expect(agentRunners.has(instId)).toBe(false);
    expect(agentWarmPools.has(instId)).toBe(false);
  });
});
```

注意：测试用 `vi` 需文件顶部 `import { vi, describe, it, expect, beforeEach } from 'vitest';`。

- [ ] **Step 3.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-registry.test.ts
```

预期：FAIL，错误信息 `destroyTaskDrivenRuntime is not exported` 或类似。

- [ ] **Step 3.3: 实现 destroyTaskDrivenRuntime + stopAgentRuntime**

`electron/src/main/agent/runtime-registry.ts` 末尾（在 `destroyAllTaskDrivenRuntimes` 之后）追加：

```typescript
/**
 * 销毁单个 task-driven runtime（runner + WarmPool），从全局 Map 移除。
 * - runner.destroy() 反注册 handler + release 活跃 runtime
 * - pool.destroyAll() kill 池中所有 warm 子进程
 * - 从 agentRunners + agentWarmPools Map 移除
 *
 * 不存在 instanceId 时 no-op（用于 stopAgentRuntime 兼容 v1-only agent）。
 */
export function destroyTaskDrivenRuntime(instanceId: string): void {
  const runner = agentRunners.get(instanceId);
  if (runner) {
    runner.destroy();
    agentRunners.delete(instanceId);
  }
  const pool = agentWarmPools.get(instanceId);
  if (pool) {
    pool.destroyAll();
    agentWarmPools.delete(instanceId);
  }
}

/**
 * 统一的 agent 停止入口（v2 修复）。
 * 双轨销毁：v1 子进程（如有）+ v2 task-driven runtime（如有）+ DB last_running=0。
 *
 * 设计：v1 路径调用 runtime-manager.stopAgent（已 UPDATE last_running=0）；
 * v2 路径调用 destroyTaskDrivenRuntime。两者幂等，重复 UPDATE 不冲突。
 *
 * @param instanceId agent_assignment 主键
 */
export async function stopAgentRuntime(instanceId: string): Promise<void> {
  // 1. v1 子进程（如有）—— stopAgent 内部已 UPDATE last_running=0
  const { stopAgent } = await import('./runtime-manager');
  stopAgent(instanceId);
  // 2. v2 task-driven runtime（如有）
  destroyTaskDrivenRuntime(instanceId);
  // 3. 幂等再写一次（v1 stopAgent 已做；本行确保 v2-only 路径也覆盖）
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 0 WHERE instance_id = ?')
    .run(instanceId);
  logger.info('stopAgentRuntime 完成（双轨销毁 + DB 同步）', { instanceId });
}
```

注意：runtime-registry.ts 顶部需 import `getDb`。检查现有 import：

```typescript
import { getDb } from '../storage/db';
```

若已有则跳过；若无则补加。

- [ ] **Step 3.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-registry.test.ts
```

预期：PASS。

- [ ] **Step 3.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：clean。

- [ ] **Step 3.6: commit**

```bash
git add electron/src/main/agent/runtime-registry.ts electron/tests/agent/runtime-registry.test.ts
git commit -m "feat(agent): 新增 destroyTaskDrivenRuntime + stopAgentRuntime 双轨销毁

为 Task 4 IPC agent:stop 改造做铺垫。
- destroyTaskDrivenRuntime：销毁单 agent 的 runner + WarmPool
- stopAgentRuntime：v1 stopAgent + v2 destroy + DB last_running=0 三合一

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.2"
```

---

## Task 4: `agent:stop` IPC handler 改用 `stopAgentRuntime`

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts:522`（agent:stop handler）
- Test: `electron/tests/agent/ipc-stop-start.test.ts`（新增）

**Interfaces:**
- Consumes: `Task 3` 的 `stopAgentRuntime`
- Produces: IPC `agent:stop` 双轨行为

- [ ] **Step 4.1: 写失败测试 — agent:stop 双轨销毁**

`electron/tests/agent/ipc-stop-start.test.ts`（新增文件）：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';
import { getDb } from '../../src/main/storage/db';
import { agentRunners, agentWarmPools, __clearRuntimeRegistryForTest } from '../../src/main/agent/runtime-registry';

// 测试 agent:stop IPC handler 在 task-driven agent 上的行为
// 通过 main.handle 模拟 IPC 调用
describe('agent:stop IPC handler (Task 4)', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
  });

  it('停止 task-driven agent：销毁 runner + 写 last_running=0', async () => {
    // 准备 DB + agentRunners Map 中的 fake runner
    const db = getDb();
    const instId = 'inst-ipc-stop-1';
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run(instId, 'ws-ipc-stop', 'def-x', '@bot:localhost');

    const fakeRunner = { destroy: vi.fn(), assignmentId: instId, botUserId: '', workspaceId: '', executeTask: vi.fn(), abortStream: vi.fn(), activeTaskCount: vi.fn(), notifyTaskReply: vi.fn() };
    const fakePool = { destroyAll: vi.fn(), warm: vi.fn(), acquire: vi.fn(), release: vi.fn(), size: vi.fn() };
    agentRunners.set(instId, fakeRunner as any);
    agentWarmPools.set(instId, fakePool as any);

    // 模拟 IPC 调用：直接拿到 handler 并调用
    const handler = (ipcMain as unknown as { _handlers: Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>> })._handlers.get('agent:stop');
    expect(handler).toBeDefined();
    await handler!(null, instId);

    // 验证
    expect(agentRunners.has(instId)).toBe(false);
    expect(fakeRunner.destroy).toHaveBeenCalledOnce();
    const row = db.prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?').get(instId) as { last_running: number };
    expect(row.last_running).toBe(0);
  });
});
```

注意：`ipcMain._handlers` 是 Electron 内部 API，测试需要 registerIpcHandlers 先调用一次。可在 beforeEach 或测试 setup 中调用。

- [ ] **Step 4.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/ipc-stop-start.test.ts
```

预期：FAIL（旧 handler 只调 v1 stopAgent，task-driven runner 不会被销毁）。

- [ ] **Step 4.3: 改 agent:stop handler**

`electron/src/main/agent/ipc.handlers.ts:522`：

```typescript
ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
  await stopAgentRuntime(instanceId);
});
```

并在文件顶部 import 添加 `stopAgentRuntime`：

```typescript
import { stopAgentRuntime } from './runtime-registry';
```

（已有 `startAgentRuntime` import from './runtime-registry'，仅追加 `stopAgentRuntime` 即可）

- [ ] **Step 4.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/ipc-stop-start.test.ts
```

预期：PASS。

- [ ] **Step 4.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 4.6: commit**

```bash
git add electron/src/main/agent/ipc.handlers.ts electron/tests/agent/ipc-stop-start.test.ts
git commit -m "fix(agent): agent:stop IPC 改用 stopAgentRuntime 双轨销毁

修复 task-driven agent 停止按钮无效的隐藏 bug。
旧实现仅调 v1 stopAgent，task-driven runner 永远不被销毁。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.2"
```

---

## Task 5: `initTaskDrivenRuntime` 加 `lastRunning` 过滤

**Files:**
- Modify: `electron/src/main/index.ts:107-183`（initTaskDrivenRuntime 函数）
- Test: `electron/tests/integration/agent-online-bootstrap.test.ts`（新增）

**Interfaces:**
- Consumes: `Task 1` 的 `lastRunning` 字段
- Produces: app 启动时仅注册 last_running=1 的 task-driven runner

- [ ] **Step 5.1: 写失败测试**

`electron/tests/integration/agent-online-bootstrap.test.ts`（新增文件）：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../src/main/storage/db';
import { agentRunners, __clearRuntimeRegistryForTest } from '../../src/main/agent/runtime-registry';

// 直接测试 initTaskDrivenRuntime 的过滤逻辑
// 因 initTaskDrivenRuntime 是 index.ts 内的私有函数，需 export 出来或重构
// 简化方案：通过 mock + 间接调用入口验证
describe('initTaskDrivenRuntime lastRunning 过滤 (Task 5)', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
  });

  it('仅注册 last_running=1 的 task-driven agent', async () => {
    const db = getDb();
    // 准备 workspace + 2 个 task_driven=1 的 def + 2 个 assignment（1 个 last_running=1，1 个=0）
    const wsId = 'ws-bootstrap-test';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');

    for (const defId of ['def-online', 'def-offline']) {
      db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
        VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
        .run(defId, defId, defId, '1.0.0');
    }

    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run('inst-online', wsId, 'def-online', '@bot-online:localhost');

    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 0, 'standalone', NULL, 0)`)
      .run('inst-offline', wsId, 'def-offline', '@bot-offline:localhost');

    // 调用 initTaskDrivenRuntime
    // 由于函数私有，需通过 export or 动态 import
    // 方案：从 index.ts export initTaskDrivenRuntime（重新 export），或本测试通过 mock 所有依赖直接复制函数逻辑
    // 推荐：index.ts export initTaskDrivenRuntime（无副作用，纯函数级别暴露）
    const { initTaskDrivenRuntime } = await import('../../src/main/index');
    await initTaskDrivenRuntime();

    // 验证：仅 inst-online 在 agentRunners
    expect(agentRunners.has('inst-online')).toBe(true);
    expect(agentRunners.has('inst-offline')).toBe(false);
  });
});
```

注意：测试要求 `index.ts` 导出 `initTaskDrivenRuntime` 函数。当前该函数是模块内私有（`async function initTaskDrivenRuntime`）。需要在 Step 5.3 中加 export。

但 index.ts 通常副作用复杂（启动 app 等），import 时可能触发 `app.whenReady`。建议**抽取 `initTaskDrivenRuntime` 到独立模块**避免 import index.ts 副作用。

调整方案：将 `initTaskDrivenRuntime` 抽到 `electron/src/main/agent/init-runtime.ts` 新文件，index.ts 改 import。

- [ ] **Step 5.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/agent-online-bootstrap.test.ts
```

预期：FAIL（`initTaskDrivenRuntime` 未 export 或 import 失败）。

- [ ] **Step 5.3: 抽取 initTaskDrivenRuntime 到独立模块 + 加 lastRunning 过滤**

新建 `electron/src/main/agent/init-runtime.ts`：

```typescript
// electron/src/main/agent/init-runtime.ts
//
// v2 修复：从 index.ts 抽取 initTaskDrivenRuntime，便于单元测试 + 关注点分离。
// 遍历所有 workspace 的 assignment，为每个 task_driven=1 且 last_running=1 的 agent
// 注册 runner + WarmPool 预热。task_driven=1 但 last_running=0 跳过（用户主动下线）。
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { listAssignments, getAgentDefinition } from './crud';
import { listWorkspaces } from '../workspace/crud';
import { resolveBotToken } from './auto-start';
import { agentRunners, providerBuckets, createTaskDrivenRuntime, populateProviderBuckets } from './runtime-registry';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import { RouterService } from './router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from '../task/dispatcher';
import type { AgentRole } from './types';

/**
 * task-driven runtime 初始化：遍历所有 workspace 的 assignment，
 * 为每个 task_driven=1 且 last_running=1 的 agent 创建 WarmPool + AgentRunner → 预热 → 启动 RouterService。
 * task_driven=1 但 last_running=0 的 agent 跳过（用户主动下线意图）。
 * task_driven=0 的 agent 走 v1 autoStartAgents（由 auth handler 登录流程触发）。
 */
export async function initTaskDrivenRuntime(): Promise<void> {
  for (const ws of listWorkspaces()) {
    for (const assignment of listAssignments(ws.id)) {
      if (agentRunners.has(assignment.instanceId)) continue;
      if (!assignment.enabled) continue;
      if (!assignment.lastRunning) continue;  // ← 关键过滤：仅 last_running=1
      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) continue;
      if (def.taskDriven === false) continue;
      if (!def.modelProviderId) {
        logger.warn('Agent 未配置 modelProviderId，跳过 task-driven 初始化', {
          instanceId: assignment.instanceId, slug: def.slug,
        });
        continue;
      }

      try {
        const botAccessToken = await resolveBotToken(assignment.botMatrixUserId);
        if (!botAccessToken) {
          logger.warn('Bot token 丢失，跳过', { instanceId: assignment.instanceId });
          continue;
        }
        const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

        const runtimeConfig = buildSpawnOpts({
          instanceId: assignment.instanceId,
          botUserId: assignment.botMatrixUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directoryPath,
          teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
          ownerUserId: ws.ownerId,
          def,
          botAccessToken,
          llmApiKey,
          role: assignment.role as AgentRole,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === assignment.instanceId,
        });

        const pool = createTaskDrivenRuntime(runtimeConfig);

        await pool.warm(assignment.instanceId).catch((err) => {
          logger.warn('WarmPool 预热失败', {
            instanceId: assignment.instanceId, error: String(err),
          });
        });

        logger.info('task-driven agent 已初始化', {
          slug: def.slug, instanceId: assignment.instanceId, role: assignment.role,
        });
      } catch (err) {
        logger.warn('task-driven agent 初始化失败', {
          instanceId: assignment.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (agentRunners.size === 0) {
    logger.info('无 task-driven agent，跳过 RouterService 初始化');
    return null;
  }

  populateProviderBuckets();

  const dispatcher = new TaskDispatcher({
    runners: agentRunners,
    buckets: providerBuckets,
    getAgentAssignment: (instanceId) => getAssignmentInfo(instanceId),
    getGlobalMax: () => getGlobalMax(),
  });

  const routerService = new RouterService({ runners: agentRunners, dispatcher });
  routerService.start();
  logger.info('RouterService 已启动', { runnerCount: agentRunners.size });
  return routerService;
}

function getAssignmentInfo(instanceId: string): AgentAssignmentInfo | null {
  const row = getDb().prepare(
    `SELECT a.agent_definition_id, d.model_provider_id, d.max_concurrent_tasks
     FROM agent_assignments a
     JOIN agent_definitions d ON a.agent_definition_id = d.id
     WHERE a.instance_id = ?`,
  ).get(instanceId) as
    | { agent_definition_id: string; model_provider_id: string | null; max_concurrent_tasks: number }
    | undefined;
  if (!row?.model_provider_id) return null;
  return {
    agentDefinitionId: row.agent_definition_id,
    modelProviderId: row.model_provider_id,
    maxConcurrentTasks: row.max_concurrent_tasks,
  };
}

function getGlobalMax(): number {
  const row = getDb().prepare(
    'SELECT max_concurrent_tasks FROM global_settings WHERE id = 1',
  ).get() as { max_concurrent_tasks: number } | undefined;
  return row?.max_concurrent_tasks ?? 3;
}
```

修改 `electron/src/main/index.ts`：
- 删除原 `initTaskDrivenRuntime` 函数（行 102-183）+ `getAssignmentInfo` + `getGlobalMax`
- 改 import：`import { initTaskDrivenRuntime } from './agent/init-runtime';`
- 删除冗余 import：`RouterService`、`TaskDispatcher`、`agentRunners` 等（如不再用）
- 调用点不变（行 78）：`await initTaskDrivenRuntime();`
- 但需要拿到 routerService 引用以传给 setRouterService + before-quit cleanup
- 调整为：`const svc = await initTaskDrivenRuntime(); if (svc) setRouterService(svc);`

`index.ts` 行 78 改：

```typescript
await initTaskDrivenRuntime().then((svc) => {
  if (svc) setRouterService(svc);
});
```

或更清晰：

```typescript
const svc = await initTaskDrivenRuntime();
if (svc) setRouterService(svc);
```

注意：原 index.ts 行 179 `routerService = new RouterService(...)` + 行 181 `setRouterService(routerService)` 改为接收返回值。

- [ ] **Step 5.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/agent-online-bootstrap.test.ts
```

预期：PASS。

注意：测试需要 mock `resolveBotToken` / `resolveApiKey` / `createTaskDrivenRuntime` / `pool.warm`，否则会尝试真 fork 子进程。可在测试文件顶部：

```typescript
vi.mock('../../src/main/agent/auto-start', () => ({
  resolveBotToken: vi.fn().mockResolvedValue('fake-token'),
}));
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: vi.fn().mockReturnValue({}),
  resolveApiKey: vi.fn().mockResolvedValue('fake-key'),
}));
vi.mock('../../src/main/agent/runtime-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/runtime-registry')>();
  return {
    ...actual,
    createTaskDrivenRuntime: vi.fn().mockReturnValue({
      warm: vi.fn().mockResolvedValue(undefined),
    }),
    populateProviderBuckets: vi.fn(),
  };
});
```

如果第一次测试 FAIL，按错误提示完善 mock。

- [ ] **Step 5.5: 跑全部 electron 测试确认无回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run
```

预期：原 851 测试 + 新增测试全 PASS。

- [ ] **Step 5.6: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 5.7: commit**

```bash
git add electron/src/main/agent/init-runtime.ts electron/src/main/index.ts electron/tests/integration/agent-online-bootstrap.test.ts
git commit -m "fix(agent): initTaskDrivenRuntime 加 lastRunning 过滤 + 抽取到独立模块

修复 app 启动后所有 agent 显示离线的核心 bug。
之前仅过滤 enabled=1，未过滤 last_running=1，导致：
  - 用户主动停止的 agent 仍被注册 runner
  - 但 UI 因 IPC isRunning bug 显示离线（与 runner 实际状态不一致）

抽到 init-runtime.ts 便于单元测试 + 关注点分离。
返回 RouterService 实例供 main/index.ts 注入 sync-manager。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.3"
```

---

## Task 6: `rebuildSubAgents` 过滤未启动 sub

**Files:**
- Modify: `electron/src/main/agent/spawn-helpers.ts:38-54`（rebuildSubAgents）
- Test: `electron/tests/agent/spawn-helpers-sub-filter.test.ts`（新增）

**Interfaces:**
- Consumes: `Task 1` 的 `lastRunning` 字段（通过 listSubAssignments 返回）
- Produces: `rebuildSubAgents` 仅返回 last_running=1 的 SubAgentRef[]

- [ ] **Step 6.1: 写失败测试**

`electron/tests/agent/spawn-helpers-sub-filter.test.ts`（新增文件）：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../src/main/storage/db';
import { rebuildSubAgents } from '../../src/main/agent/spawn-helpers';

describe('rebuildSubAgents lastRunning 过滤 (Task 6)', () => {
  beforeEach(() => {
    const db = getDb();
    // 准备 workspace + main def + 3 个 sub def（其中 2 个 last_running=1）
    const wsId = 'ws-sub-filter';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');

    // main
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run('def-main', 'Main', 'main', '1.0.0');
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'main', NULL, 0)`)
      .run('inst-main', wsId, 'def-main', '@main:localhost');

    // 3 subs（2 last_running=1, 1 last_running=0）
    for (const [subId, lastRun] of [['sub-a', 1], ['sub-b', 1], ['sub-c', 0]] as const) {
      db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
        VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
        .run(`def-${subId}`, subId, subId, '1.0.0');
      db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
        VALUES (?, ?, ?, ?, 1, ?, 'sub', ?, 0)`)
        .run(`inst-${subId}`, wsId, `def-${subId}`, `@${subId}:localhost`, lastRun, 'inst-main');
    }
  });

  it('返回 2 个 last_running=1 的 sub（跳过 last_running=0）', () => {
    const subs = rebuildSubAgents('ws-sub-filter', 'inst-main');
    expect(subs).toHaveLength(2);
    const slugs = subs.map((s) => s.slug).sort();
    expect(slugs).toEqual(['sub-a', 'sub-b']);
  });

  it('全部 last_running=0 时返回空数组', () => {
    const db = getDb();
    db.prepare(`UPDATE agent_assignments SET last_running = 0 WHERE workspace_id = ? AND role = 'sub'`).run('ws-sub-filter');
    const subs = rebuildSubAgents('ws-sub-filter', 'inst-main');
    expect(subs).toEqual([]);
  });
});
```

- [ ] **Step 6.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/spawn-helpers-sub-filter.test.ts
```

预期：FAIL（旧实现返回 3 个 sub 含 last_running=0 的）。

- [ ] **Step 6.3: 改 rebuildSubAgents**

`electron/src/main/agent/spawn-helpers.ts:38-54`：

```typescript
export function rebuildSubAgents(
  workspaceId: string,
  mainInstanceId: string,
): SubAgentRef[] {
  const subAssignments = listSubAssignments(workspaceId, mainInstanceId);
  const subs: SubAgentRef[] = [];
  for (const sub of subAssignments) {
    if (!sub.lastRunning) continue;  // v2 修复：仅启动的 sub 才在 dispatch 工具列表
    const subDef = getAgentDefinition(sub.agentDefinitionId);
    if (!subDef) continue;
    subs.push({
      slug: subDef.slug,
      botUserId: sub.botMatrixUserId,
      description: subDef.description,
    });
  }
  return subs;
}
```

- [ ] **Step 6.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/spawn-helpers-sub-filter.test.ts
```

预期：PASS。

- [ ] **Step 6.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 6.6: commit**

```bash
git add electron/src/main/agent/spawn-helpers.ts electron/tests/agent/spawn-helpers-sub-filter.test.ts
git commit -m "feat(agent): rebuildSubAgents 过滤未启动 sub

PM 的 dispatch:<slug> 工具列表仅包含 last_running=1 的 sub。
未启动 sub 在 PM 视角完全不存在（LLM 看不到工具）。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.4"
```

---

## Task 7: `maybeRestartMainForSubChange` + start/stop 末尾触发

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`（新增函数 + agent:start/stop handler 末尾调用）
- Test: `electron/tests/agent/ipc-stop-start.test.ts`（Task 4 已新增，追加 case）

**Interfaces:**
- Consumes: `restartMainForSubChange`（同模块，已存在）
- Produces: `maybeRestartMainForSubChange(instanceId)` 内部 helper

- [ ] **Step 7.1: 追加失败测试到 ipc-stop-start.test.ts**

`electron/tests/agent/ipc-stop-start.test.ts` 末尾追加：

```typescript
import { vi } from 'vitest';

describe('maybeRestartMainForSubChange (Task 7)', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
  });

  it('停止 sub → 触发 parent main 重启', async () => {
    const db = getDb();
    const wsId = 'ws-restart-trigger';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');

    // main assignment
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run('def-main-r', 'Main', 'main-r', '1.0.0');
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'main', NULL, 0)`)
      .run('inst-main-r', wsId, 'def-main-r', '@main:localhost');

    // sub assignment（last_running=1）
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run('def-sub-r', 'Sub', 'sub-r', '1.0.0');
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'sub', ?, 0)`)
      .run('inst-sub-r', wsId, 'def-sub-r', '@sub:localhost', 'inst-main-r');

    // mock startAgentRuntime 验证 main 是否被重启
    const { startAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    const startSpy = vi.spyOn(startAgentRuntime, 'call').mockResolvedValue(undefined);
    // 或直接 mock 模块：vi.mock('../../src/main/agent/runtime-registry', ...)

    // 调 agent:stop on sub
    const handler = (ipcMain as unknown as { _handlers: Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>> })._handlers.get('agent:stop');
    await handler!(null, 'inst-sub-r');

    // 验证：main 被 stop + start（restartMainForSubChange 内部调用）
    // 简化：检查 logger 输出 "Main agent 因 sub 变更已重启" 或 startAgentRuntime 被调用
    expect(startSpy).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  it('停止 standalone → 不触发重启', async () => {
    const db = getDb();
    const wsId = 'ws-no-restart';
    db.prepare(`INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)`)
      .run(wsId, 'test', '@owner:localhost', '/tmp');
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run('def-std-r', 'Std', 'std-r', '1.0.0');
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'standalone', NULL, 0)`)
      .run('inst-std-r', wsId, 'def-std-r', '@std:localhost');

    const { startAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    const startSpy = vi.spyOn(startAgentRuntime, 'call').mockResolvedValue(undefined);

    const handler = (ipcMain as unknown as { _handlers: Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>> })._handlers.get('agent:stop');
    await handler!(null, 'inst-std-r');

    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
  });
});
```

- [ ] **Step 7.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/ipc-stop-start.test.ts
```

预期：FAIL（agent:stop 未触发 main 重启）。

- [ ] **Step 7.3: 实现 maybeRestartMainForSubChange + 接入 start/stop**

`electron/src/main/agent/ipc.handlers.ts`：

在 `restartMainForSubChange` 函数（行 259-301）之后追加新 helper：

```typescript
/**
 * v2 修复：若 instanceId 是 sub，重启其 parent main。
 * 用于 agent:start / agent:stop 末尾——sub 状态变化时让 main 的 dispatch 工具列表刷新。
 *
 * 内部委托 restartMainForSubChange（已存在），仅在 instanceId 是 sub 时执行。
 * standalone / main / parent 不存在时 no-op。
 */
async function maybeRestartMainForSubChange(instanceId: string): Promise<void> {
  const row = getDb()
    .prepare('SELECT workspace_id, role, parent_instance_id FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as
      | { workspace_id: string; role: string; parent_instance_id: string | null }
      | undefined;
  if (row?.role === 'sub' && row.parent_instance_id) {
    await restartMainForSubChange(row.workspace_id, row.parent_instance_id);
  }
}
```

修改 `agent:stop` handler（Task 4 已改）：

```typescript
ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
  await stopAgentRuntime(instanceId);
  await maybeRestartMainForSubChange(instanceId);  // ← 新增
});
```

修改 `agent:start` handler（查找文件中 `ipcMain.handle('agent:start', ...)`）：在末尾追加 `await maybeRestartMainForSubChange(...)`。

- [ ] **Step 7.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/ipc-stop-start.test.ts
```

预期：PASS。

- [ ] **Step 7.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 7.6: commit**

```bash
git add electron/src/main/agent/ipc.handlers.ts electron/tests/agent/ipc-stop-start.test.ts
git commit -m "feat(agent): sub 状态变化触发 parent main 重启刷新 dispatch 工具列表

agent:start / agent:stop 末尾调 maybeRestartMainForSubChange。
仅在 instanceId 是 sub 时触发；standalone / main 无副作用。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.4"
```

---

## Task 8: 删除 agent.store.ts 的 `running` state + syncRunningStates

**Files:**
- Modify: `renderer/src/stores/agent.store.ts`（删除 running state + 相关方法）
- Test: 跑现有 renderer 测试，更新断言

**Interfaces:**
- Consumes: `Task 1` 的 `lastRunning` 字段
- Produces: agent.store 不再含 running，所有 UI 组件改读 `assignment.lastRunning`

- [ ] **Step 8.1: 改 agent.store.ts**

`renderer/src/stores/agent.store.ts`：

1. `AgentState` interface（行 18-61）删除：
   ```typescript
   running: Record<string, boolean>;  // ← 删除
   syncRunningStates: () => Promise<void>;  // ← 删除
   ```

2. 初始 state（行 64-69）删除：
   ```typescript
   running: {},  // ← 删除
   ```

3. `loadAssignments`（行 81-90）删除内部 await：
   ```typescript
   loadAssignments: async (workspaceId) => {
     set({ loading: true, error: null });
     try {
       const list = await ipc.agent.listAssignments(workspaceId);
       set({ assignments: list, loading: false });
       // 删除：await get().syncRunningStates();
     } catch (err) {
       set({ loading: false, error: (err as Error).message });
     }
   },
   ```

4. `syncRunningStates` 整个方法删除（行 101-109）。

5. `addAgent`（行 111-130）删除：
   ```typescript
   running: { ...state.running, [assignment.instanceId]: true },  // ← 删除
   ```

6. `assignMainAgent`（行 132-151）删除：
   ```typescript
   const newRunning: Record<string, boolean> = {};  // ← 删除
   for (const a of newAssignments) newRunning[a.instanceId] = true;  // ← 删除
   ...
   running: { ...state.running, ...newRunning },  // ← 删除
   ```

7. `stopAgent`（行 210-221）删除：
   ```typescript
   set((state) => ({
     running: { ...state.running, [instanceId]: false },  // ← 删除
   }));
   ```
   改为：
   ```typescript
   stopAgent: async (instanceId) => {
     set({ error: null });
     try {
       await ipc.agent.stop(instanceId);
       // v2 修复：删除 running state，由 assignment.lastRunning 替代（Task 9 同步刷新 assignments）
       // 重新加载 assignments 让 lastRunning 反映新状态
       // 但需要知道 workspaceId —— 由调用方提供或从 assignments 查
       const stopped = get().assignments.find((a) => a.instanceId === instanceId);
       if (stopped) {
         await get().loadAssignments(stopped.workspaceId);
       }
     } catch (err) {
       set({ error: (err as Error).message });
       throw err;
     }
   },
   ```

8. `startAgent`（行 223-234）同样改为 reload assignments：
   ```typescript
   startAgent: async (assignment, workspaceId, teamRoomId) => {
     set({ error: null });
     try {
       await ipc.agent.start({ assignment, workspaceId, teamRoomId });
       // v2 修复：reload assignments 反映 lastRunning 新状态
       await get().loadAssignments(workspaceId);
     } catch (err) {
       set({ error: (err as Error).message });
       throw err;
     }
   },
   ```

9. `reset`（行 236-244）删除 running：
   ```typescript
   reset: () =>
     set({
       definitions: [],
       assignments: [],
       // running: {},  ← 删除
       builtinSuggestions: {},
       loading: false,
       error: null,
     }),
   ```

- [ ] **Step 8.2: 修复因 running 删除导致的 TS 错误**

跑 typecheck，定位所有读取 `running` 的位置：

```bash
cd renderer && npx pnpm@9.0.0 typecheck
```

预期位置（Task 9 处理）：
- `renderer/src/components/im/MembersPanel.tsx`（行 11）
- `renderer/src/components/agent/WorkspaceAgentsPanel.tsx`（行 21, 210）
- `renderer/tests/components/im/MembersPanel.test.tsx`（如有）

修复这些文件的逻辑放到 Task 9。本步骤仅 typecheck 确认错误清单。

- [ ] **Step 8.3: commit（store 改动单独 commit，UI 改动放 Task 9）**

```bash
git add renderer/src/stores/agent.store.ts
git commit -m "refactor(renderer): 删除 agent.store 的 running state + syncRunningStates

v2 修复：running state 在 lastRunning 字段引入后完全冗余。
单一数据源 = assignment.lastRunning，从 DB 同步。
UI 改动放 Task 9。

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.5"
```

注意：本 commit 后 typecheck 暂时会 fail（UI 文件未改）。**这是中间态，Task 9 完成后恢复 clean**。本 commit 是 break-the-build 中间状态，符合"分步可回退"原则。如不允许中间态 break，可与 Task 9 合并为一个 commit。

**替代方案**：把 Task 8 + Task 9 合并为一个 commit。本计划保留分开是为了 review 粒度，执行时可合并。

---

## Task 9: UI 组件改造（MentionInput / MembersPanel / WorkspaceAgentsPanel）

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx:68-75`
- Modify: `renderer/src/components/im/MembersPanel.tsx:1-49`
- Modify: `renderer/src/components/agent/WorkspaceAgentsPanel.tsx:18-252`
- Test: `renderer/src/components/im/MembersPanel.test.tsx`、`renderer/tests/components/im/MentionInput.test.tsx`

**Interfaces:**
- Consumes: `Task 1` 的 `lastRunning` 字段
- Produces: UI 统一从 `assignment.lastRunning` 取在线状态

- [ ] **Step 9.1: 改 MentionInput 菜单过滤**

`renderer/src/components/im/MentionInput.tsx:68-75`：

```typescript
const filteredAgents = useMemo(() => {
  if (menuType !== 'agent') return [];
  const q = query.toLowerCase();
  return assignments.filter((a) => {
    if (!a.lastRunning) return false;  // v2 修复：仅在线 agent 进菜单
    const name = a.agentName ?? a.botMatrixUserId;
    return !q || name.toLowerCase().includes(q);
  });
}, [assignments, menuType, query]);
```

- [ ] **Step 9.2: 改 MembersPanel**

`renderer/src/components/im/MembersPanel.tsx`：

```typescript
// 文件顶部 import 改：删除 useAgentStore 的 running，仅取 assignments
import { useAgentStore } from '../../stores/agent.store';

export function MembersPanel() {
  const members = useImStore((s) => s.members);
  const botNameMap = useBotNameMap();
  const assignments = useAgentStore((s) => s.assignments);  // ← 仅取 assignments

  /** 查 member userId 对应的 agent 是否在线（基于 assignment.lastRunning） */
  const isAgentOnline = (userId: string): boolean | null => {
    const a = assignments.find((item) => item.botMatrixUserId === userId);
    if (!a) return null;
    return a.lastRunning;  // ← 替代 running[a.instanceId] === true
  };

  // ...rest unchanged (JSX 部分)
}
```

注意删除原行 11 `const { assignments, running } = useAgentStore();`。

- [ ] **Step 9.3: 改 WorkspaceAgentsPanel AssignmentRow**

`renderer/src/components/agent/WorkspaceAgentsPanel.tsx`：

行 21 改：
```typescript
const { assignments, definitions, loadAssignments, stopAgent, startAgent } = useAgentStore();
// 删除 running
```

行 91, 106, 115, 132 等所有传 `running={running}` 给 AssignmentRow 的地方：删除该 prop。

行 210 改：
```typescript
const isRunning = a.lastRunning;  // 替代 !!running[a.instanceId]
```

`RowProps` interface（行 189-201）删除 `running: Record<string, boolean>;`。

`AssignmentRow` 函数签名（行 203-207）删除 `running` 参数。

- [ ] **Step 9.4: typecheck 双 workspace**

```bash
npx pnpm@9.0.0 typecheck
```

预期：clean。

- [ ] **Step 9.5: 跑 renderer 测试**

```bash
cd renderer && npx pnpm@9.0.0 vitest run
```

预期：可能有测试 fail（依赖 running state 的旧测试）。逐个修复：

- `renderer/src/components/im/MembersPanel.test.tsx`：fixture 改为 assignment 带 lastRunning
- `renderer/tests/components/im/MentionInput.test.tsx`：fixture 改为 assignment 带 lastRunning
- 其他可能受影响：`WorkspaceAgentsPanel` 相关测试

修复策略：把测试中 `running[id] = true/false` 改为 `assignments.find(a => a.instanceId === id).lastRunning = true/false`。

- [ ] **Step 9.6: 跑全部测试套件**

```bash
npx pnpm@9.0.0 test
```

预期：双 workspace 全 PASS（含新增 + 既有）。

- [ ] **Step 9.7: commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MembersPanel.tsx renderer/src/components/agent/WorkspaceAgentsPanel.tsx renderer/src/components/im/MembersPanel.test.tsx renderer/tests/components/im/MentionInput.test.tsx
git commit -m "feat(renderer): UI 组件统一改读 assignment.lastRunning

- MentionInput: 菜单仅显示在线 agent
- MembersPanel: 在线 badge 基于 lastRunning
- WorkspaceAgentsPanel: AssignmentRow 启动状态基于 lastRunning
- 测试 fixture 同步

Refs: docs/superpowers/specs/2026-08-14-agent-online-semantics-redesign.md § 4.5"
```

---

## Task 10: 端到端验证 + 文档更新

**Files:**
- Modify: `electron/src/main/agent/auto-start.ts`（文档注释更新）
- 验证：完整测试套件 + typecheck

- [ ] **Step 10.1: 更新 auto-start.ts 文档注释**

`electron/src/main/agent/auto-start.ts:40-52` 的注释段更新（无行为变化）：

```typescript
/**
 * v1 自动启动入口。
 *
 * 行为：
 *   - 查询 enabled=1 AND last_running=1 的 assignment
 *   - 对每个：
 *     - def.taskDriven !== false → 跳过（v2 修复：由 initTaskDrivenRuntime 接管）
 *     - def.taskDriven === false → 走 v1 spawnAgent 路径
 *
 * v2 架构下：
 *   - task-driven agent 的注册 + WarmPool 预热由 initTaskDrivenRuntime 完成（独立模块）
 *   - 本函数仅作为 v1 fallback 路径保留（task_driven=0 的 agent）
 *   - isAgentRunning 现查询 DB last_running（不再查 runtimes Map）
 *
 * v1.5.8：保留原 token 验证 + 失效 re-login 流程
 */
```

- [ ] **Step 10.2: 跑全部 electron 测试**

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run
```

预期：原 851 测试 + 新增测试全 PASS。

- [ ] **Step 10.3: 跑全部 renderer 测试**

```bash
cd renderer && npx pnpm@9.0.0 vitest run
```

预期：原 407 测试 + 新增/更新测试全 PASS。

- [ ] **Step 10.4: typecheck 双 workspace**

```bash
npx pnpm@9.0.0 typecheck
```

预期：双 workspace clean。

- [ ] **Step 10.5: 验证 § 7 验证标准（手动 e2e）**

若环境支持：
1. 启动 app（容器内 `xvfb-run -a --server-args="-screen 0 1280x800x24"` 或主机 GUI）
2. 切换到 Agents 界面，确认 last_running=1 的 agent 显示"▶ 运行中"
3. 切换到会话界面，确认 MembersPanel 显示对应 bot "在线"
4. 在 MentionInput 输入 `@`，菜单仅显示在线 agent
5. 点击"停止"按钮 → agent 立即变"⏸ 已停止"，MembersPanel 变"离线"
6. 点击"启动"按钮 → agent 立即变"▶ 运行中"

如容器无 GUI，跳过此步；以单元 + 集成测试覆盖为准。

- [ ] **Step 10.6: 最终 commit**

```bash
git add electron/src/main/agent/auto-start.ts
git commit -m "docs(agent): auto-start.ts 注释更新反映 v2 架构

task-driven agent 由 initTaskDrivenRuntime 接管；本函数仅 v1 fallback。
isAgentRunning 现查 DB last_running。无行为变化。"
```

---

## 验收清单

完成所有 task 后，确认：

- [ ] `npx pnpm@9.0.0 typecheck` 双 workspace clean
- [ ] `npx pnpm@9.0.0 test` 全 PASS（含新增 + 既有）
- [ ] spec § 7 验证标准 1-9 全部满足
- [ ] 共 6 commit（Task 1-7 各一 + Task 8/9 合并 + Task 10 文档）
- [ ] 没有 `as any` / `@ts-ignore`
- [ ] 中文注释完整
- [ ] commit message 用 Conventional Commits

---

## 实施依赖图

```
Task 1 (类型补全)
  ↓
  ├─→ Task 2 (isAgentRunning)
  ├─→ Task 3 (destroyTaskDrivenRuntime + stopAgentRuntime)
  │     ↓
  │     Task 4 (agent:stop IPC)
  │       ↓
  │       Task 7 (maybeRestartMainForSubChange)
  ├─→ Task 5 (initTaskDrivenRuntime 加 lastRunning 过滤)
  ├─→ Task 6 (rebuildSubAgents 过滤)
  └─→ Task 8 (删除 running state)
        ↓
        Task 9 (UI 组件改造)
          ↓
          Task 10 (e2e 验证 + 文档)
```

**关键路径**：Task 1 → Task 5 → Task 9 → Task 10。
**可并行**：Task 2、3、6 在 Task 1 后可并行。
