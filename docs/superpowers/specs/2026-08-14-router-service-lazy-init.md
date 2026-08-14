# RouterService Lazy Init 修复设计

**日期**：2026-08-14
**类型**：bug 修复（架构性）
**影响范围**：5 个文件改动 + 2 新测试文件，~200 行
**前置**：v2 task-driven runtime 切换 + agent 在线状态语义重新设计

---

## 1. 背景与问题

### 1.1 用户报告

> App 中所有 agent 都不回复消息。单人会话 agent 不回复、多人会话 @agent 不回复、多人会话发消息 PM 也不回复。所有场景都没有 agent 回复。

### 1.2 根因（架构性 bug）

`RouterService` 是 task-driven 架构的消息路由中心，**仅在 app 启动时** 通过 `initTaskDrivenRuntime` 创建一次。如果启动时 `agentRunners.size === 0`（无 last_running=1 的 task-driven agent），`initTaskDrivenRuntime` 返回 `null`，**RouterService 永远不会被创建**。

之后用户通过 UI 点"启动"按钮 → `agent:start` IPC → `ensureTaskDrivenRuntime` 注册 runner → DB 写 last_running=1（UI 显示在线）→ **但 sync-manager 的 routerService 仍 null**。

### 1.3 数据流追踪（证据）

```
sync-manager.ts:280-285:
  if (routerService) {                                    ← null 时整段跳过
    void routerService.routeMatrixEvent(event, ...);
  }

init-runtime.ts initTaskDrivenRuntime 末尾:
  if (agentRunners.size === 0) {
    logger.info('无 task-driven agent，跳过 RouterService 初始化');
    return null;                                          ← RouterService 永不创建
  }
  // ... 仅此分支后创建 RouterService

index.ts autoRestoreSession:
  const svc = await initTaskDrivenRuntime();
  if (svc) setRouterService(svc);                         ← svc=null 时 setRouterService 不调用

agent:start IPC handler:
  → startAgentRuntime(opts, true)
  → ensureTaskDrivenRuntime(opts)
  → 创建 pool + runner 加入 agentRunners Map
  → 写 last_running=1
  → ❌ 没有任何 setRouterService 调用
```

### 1.4 触发条件（任一即触发）

1. **新用户首次启动**：builtin agent 未配 modelProviderId → init 全跳过
2. **用户主动停止过所有 agent**（last_running=0）→ init 全跳过
3. **重新登录后**：session 恢复，但若所有 agent last_running=0 → 同上

之后用户点"启动" → UI 显示在线，但 **所有 m.room.message 静默丢弃**。

### 1.5 为何前面的 review 没抓到

- v2.0 + task-driven 切换时假设 "init 时总有 last_running=1 的 agent" —— 错误假设
- T5 测试覆盖 "init 仅注册 last_running=1" —— 通过；但**未覆盖后续 agent:start 是否触发 router 启动**
- Final whole-branch review 检查 `setRouterService` 调用链 —— 假设 `agent:start` 走 init 路径，未识别 lazy 缺失

---

## 2. 设计目标

**核心目标**：第一次 runner 注册时自动启动 RouterService，确保 `m.room.message → RouterService → AgentRunner` 链路始终工作。

**用户视角不变**：
- 用户启动 agent → 立即可用（发消息能收到回复）
- 用户停止所有 agent → RouterService 保留存活但 no-op（无副作用，下次 start 立即工作）

---

## 3. 设计决策

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | Lazy init 触发位置 | **`ensureTaskDrivenRuntime` 末尾** | runner 创建与 router 启动绑定；不遗漏任何路径（IPC start / auto-start / restartMainForSubChange） |
| 2 | ProviderTokenBucket 初始化 | **RouterService 启动时 populate** | buckets Map mutate 即可见；不需重复 populate |
| 3 | 循环依赖处理 | **动态 import**（runtime-registry → router-bootstrap） | 避免顶层循环；运行时延迟解析 |
| 4 | 所有 runner stop 后是否销毁 router | **不销毁**（保留存活） | 简化生命周期；消息 no-op 无副作用；下次 start 不需重启 |
| 5 | 修复范围 | **最小修复**（仅 router lazy init） | 不动其他架构；不动协调 agent 离线场景 |

---

## 4. 详细设计

### 4.1 新模块：`electron/src/main/agent/router-bootstrap.ts`

```typescript
// electron/src/main/agent/router-bootstrap.ts
//
// RouterService lazy 启动器——v2 修复：从启动时单例改为 lazy 单例。
//
// 问题背景：原 initTaskDrivenRuntime 是唯一创建 RouterService 的位置，
// app 启动时若无 runner（用户主动 stop 过所有 agent / 新用户首次启动），
// RouterService 永远 null，sync-manager.ts:280 的 if(routerService) 整段
// 跳过 → 所有 m.room.message 静默丢弃 → agent 不回复任何消息。
//
// 解决：抽取 ensureRouterService() 幂等 lazy init。第一次 runner 注册时
// （由 ensureTaskDrivenRuntime 末尾调用）启动 RouterService；后续调用 no-op。
//
// 与 runtime-registry / init-runtime 的依赖：
//   - 不直接 import runtime-registry（避免循环）
//   - agentRunners + providerBuckets 通过参数传入
//   - 由调用方（ensureTaskDrivenRuntime / initTaskDrivenRuntime）动态 import 本模块

import type { Map as _Map } from 'node:types';  // 仅类型，运行时无依赖
import { RouterService } from './router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from '../task/dispatcher';
import { setRouterService } from '../matrix/sync-manager';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { AgentRunner } from './agent-runner';
import type { ProviderTokenBucket } from './llm/token-bucket';

let currentRouterService: RouterService | null = null;

/**
 * 幂等 lazy 启动 RouterService。
 *
 * - 已启动 → no-op
 * - agentRunners.size === 0 → no-op（防御性，正常路径不触发）
 * - 首次调用 → populateProviderBuckets + 创建 TaskDispatcher + 创建 RouterService + setRouterService
 *
 * 由 ensureTaskDrivenRuntime（runtime-registry.ts）末尾调用——
 * 确保 runner 创建后立即有 router 接管消息路由。
 */
export async function ensureRouterService(
  runners: Map<string, AgentRunner>,
  buckets: Map<string, ProviderTokenBucket>,
): Promise<void> {
  if (currentRouterService) return;
  if (runners.size === 0) return;

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
 * 反向清理：setRouterService(null) + 释放引用。
 */
export function destroyRouterService(): void {
  if (!currentRouterService) return;
  setRouterService(null);
  currentRouterService = null;
  logger.info('RouterService 已销毁');
}

/** 测试用：重置模块状态（清 currentRouterService） */
export function __resetRouterServiceForTest(): void {
  currentRouterService = null;
}

// ─── helpers（从 init-runtime.ts 迁移） ────────────────────────────────────

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

**注意**：`populateProviderBuckets` 由调用方在 `ensureTaskDrivenRuntime` 之前调用（保留在 runtime-registry.ts 中）。

### 4.2 `runtime-registry.ts` 改动

`ensureTaskDrivenRuntime` 末尾（写 last_running=1 之后、`logger.info('task-driven runtime 已创建', ...)` 之前）追加：

```typescript
// v2 修复：第一次 runner 注册时 lazy 启动 RouterService
// （若已启动则 no-op；幂等安全）
const { ensureRouterService } = await import('./router-bootstrap');
await ensureRouterService(agentRunners, providerBuckets).catch((err) => {
  logger.warn('ensureRouterService 失败（runner 已注册但 router 未启动）', {
    instanceId, error: String(err),
  });
});
```

`createTaskDrivenRuntime`（同步函数，由 initTaskDrivenRuntime 调用）末尾同样追加（但 createTaskDrivenRuntime 不是 async——需要改签名 OR 不在此处调）：

**选择**：`createTaskDrivenRuntime` 改为不在这里调 ensureRouterService（保持 sync 签名）。`initTaskDrivenRuntime` 末尾已经会调一次，覆盖批量创建场景。`ensureTaskDrivenRuntime`（单 agent 路径，由 `agent:start` 调）末尾调用覆盖运行时新增场景。

### 4.3 `init-runtime.ts` 改动

`initTaskDrivenRuntime` 末尾：

```typescript
// v2 修复：使用 router-bootstrap 统一 lazy 启动入口
// 替代原来手动创建 RouterService 的代码（删除 ~15 行）
populateProviderBuckets();
const { ensureRouterService } = await import('./router-bootstrap');
await ensureRouterService(agentRunners, providerBuckets);
return null;  // 返回值不再被使用（router 内部已 setRouterService）
```

**返回值变化**：从 `Promise<RouterService | null>` 改为 `Promise<void>`（或保留 null 返回，调用方 `if (svc)` 改为不依赖）。

`index.ts` autoRestoreSession:
```typescript
await initTaskDrivenRuntime();
// 删除：const svc = await initTaskDrivenRuntime();
// 删除：if (svc) setRouterService(svc);
// setRouterService 由 ensureRouterService 内部调用
```

### 4.4 `index.ts` before-quit 改动

```typescript
app.on('before-quit', () => {
  destroyAllTaskDrivenRuntimes();
  // v2 修复：改用 router-bootstrap 统一销毁入口
  destroyRouterService();  // 替代 setRouterService(null)

  stopTaskRuntime();
  void stopConduit();
  void stopSync();
});
```

import 同步更新：
```typescript
import { destroyRouterService } from './agent/router-bootstrap';
// 删除：import { setRouterService } from './matrix/sync-manager';
//      （若 index.ts 其他地方未用，可移除；若 setMainWindow 等仍需保留则部分保留）
```

---

## 5. 错误处理 + 边缘场景

| 场景 | 处理 |
|---|---|
| `ensureRouterService` 时 `agentRunners.size === 0` | no-op（防御性） |
| RouterService 创建失败（TaskDispatcher 构造异常等） | log + return，下次 ensure 再试 |
| 所有 runner 被 stop 后 routerService 仍存活 | 接受（routeUserMessage 找不到 runner 时 log warn + return；无副作用） |
| before-quit 时 currentRouterService 已 null | no-op（`if (!currentRouterService) return`） |
| `agent:start` 后立即收到消息（race condition） | ensure 是 async；race 窗口极小（< 1ms）；即便 race 输了，下条消息会成功（routerService 已 set） |
| 用户连续 stop/start 多个 agent | 第一个 start 触发 ensureRouterService；后续 no-op；stop 不销毁 router；安全 |

**已知范围外**：
- 协调 agent 被停止后团队群消息路由（spec § 8 已声明）
- 多 owner 写竞争（SQLite 单写锁已足够）

---

## 6. 测试策略

### 6.1 单元测试（新增）

`electron/tests/agent/router-bootstrap.test.ts`：

1. `ensureRouterService` 首次调用启动 router + setRouterService
2. `ensureRouterService` 二次调用 no-op（currentRouterService 已存在）
3. `ensureRouterService` runners.size=0 时 no-op
4. `destroyRouterService` 销毁 + setRouterService(null)
5. `destroyRouterService` 已 null 时 no-op

### 6.2 集成测试（新增）

`electron/tests/integration/router-lazy-init.test.ts`：

**场景 1**：空状态 → 注册 runner → router 自动启动
```typescript
it('空状态启动：注册 runner 后 routerService 非 null', async () => {
  __clearRuntimeRegistryForTest();
  __resetRouterServiceForTest();
  // 准备 DB + assignment + def + last_running=0（确保 init 不会启动 router）
  // 调用 ensureTaskDrivenRuntime(opts) 模拟 agent:start 路径
  // 验证：sync-manager.routerService 非 null
});
```

**场景 2**：lazy init 后 router 接收消息
```typescript
it('router lazy 启动后能接收 m.room.message', async () => {
  // 启动 router（场景 1 完成后）
  // mock sync-manager 模拟 m.room.message
  // 验证 routerService.routeMatrixEvent 被调用
});
```

**场景 3**：init 仍正确（回归）
```typescript
it('initTaskDrivenRuntime 批量注册 runner 后 router 启动', async () => {
  // 准备 DB：2 个 last_running=1 + task_driven=1 的 agent
  // 调 initTaskDrivenRuntime
  // 验证 routerService 非 null + runnerCount=2
});
```

### 6.3 既有测试影响

- `init-runtime.test.ts` / `agent-online-bootstrap.test.ts`：`initTaskDrivenRuntime` 返回值变化（从 RouterService|null 到 null），断言更新
- `task-driven-dispatch-chain.test.ts`：原本直接 new RouterService；改为调 ensureRouterService
- `router-service.test.ts`：不受影响（直接测 RouterService 类）

---

## 7. 文件清单

### Electron（4 改 + 1 新）

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/router-bootstrap.ts` | 新建（~100 行，含 helpers） |
| `electron/src/main/agent/runtime-registry.ts` | `ensureTaskDrivenRuntime` 末尾加 lazy ensure 调用 |
| `electron/src/main/agent/init-runtime.ts` | 末尾改用 ensureRouterService；删除手动 RouterService 创建；返回值改 null |
| `electron/src/main/index.ts` | autoRestoreSession 不再 if(svc)；before-quit 改用 destroyRouterService |
| `electron/tests/agent/router-bootstrap.test.ts` | 新建 |
| `electron/tests/integration/router-lazy-init.test.ts` | 新建 |
| `electron/tests/integration/agent-online-bootstrap.test.ts` | 断言更新（initTaskDrivenRuntime 返回值） |
| `electron/tests/integration/task-driven-dispatch-chain.test.ts` | 改用 ensureRouterService |

---

## 8. 验证标准

修复完成后，以下行为必须成立：

1. ✅ **空状态启动**（无 last_running=1 的 agent）→ sync-manager.routerService 为 null
2. ✅ 用户点"启动" → runner 注册 + router 自动启动 + sync-manager.routerService 非 null
3. ✅ router 启动后 owner 发消息 → router.routeMatrixEvent 被调用
4. ✅ RouterService lazy 幂等（多次 ensure 不重建）
5. ✅ 用户停止所有 agent → router 仍存活（no-op 消息）
6. ✅ 用户再启动新 agent → router 不重建（已存活）
7. ✅ before-quit → destroyRouterService 清理引用
8. ✅ initTaskDrivenRuntime 批量注册场景仍正确（回归）
9. ✅ 全部既有测试通过（更新断言后）
10. ✅ typecheck 双 workspace clean

---

## 9. 不在本次修复范围

- 协调 agent 被停止后团队群消息路由
- agent 状态机重设计
- RouterService 动态销毁/重建（保留单例 + no-op 简化）
- v1 fallback agent 的 RouterService 接入（v1 agent 走 client.startClient 不需 router）

这些项目可在后续单独 brainstorm + spec。
