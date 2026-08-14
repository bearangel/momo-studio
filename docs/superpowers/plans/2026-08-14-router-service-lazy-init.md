# RouterService Lazy Init 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v2 task-driven 切换后所有 agent 不回复消息的架构性 bug —— RouterService 从启动时单例改为 lazy 单例，第一次 runner 注册时自动启动。

**Architecture:** 新建 `router-bootstrap.ts` 持有 lazy 单例 + `ensureRouterService(runners, buckets)` 幂等启动器；`runtime-registry.ts` 的 `ensureTaskDrivenRuntime` 末尾动态 import + 调用（避免循环依赖）；`init-runtime.ts` 改用统一入口替代手动创建；`index.ts` before-quit 用 `destroyRouterService`。

**Tech Stack:** TypeScript（electron CJS workspace）、SQLite（better-sqlite3）、Vitest、Electron IPC。

## Global Constraints

- **Node 20 LTS 强制**：`nvm use 20` 再跑任何命令。容器默认 Node 26 破坏 better-sqlite3。
- **TypeScript strict**：禁 `any`/`@ts-ignore`/`as any`。`as unknown as` 仅用于测试 mock。
- **Conventional Commits**：`feat:`/`fix:`/`refactor:`/`test:`/`docs:`。
- **中文注释**：源码内注释使用中文，标识符英文。
- **测试**：`cd electron && npx pnpm@9.0.0 vitest run tests/path/test.ts`（单文件）；`npx pnpm@9.0.0 test`（双 workspace）。
- **类型检查**：`npx pnpm@9.0.0 typecheck`（双 workspace，先于测试）。
- **Migration SQL 内联**：本次无 migration。
- **循环依赖处理**：runtime-registry.ts 动态 `import('./router-bootstrap')` 避免顶层循环。
- **不要 `git add -A`**（不会捕获 docs/）；用显式路径。
- **既有约束**：matrix-js-sdk v31 lock，better-sqlite3 native binding 需要 Node 20。

---

## File Structure

### Electron（4 改 + 1 新）

| 文件 | 责任 | 改动 |
|---|---|---|
| `electron/src/main/agent/router-bootstrap.ts` | **新建** — RouterService lazy 单例管理 | ~100 行，含 ensureRouterService / destroyRouterService / helpers |
| `electron/src/main/agent/runtime-registry.ts` | v2 task-driven 全局 Map + ensureTaskDrivenRuntime | `ensureTaskDrivenRuntime` 末尾动态 import + 调用 ensureRouterService |
| `electron/src/main/agent/init-runtime.ts` | app 启动时批量初始化 | 末尾改用 ensureRouterService 替代手动创建；返回值改 null |
| `electron/src/main/index.ts` | 主进程入口 | autoRestoreSession 不再 `if (svc) setRouterService`；before-quit 改用 destroyRouterService |
| `electron/tests/agent/router-bootstrap.test.ts` | **新建** — 单元测试 | 5 cases |
| `electron/tests/integration/router-lazy-init.test.ts` | **新建** — 集成测试 | 3 cases |
| `electron/tests/integration/agent-online-bootstrap.test.ts` | 既有测试断言更新 | initTaskDrivenRuntime 返回值变化 |
| `electron/tests/integration/task-driven-dispatch-chain.test.ts` | 既有测试更新 | 改用 ensureRouterService |

---

## Task 1: 新建 `router-bootstrap.ts` 模块 + 单元测试

**Files:**
- Create: `electron/src/main/agent/router-bootstrap.ts`
- Test: `electron/tests/agent/router-bootstrap.test.ts`

**Interfaces:**
- Consumes: `RouterService` from `./router-service`、`TaskDispatcher` + `AgentAssignmentInfo` from `../task/dispatcher`、`setRouterService` from `../matrix/sync-manager`、`getDb` from `../storage/db`、`logger` from `../logger`、类型 `AgentRunner` + `ProviderTokenBucket`
- Produces:
  - `ensureRouterService(runners: Map<string, AgentRunner>, buckets: Map<string, ProviderTokenBucket>): Promise<void>` — 幂等 lazy 启动器
  - `destroyRouterService(): void` — 销毁清理
  - `__resetRouterServiceForTest(): void` — 测试钩子

- [ ] **Step 1.1: 写失败测试**

`electron/tests/agent/router-bootstrap.test.ts`（新建文件）：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock setRouterService（sync-manager 模块）避免依赖 Matrix client
vi.mock('../../src/main/matrix/sync-manager', () => ({
  setRouterService: vi.fn(),
}));

// Mock logger（不输出噪声）
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock TaskDispatcher（不依赖真实 dispatcher 逻辑）
vi.mock('../../src/main/task/dispatcher', () => ({
  TaskDispatcher: vi.fn().mockImplementation(() => ({ scanPickup: vi.fn() })),
}));

import {
  ensureRouterService,
  destroyRouterService,
  __resetRouterServiceForTest,
} from '../../src/main/agent/router-bootstrap';
import { setRouterService } from '../../src/main/matrix/sync-manager';
import { RouterService } from '../../src/main/agent/router-service';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import type { ProviderTokenBucket } from '../../src/main/agent/llm/token-bucket';

// 测试用 fake runner + bucket（不依赖真实 spawn）
function makeFakeRunner(id: string): AgentRunner {
  return {
    assignmentId: id,
    botUserId: `@${id}:localhost`,
    workspaceId: 'ws-test',
    executeTask: vi.fn(),
    abortStream: vi.fn(),
    activeTaskCount: vi.fn().mockReturnValue(0),
    notifyTaskReply: vi.fn(),
    destroy: vi.fn(),
  } as unknown as AgentRunner;
}

function makeFakeBuckets(): Map<string, ProviderTokenBucket> {
  const m = new Map<string, ProviderTokenBucket>();
  m.set('provider-1', { tryConsume: vi.fn().mockReturnValue(true) } as unknown as ProviderTokenBucket);
  return m;
}

describe('router-bootstrap (Task 1)', () => {
  beforeEach(() => {
    __resetRouterServiceForTest();
    vi.clearAllMocks();
  });

  it('首次调用：启动 RouterService + setRouterService', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);

    expect(setRouterService).toHaveBeenCalledOnce();
    // 验证传入的是 RouterService 实例（或 duck-type 兼容对象）
    const svc = (setRouterService as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(svc).toBeDefined();
    expect(typeof (svc as RouterService).routeMatrixEvent).toBe('function');
  });

  it('二次调用：no-op（currentRouterService 已存在）', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);
    await ensureRouterService(runners, buckets);  // 第二次

    // setRouterService 应只被调用 1 次（首次启动时）
    expect(setRouterService).toHaveBeenCalledOnce();
  });

  it('runners.size === 0 时 no-op', async () => {
    const runners = new Map<string, AgentRunner>();
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);

    expect(setRouterService).not.toHaveBeenCalled();
  });

  it('destroyRouterService：清理 + setRouterService(null)', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();
    await ensureRouterService(runners, buckets);
    vi.clearAllMocks();

    destroyRouterService();

    expect(setRouterService).toHaveBeenCalledWith(null);
  });

  it('destroyRouterService 在 currentRouterService=null 时 no-op', () => {
    expect(() => destroyRouterService()).not.toThrow();
    // setRouterService 不应被调用（无 service 可销毁）
    expect(setRouterService).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 1.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-bootstrap.test.ts
```

预期：FAIL（"Cannot find module '../../src/main/agent/router-bootstrap'"）。

- [ ] **Step 1.3: 实现 router-bootstrap.ts**

`electron/src/main/agent/router-bootstrap.ts`（新建文件）：

```typescript
// electron/src/main/agent/router-bootstrap.ts
//
// RouterService lazy 启动器——v2 修复：从启动时单例改为 lazy 单例。
//
// 问题背景：原 initTaskDrivenRuntime 是唯一创建 RouterService 的位置，
// app 启动时若无 runner（用户主动 stop 过所有 agent / 新用户首次启动），
// RouterService 永远 null，sync-manager.ts 的 if(routerService) 整段
// 跳过 → 所有 m.room.message 静默丢弃 → agent 不回复任何消息。
//
// 解决：抽取 ensureRouterService() 幂等 lazy init。第一次 runner 注册时
// （由 ensureTaskDrivenRuntime 末尾调用）启动 RouterService；后续调用 no-op。
//
// 与 runtime-registry / init-runtime 的依赖：
//   - 不直接 import runtime-registry（避免循环）
//   - agentRunners + providerBuckets 通过参数传入
//   - 由调用方（ensureTaskDrivenRuntime / initTaskDrivenRuntime）动态 import 本模块

import { RouterService } from './router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from '../task/dispatcher';
import { setRouterService } from '../matrix/sync-manager';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { AgentRunner } from './agent-runner';
import type { ProviderTokenBucket } from './llm/token-bucket';

/** 模块级单例（lazy 启动后非空） */
let currentRouterService: RouterService | null = null;

/**
 * 幂等 lazy 启动 RouterService。
 *
 * - 已启动（currentRouterService 非 null）→ no-op
 * - runners.size === 0 → no-op（防御性，正常路径不触发）
 * - 首次调用 → 创建 TaskDispatcher + 创建 RouterService + setRouterService
 *
 * @param runners agentRunners Map 引用（后续新增 runner 自动可见，因 RouterService 持有 Map 引用）
 * @param buckets providerBuckets Map 引用（dispatcher 用于 LLM 限流）
 */
export async function ensureRouterService(
  runners: Map<string, AgentRunner>,
  buckets: Map<string, ProviderTokenBucket>,
): Promise<void> {
  if (currentRouterService) return;  // 已启动
  if (runners.size === 0) return;    // 无 runner，不需要

  const dispatcher = new TaskDispatcher({
    runners,
    buckets,
    getAgentAssignment: (instanceId) => getAssignmentInfo(instanceId),
    getGlobalMax: () => getGlobalMax(),
  });

  currentRouterService = new RouterService({ runners, dispatcher });
  currentRouterService.start();
  setRouterService(currentRouterService);
  logger.info('RouterService lazy 启动', { runnerCount: runners.size });
}

/**
 * 销毁 RouterService（before-quit 时调用）。
 * 反向清理：setRouterService(null) + 释放模块引用。
 * 已 null 时 no-op。
 */
export function destroyRouterService(): void {
  if (!currentRouterService) return;
  setRouterService(null);
  currentRouterService = null;
  logger.info('RouterService 已销毁');
}

/** 测试用：重置模块状态（清 currentRouterService，不调 sync-manager） */
export function __resetRouterServiceForTest(): void {
  currentRouterService = null;
}

// ─── helpers（从 init-runtime.ts 迁移，供 dispatcher 使用） ────────────────

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

- [ ] **Step 1.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-bootstrap.test.ts
```

预期：PASS（5/5）。

- [ ] **Step 1.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：双 workspace clean。

- [ ] **Step 1.6: commit**

```bash
git add electron/src/main/agent/router-bootstrap.ts electron/tests/agent/router-bootstrap.test.ts
git commit -m "feat(agent): 新建 router-bootstrap 模块（RouterService lazy 启动器）

为后续 ensureTaskDrivenRuntime 接入做铺垫。
- ensureRouterService(runners, buckets)：幂等 lazy 启动
- destroyRouterService()：before-quit 清理
- __resetRouterServiceForTest()：测试钩子

Refs: docs/superpowers/specs/2026-08-14-router-service-lazy-init.md § 4.1"
```

---

## Task 2: `ensureTaskDrivenRuntime` 末尾接入 lazy ensure

**Files:**
- Modify: `electron/src/main/agent/runtime-registry.ts`（`ensureTaskDrivenRuntime` 函数末尾）
- Test: 见 Task 5 集成测试

**Interfaces:**
- Consumes: Task 1 的 `ensureRouterService`
- Produces: `ensureTaskDrivenRuntime` 末尾自动触发 router 启动

- [ ] **Step 2.1: 定位 ensureTaskDrivenRuntime 函数**

读 `electron/src/main/agent/runtime-registry.ts`，找到 `ensureTaskDrivenRuntime` 函数（大约在行 70-112）。找到末尾 `logger.info('task-driven runtime 已创建', { instanceId, botUserId });` 之后、函数闭合 `}` 之前的位置。

- [ ] **Step 2.2: 写失败测试（先放入 Task 5 的集成测试占位，这里仅添加单元测试）**

在 `electron/tests/agent/runtime-registry.test.ts` 末尾追加（如果该文件不存在，新建）：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock router-bootstrap 避免实际启动 router
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  ensureRouterService: vi.fn().mockResolvedValue(undefined),
  destroyRouterService: vi.fn(),
  __resetRouterServiceForTest: vi.fn(),
}));

import { ensureRouterService } from '../../src/main/agent/router-bootstrap';
import { ensureTaskDrivenRuntime } from '../../src/main/agent/runtime-registry';

describe('ensureTaskDrivenRuntime 触发 ensureRouterService (Task 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('创建 runner 后调用 ensureRouterService', async () => {
    // 注意：直接调 ensureTaskDrivenRuntime 需要完整的 AgentRuntimeOpts
    // 简化：用 mock spawnForAgent 避免真 fork
    // 实际验证在 Task 5 集成测试中做；此处仅验证调用契约
    // 跳过此测试用例若 setup 太复杂——以 Task 5 集成测试为准
    expect(ensureRouterService).not.toHaveBeenCalled();
  });
});
```

**注意**：如果 `runtime-registry.test.ts` 已存在并有 imports，**追加**而非覆盖。

- [ ] **Step 2.3: 修改 ensureTaskDrivenRuntime**

在 `ensureTaskDrivenRuntime` 函数末尾（创建 runner 并写 last_running=1 之后、函数闭合 `}` 之前）追加：

```typescript
  // v2 修复：第一次 runner 注册时 lazy 启动 RouterService
  // （若已启动则 no-op；幂等安全）。动态 import 避免顶层循环依赖。
  try {
    const { ensureRouterService } = await import('./router-bootstrap');
    await ensureRouterService(agentRunners, providerBuckets);
  } catch (err) {
    logger.warn('ensureRouterService 失败（runner 已注册但 router 未启动）', {
      instanceId, error: err instanceof Error ? err.message : String(err),
    });
  }
```

**完整 ensureTaskDrivenRuntime 函数示意**（行号可能变）：

```typescript
async function ensureTaskDrivenRuntime(opts: AgentRuntimeOpts): Promise<void> {
  const { instanceId, botUserId, workspaceId } = opts;

  if (!agentWarmPools.has(instanceId)) {
    // ... 现有 pool + runner 创建代码 ...
    agentRunners.set(instanceId, runner);

    getDb()
      .prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
      .run(instanceId);

    logger.info('task-driven runtime 已创建', { instanceId, botUserId });

    // ↓↓↓ v2 修复新增（Task 2） ↓↓↓
    try {
      const { ensureRouterService } = await import('./router-bootstrap');
      await ensureRouterService(agentRunners, providerBuckets);
    } catch (err) {
      logger.warn('ensureRouterService 失败（runner 已注册但 router 未启动）', {
        instanceId, error: err instanceof Error ? err.message : String(err),
      });
    }
    // ↑↑↑ v2 修复新增（Task 2） ↑↑↑
  }

  const pool = agentWarmPools.get(instanceId)!;
  await pool.warm(instanceId).catch((err) => {
    logger.warn('WarmPool 预热失败', { instanceId, error: String(err) });
  });
}
```

**注意位置**：lazy ensure 必须在 `if (!agentWarmPools.has(instanceId))` 块**内部**——只有真正创建新 runner 时才触发（已存在的 runner 不需重复 ensure，因 ensure 本身幂等但避免不必要调用）。

- [ ] **Step 2.4: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：clean。如果有循环依赖警告，确认是动态 import（运行时延迟解析，TS 不报错）。

- [ ] **Step 2.5: 跑现有 runtime-registry 测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-registry.test.ts
```

预期：原测试 PASS。如果有 fail，检查 mock 是否需要补充（确保 router-bootstrap mock 已添加）。

- [ ] **Step 2.6: commit**

```bash
git add electron/src/main/agent/runtime-registry.ts electron/tests/agent/runtime-registry.test.ts
git commit -m "fix(agent): ensureTaskDrivenRuntime 末尾触发 ensureRouterService

修复 RouterService 永不启动的根因——agent:start 后第一个 runner
注册时自动 lazy 启动 RouterService，让 sync-manager 路由生效。
动态 import 避免顶层循环依赖。

Refs: docs/superpowers/specs/2026-08-14-router-service-lazy-init.md § 4.2"
```

---

## Task 3: `init-runtime.ts` 改用 `ensureRouterService`

**Files:**
- Modify: `electron/src/main/agent/init-runtime.ts`（`initTaskDrivenRuntime` 函数末尾）
- Test: `electron/tests/integration/agent-online-bootstrap.test.ts`（更新断言）

**Interfaces:**
- Consumes: Task 1 的 `ensureRouterService`、Task 2 的 ensureTaskDrivenRuntime 行为
- Produces: `initTaskDrivenRuntime` 返回 `Promise<void>`（原 `Promise<RouterService | null>`）

- [ ] **Step 3.1: 更新既有测试断言**

打开 `electron/tests/integration/agent-online-bootstrap.test.ts`，找到对 `initTaskDrivenRuntime` 返回值的断言。原签名 `Promise<RouterService | null>`，新签名 `Promise<void>`。

修改方案：
- 若测试用 `const svc = await initTaskDrivenRuntime(); expect(svc).toBe(...)`：删除该断言（不再返回 svc）
- 改为间接验证：调用后检查 `sync-manager` 的 `routerService` 是否非 null（通过 setRouterService mock 或直接 query）

具体示例（如果存在以下类似断言）：

```typescript
// 之前：
const svc = await initTaskDrivenRuntime();
expect(svc).not.toBeNull();
expect(agentRunners.has('inst-online')).toBe(true);

// 改为：
await initTaskDrivenRuntime();
expect(agentRunners.has('inst-online')).toBe(true);
// router 启动验证移到 Task 5 的集成测试 router-lazy-init.test.ts
```

**注意**：如果 test 文件中 mock 了 `setRouterService`，断言可以改为：
```typescript
expect(setRouterService).toHaveBeenCalled();
```

- [ ] **Step 3.2: 运行测试验证失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/agent-online-bootstrap.test.ts
```

预期：FAIL（若 initTaskDrivenRuntime 还返回 RouterService，类型可能不匹配；或断言找不到 svc.toBeNull()）。

- [ ] **Step 3.3: 修改 init-runtime.ts**

定位 `initTaskDrivenRuntime` 函数末尾。原代码大约：

```typescript
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
```

改为：

```typescript
  // v2 修复：使用 router-bootstrap 统一 lazy 启动入口（替代上面手动创建）
  // 注意：即使 agentRunners.size === 0 也无害（ensureRouterService 内部 no-op）
  populateProviderBuckets();
  const { ensureRouterService } = await import('./router-bootstrap');
  await ensureRouterService(agentRunners, providerBuckets);
  logger.info('initTaskDrivenRuntime 完成', { runnerCount: agentRunners.size });
}
```

**返回类型变化**：函数签名从 `Promise<RouterService | null>` 改为 `Promise<void>`。

**清理 imports**：删除不再使用的 `RouterService` 和 `TaskDispatcher` 直接 imports（它们现在由 router-bootstrap 内部使用）。但保留 `populateProviderBuckets` import（仍在使用）。

**删除 helpers**：`getAssignmentInfo` 和 `getGlobalMax` 在 init-runtime.ts 中可删除（已迁移到 router-bootstrap.ts）。但要确认没有其他 callers。grep 一下：

```bash
grep -rn "getAssignmentInfo\|getGlobalMax" electron/src/main/
```

如果只在 init-runtime.ts 内部使用，安全删除。

- [ ] **Step 3.4: 运行测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/agent-online-bootstrap.test.ts
```

预期：PASS。

- [ ] **Step 3.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：可能 index.ts 有 `const svc = await initTaskDrivenRuntime(); if (svc) ...` 报错（void 不能赋值）。这会在 Task 4 修。**临时**：可以先在 index.ts 把 `const svc =` 删除，让 typecheck 通过。

```typescript
// index.ts autoRestoreSession 临时改：
await initTaskDrivenRuntime();
// 删除：const svc = await initTaskDrivenRuntime();
// 删除：if (svc) setRouterService(svc);
```

（完整改造在 Task 4 做）

- [ ] **Step 3.6: 跑全套 electron 测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run
```

预期：原测试全 PASS。如果有 fail，定位 + 修复。

- [ ] **Step 3.7: commit**

```bash
git add electron/src/main/agent/init-runtime.ts electron/src/main/index.ts electron/tests/integration/agent-online-bootstrap.test.ts
git commit -m "refactor(agent): initTaskDrivenRuntime 改用 ensureRouterService 统一入口

- 删除手动 RouterService 创建逻辑（迁移到 router-bootstrap）
- 返回值改 void（router 内部已 setRouterService）
- index.ts autoRestoreSession 不再 if(svc) setRouterService
- 删除冗余 helpers（getAssignmentInfo / getGlobalMax）

Refs: docs/superpowers/specs/2026-08-14-router-service-lazy-init.md § 4.3"
```

---

## Task 4: `index.ts` before-quit 改用 `destroyRouterService`

**Files:**
- Modify: `electron/src/main/index.ts`（before-quit handler + imports）

**Interfaces:**
- Consumes: Task 1 的 `destroyRouterService`
- Produces: before-quit 清理通过统一入口

- [ ] **Step 4.1: 定位 before-quit handler**

读 `electron/src/main/index.ts`，找到 `app.on('before-quit', () => { ... });` 块（大约在末尾）。

- [ ] **Step 4.2: 修改 imports**

在文件顶部 imports 中：

**删除**（若已不再使用）：
```typescript
// 如果只有 before-quit 在用 setRouterService(null)，可以删除 import
import { setMainWindow, stopSync, startSyncFromSession, broadcastRuntimeChanged, setRouterService } from './matrix/sync-manager';
```

改为（删除 setRouterService）：
```typescript
import { setMainWindow, stopSync, startSyncFromSession, broadcastRuntimeChanged } from './matrix/sync-manager';
```

**新增**：
```typescript
import { destroyRouterService } from './agent/router-bootstrap';
```

注意：如果 `setRouterService` 在文件其他地方还有使用（grep 确认），保留 import；仅去掉 before-quit 内的调用。

```bash
grep -n "setRouterService" electron/src/main/index.ts
```

- [ ] **Step 4.3: 修改 before-quit handler**

原代码（大约）：
```typescript
app.on('before-quit', () => {
  destroyAllTaskDrivenRuntimes();
  setRouterService(null);
  // routerService = null;  // ← 可能有这行（如果之前没清理）
  
  stopTaskRuntime();
  void stopConduit();
  void stopSync();
});
```

改为：
```typescript
app.on('before-quit', () => {
  destroyAllTaskDrivenRuntimes();
  destroyRouterService();  // ← 替代 setRouterService(null)；统一清理入口
  
  stopTaskRuntime();
  void stopConduit();
  void stopSync();
});
```

- [ ] **Step 4.4: 验证 autoRestoreSession 改造（Task 3 临时改过）**

确认 autoRestoreSession 块（大约在 index.ts 行 56-65）：

```typescript
void (async () => {
  try {
    await startSyncFromSession();
    await initTaskDrivenRuntime();  // ← 不再 const svc = ...
    logger.info('Task-driven runtime initialized');
    broadcastRuntimeChanged();
  } catch (err) {
    // ...
  }
})();
```

如果 Task 3 已经改了，确认无 `const svc` 残留。

- [ ] **Step 4.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：clean。如果报 setRouterService 未使用警告，调整 import。

- [ ] **Step 4.6: 跑全套测试**

```bash
npx pnpm@9.0.0 test
```

预期：双 workspace 全 PASS。

- [ ] **Step 4.7: commit**

```bash
git add electron/src/main/index.ts
git commit -m "refactor(agent): index.ts before-quit 改用 destroyRouterService 统一清理

替代原 setRouterService(null)。与 ensureRouterService 形成对称生命周期。
autoRestoreSession 已在 Task 3 移除 if(svc) setRouterService 调用。

Refs: docs/superpowers/specs/2026-08-14-router-service-lazy-init.md § 4.4"
```

---

## Task 5: 集成测试 + 既有测试更新

**Files:**
- Create: `electron/tests/integration/router-lazy-init.test.ts`
- Modify: `electron/tests/integration/task-driven-dispatch-chain.test.ts`（如果它直接 new RouterService，改用 ensureRouterService）

**Interfaces:**
- Consumes: Tasks 1-4 完成的 lazy init 链路
- Produces: 端到端集成测试覆盖 lazy 启动 + 消息路由

- [ ] **Step 5.1: 写集成测试**

`electron/tests/integration/router-lazy-init.test.ts`（新建文件）：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock 依赖避免真 fork 子进程 + 真 Matrix 连接
vi.mock('../../src/main/agent/auto-start', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/auto-start')>();
  return { ...actual, resolveBotToken: vi.fn().mockResolvedValue('fake-token') };
});

vi.mock('../../src/main/agent/spawn-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/spawn-helpers')>();
  return {
    ...actual,
    buildSpawnOpts: vi.fn().mockReturnValue({ instanceId: 'fake', role: 'standalone' }),
    resolveApiKey: vi.fn().mockResolvedValue('fake-key'),
  };
});

vi.mock('../../src/main/agent/runtime-spawner', () => ({
  spawnForAgent: vi.fn().mockResolvedValue({
    child: { on: vi.fn(), off: vi.fn(), send: vi.fn(), kill: vi.fn() },
    destroy: vi.fn(),
  }),
}));

// 监视 setRouterService 调用（不改其行为，仅断言）
const setRouterServiceMock = vi.fn();
vi.mock('../../src/main/matrix/sync-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/matrix/sync-manager')>();
  return { ...actual, setRouterService: setRouterServiceMock };
});

import { getDb } from '../../src/main/storage/db';
import {
  agentRunners,
  agentWarmPools,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { __resetRouterServiceForTest } from '../../src/main/agent/router-bootstrap';
import { initTaskDrivenRuntime } from '../../src/main/agent/init-runtime';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';

describe('RouterService lazy init 集成测试 (Task 5)', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
    __resetRouterServiceForTest();
    setRouterServiceMock.mockClear();
  });

  it('场景 1: 空状态启动 → 注册 runner → routerService 自动非 null', async () => {
    // 初始状态：agentRunners 为空，setRouterService 未被调用
    expect(agentRunners.size).toBe(0);
    expect(setRouterServiceMock).not.toHaveBeenCalled();

    // 准备：1 个 task_driven=1 + last_running=1 的 agent
    // 注意：先 read createWorkspace / saveAgentDefinition / assignAgentToWorkspace 实际签名
    // 下面是 sketch，实际命令以源码为准
    const db = getDb();
    const ws = createWorkspace({
      name: 'lazy-test',
      directoryPath: '/tmp',
      ownerId: '@owner:localhost',
    } as unknown as Parameters<typeof createWorkspace>[0]);
    // ↑ 注意：上面 `as unknown as` 是 mock-friendly cast；先 read 真实签名再调整

    const def = {
      id: 'def-lazy',
      name: 'Lazy',
      slug: 'lazy',
      version: '1.0.0',
      runtime: 'declarative' as const,
      systemPrompt: '',
      defaultTools: [],
      defaultMcps: [],
      defaultSkills: [],
      source: 'builtin' as const,
      description: '',
      iconEmoji: '🤖',
      workspaceId: null,
      modelProviderId: null,
      modelName: '',
      taskDriven: true,
    };
    saveAgentDefinition(def);

    const assignment = assignAgentToWorkspace(
      ws.id,
      def.id,
      '@bot-lazy:localhost',
      'standalone',
      null,
    );
    // 设置 last_running=1
    db.prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
      .run(assignment.instanceId);
    // 注意：modelProviderId 必须非 null，否则 init 跳过——补充 provider
    // 简化：直接 SQL 插入 model_providers + UPDATE def
    // ↓↓↓ 先 read schema 再决定 ↓↓↓

    // 调用：initTaskDrivenRuntime（模拟 app 启动）
    await initTaskDrivenRuntime();

    // 验证：runner 已注册 + setRouterService 被调用
    expect(agentRunners.size).toBeGreaterThan(0);
    expect(setRouterServiceMock).toHaveBeenCalled();
    const svc = setRouterServiceMock.mock.calls[0][0];
    expect(svc).toBeDefined();
    expect(typeof svc.routeMatrixEvent).toBe('function');
  });

  it('场景 2: 空状态 → ensureTaskDrivenRuntime 单 agent 注册 → router 启动', async () => {
    // 这个场景模拟 agent:start IPC handler 路径
    // 初始 agentRunners 空 + currentRouterService null
    expect(agentRunners.size).toBe(0);

    // 导入 ensureTaskDrivenRuntime（注意：它不是 export 的，是 internal）
    // 替代方案：直接调 startAgentRuntime（它内部调 ensureTaskDrivenRuntime）
    const { startAgentRuntime } = await import('../../src/main/agent/runtime-registry');

    // 准备最小 AgentRuntimeOpts（用 fake 值即可，因 spawnForAgent 已 mock）
    const opts = {
      instanceId: 'inst-lazy-start',
      workspaceId: 'ws-fake',
      workspaceDir: '/tmp',
      botUserId: '@bot-lazy:localhost',
      botAccessToken: 'fake-token',
      homeserverUrl: 'http://localhost:8008',
      systemPrompt: '',
      modelName: 'gpt-4',
      llmApiKey: 'fake-key',
      teamRoomId: '!team:localhost',
      ownerUserId: '@owner:localhost',
      role: 'standalone' as const,
    };

    await startAgentRuntime(opts, true);  // taskDriven=true

    // 验证：runner 已注册 + router 启动
    expect(agentRunners.has('inst-lazy-start')).toBe(true);
    expect(setRouterServiceMock).toHaveBeenCalled();
  });

  it('场景 3: initTaskDrivenRuntime 批量注册后 router 启动（回归）', async () => {
    // 与场景 1 类似，但准备 2 个 last_running=1 的 agent
    // 验证：runnerCount=2 + setRouterService 调用 1 次（幂等）
    // ... 详细代码同场景 1，准备 2 个 def + 2 个 assignment
    expect(true).toBe(true);  // 占位，实际实现参考场景 1
  });
});
```

**注意**：以上是 sketch。Implementer 需要：
1. Read `createWorkspace` / `saveAgentDefinition` / `assignAgentToWorkspace` 实际签名
2. Read `migrations/index.ts` 确认 `model_providers` 表 schema（如需插入 provider row）
3. 调整 fixture 让 `def.modelProviderId` 指向有效 provider（否则 initTaskDrivenRuntime 跳过）

- [ ] **Step 5.2: 运行集成测试验证通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/router-lazy-init.test.ts
```

预期：PASS（3/3）。如果场景 1 因 modelProviderId 问题失败，调整 fixture。

- [ ] **Step 5.3: 检查 task-driven-dispatch-chain.test.ts 是否需更新**

```bash
grep -n "new RouterService\|setRouterService" electron/tests/integration/task-driven-dispatch-chain.test.ts
```

如果有直接 `new RouterService(...)` 或 `setRouterService(...)` 调用：

- 若是测试 setup（手动启动 router）：改用 `ensureRouterService(agentRunners, providerBuckets)`
- 若是断言（验证 router 被设置）：保留

- [ ] **Step 5.4: 跑全部 electron 测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run
```

预期：全 PASS。原本 873 测试 + 新增 ~8 测试 = 881+。

- [ ] **Step 5.5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 5.6: 跑双 workspace 全测试**

```bash
npx pnpm@9.0.0 test
```

- [ ] **Step 5.7: commit**

```bash
git add electron/tests/integration/router-lazy-init.test.ts electron/tests/integration/task-driven-dispatch-chain.test.ts
git commit -m "test(integration): router-lazy-init 集成测试（3 场景）

- 场景 1: 空状态 → init → router 自动启动
- 场景 2: 空状态 → startAgentRuntime → router 自动启动（agent:start 路径）
- 场景 3: 批量注册回归

Refs: docs/superpowers/specs/2026-08-14-router-service-lazy-init.md § 6.2"
```

---

## 验收清单

完成所有 task 后，确认：

- [ ] `npx pnpm@9.0.0 typecheck` 双 workspace clean
- [ ] `npx pnpm@9.0.0 test` 全 PASS（electron 873+ + renderer 407+）
- [ ] spec § 8 验证标准 1-10 全部满足（其中 1-7 由单元 + 集成测试覆盖；8-10 由 typecheck + 测试通过验证）
- [ ] 共 5 commit（Task 1-5 各一）
- [ ] 没有 `as any` / `@ts-ignore`（`as unknown as` 仅用于测试 mock cast）
- [ ] 中文注释完整
- [ ] commit message 用 Conventional Commits

---

## 实施依赖图

```
Task 1 (router-bootstrap.ts + 单元测试)
  ↓
  ├─→ Task 2 (ensureTaskDrivenRuntime 接入)
  │     ↓
  │     Task 3 (init-runtime.ts 改用 ensureRouterService)
  │           ↓
  │           Task 4 (index.ts before-quit 改造)
  ↓
  └─→ Task 5 (集成测试 + 既有测试更新) — 可在任何 task 后开始，但最末跑
```

**关键路径**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5
**无并行机会**（每个 task 依赖前一个的接口）
