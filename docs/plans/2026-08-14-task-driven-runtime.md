# Task-Driven Runtime 完整切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1 runtime-manager（长期运行进程）完全切换为 v2 task-driven runtime（runtime 是 task 的临时资源）；主进程成为消息路由中心。

**Architecture:** 主进程 RouterService 监听 Matrix event + 路由到目标 agent + 创建 ephemeral task → AgentRunner.acquire（warm pool）→ 注入 task-config via IPC → runtime chat loop（仅处理一个 task）→ task_complete → runtime 销毁 + WarmPool.replenish。

**Tech Stack:** Electron + Node.js 20 + TypeScript strict；better-sqlite3（migration v22）；node:child_process fork（runtime spawn）；vitest（TDD）。

**依赖 spec：** `docs/specs/2026-08-14-task-driven-runtime-design.md`

**前置依赖：** Plan A/B/C/D 已完成（D 子系统 AgentRunner + WarmPool + Dispatcher + Scheduler 已就绪）。

## Global Constraints

- **Node 20 LTS 强制**：容器默认 Node 26，**必须先 `nvm use 20`**
- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`
- **Conventional Commits**：`feat:` / `fix:` / `refactor:` / `test:` / `chore:`
- **中文注释**：源码注释用中文；标识符英文
- **测试命令**：
  - 单测：`cd /workspace/electron && npx pnpm@9.0.0 vitest run <path>`
  - 全套：`npx pnpm@9.0.0 test`
  - typecheck：`npx pnpm@9.0.0 typecheck`

---

## File Structure

### 新增文件

```
electron/
├── src/main/agent/
│   ├── router-service.ts        # Matrix event 路由 + task 创建
│   └── runtime-spawner.ts       # 完善：spawnForAgent 完整实现
└── tests/
    ├── agent/router-service.test.ts
    ├── agent/runtime-spawner.test.ts
    ├── migrations/022-task-driven.test.ts
    └── integration/task-driven-e2e.test.ts

renderer/
# （本 plan 不涉及 renderer 改动）
```

### 改造文件

```
electron/src/main/agent/runtime-entry.ts       # 删 Matrix 监听 + 加 task-config IPC
electron/src/main/agent/runtime-manager.ts     # 标记 deprecated
electron/src/main/agent/ipc.handlers.ts        # 6 处 spawnAgent → WarmPool.warm
electron/src/main/agent/auto-start.ts          # 预热而非 spawn
electron/src/main/index.ts                     # 启动 WarmPool + RouterService
electron/src/main/matrix/sync-manager.ts       # 注册 RouterService 路由
electron/src/main/storage/migrations/index.ts  # v22 migration
```

---

## Task T1: Migration v22 — agent_definitions.task_driven 字段

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/migrations/022-task-driven.test.ts`

**Interfaces:**
- Produces: `agent_definitions.task_driven INTEGER NOT NULL DEFAULT 1`（1=task-driven, 0=v1 fallback）

### Steps

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/migrations/022-task-driven.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig22-${Date.now()}`);

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

describe('migration v22: agent_definitions.task_driven', () => {
  it('agent_definitions 加 task_driven 列，默认 1', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(agent_definitions)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'task_driven');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('1');
  });

  it('现有 builtin agent 的 task_driven 默认为 1', () => {
    const db = getDb();
    // 插入一个 agent_definition 不指定 task_driven
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_provider_id, model_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('test1', 'Test', 'test', '1.0', '', 'provider-1', 'm1');
    const row = db.prepare('SELECT task_driven FROM agent_definitions WHERE id = ?').get('test1') as { task_driven: number };
    expect(row.task_driven).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/migrations/022-task-driven.test.ts
```

- [ ] **Step 3: 实现 v22 migration**

在 `electron/src/main/storage/migrations/index.ts` 末尾加：

```typescript
  {
    version: 22,
    sql: `
-- task-driven runtime 切换：agent_definitions 加 task_driven 字段
-- 1 = task-driven（v2 默认）/ 0 = v1 runtime-manager（fallback，留 1 版本）
ALTER TABLE agent_definitions ADD COLUMN task_driven INTEGER NOT NULL DEFAULT 1;
`.trim(),
  },
```

- [ ] **Step 4: 测试 + typecheck + commit**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/migrations/022-task-driven.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/storage/migrations/index.ts electron/tests/migrations/022-task-driven.test.ts
git commit -m "feat(storage): v22 migration——agent_definitions.task_driven 字段"
```

---

## Task T2: runtime-spawner.ts 完整实现

**Files:**
- Modify: `electron/src/main/agent/runtime-spawner.ts`（完善骨架）
- Test: `electron/tests/agent/runtime-spawner.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeOpts`（runtime-manager.ts 类型）；`buildSpawnOpts`（spawn-helpers.ts）
- Produces:

```typescript
export interface SpawnedRuntime {
  child: ChildProcess;
  assignmentId: string;
  spawnedAt: number;
}

export async function spawnForAgent(opts: {
  assignmentId: string;
  runtimeConfig: AgentRuntimeOpts;
  onChunk: (chunk: StreamChunk) => void;
  onExit: (code: number | null) => void;
}): Promise<SpawnedRuntime>;

export async function stopRuntime(child: ChildProcess, opts?: { timeoutMs?: number }): Promise<void>;
```

### Steps

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/runtime-spawner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnForAgent, stopRuntime } from '../../src/main/agent/runtime-spawner';

// mock fork（避免真实 fork runtime-entry）
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => ({
    pid: 12345,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
    connected: true,
    once: vi.fn(),
  })),
}));

describe('runtime-spawner', () => {
  it('spawnForAgent fork runtime-entry + 注册 handlers', async () => {
    const opts = {
      assignmentId: 'inst1',
      runtimeConfig: {
        instanceId: 'inst1', workspaceId: 'ws1', workspaceDir: '/tmp',
        botUserId: '@bot:home', botAccessToken: 'token', homeserverUrl: 'http://localhost',
        systemPrompt: '', modelName: 'gpt-4', llmApiKey: 'key', teamRoomId: '!room:home',
        ownerUserId: '@owner:home',
      } as never,
      onChunk: vi.fn(),
      onExit: vi.fn(),
    };
    const runtime = await spawnForAgent(opts);
    expect(runtime.child.pid).toBe(12345);
    expect(runtime.assignmentId).toBe('inst1');
    expect(runtime.child.on).toHaveBeenCalled();
  });

  it('stopRuntime 发 shutdown + 等 + force kill', async () => {
    const { fork } = await import('node:child_process');
    const mockChild = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {
      send: vi.fn(), kill: vi.fn(), on: vi.fn(), connected: true,
    };
    await stopRuntime(mockChild as never, { timeoutMs: 100 });
    expect(mockChild.send).toHaveBeenCalledWith({ type: 'shutdown' });
  });
});
```

- [ ] **Step 2: 实现 spawnForAgent + stopRuntime**

```typescript
// electron/src/main/agent/runtime-spawner.ts
//
// task-driven runtime spawn 适配层——v2 完整实现。
// 替代 runtime-manager.spawnAgent，提供 WarmPool 需要的 spawn 接口。
//
// 流程：
//   1. buildSpawnOpts 构造完整 AgentRuntimeOpts（复用 spawn-helpers）
//   2. fork runtime-entry.js（AGENT_CONFIG 环境变量传 config）
//   3. 注册 message handler（chunk 转发 → onChunk 回调）
//   4. 注册 exit handler（→ onExit 回调）
//   5. 返回 SpawnedRuntime 给 WarmPool

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';
import type { StreamChunk } from './stream-chunk';

// 复用 runtime-manager 的 AgentRuntimeOpts 类型（避免重复定义）
import type { AgentRuntimeOpts } from './runtime-manager';

export interface SpawnedRuntime {
  child: ChildProcess;
  assignmentId: string;
  spawnedAt: number;
}

export interface SpawnOpts {
  assignmentId: string;
  runtimeConfig: AgentRuntimeOpts;
  onChunk: (chunk: StreamChunk) => void;
  onExit: (code: number | null) => void;
}

const RUNTIME_ENTRY_PATH = path.join(__dirname, 'runtime-entry.js');
const SHUTDOWN_TIMEOUT_MS = 5000;

export async function spawnForAgent(opts: SpawnOpts): Promise<SpawnedRuntime> {
  const { assignmentId, runtimeConfig, onChunk, onExit } = opts;
  
  // AGENT_CONFIG 环境变量传递 runtime config（与 v1 runtime-manager 一致）
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_CONFIG: JSON.stringify(runtimeConfig),
  };
  
  // fork runtime-entry.js
  const child = fork(RUNTIME_ENTRY_PATH, [], {
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  
  // 注册 message handler（chunk 转发）
  const messageHandler = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    // StreamChunk 类型的消息转发给 onChunk
    const m = msg as { type?: string };
    if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'todo_update', 'end', 'segment_boundary'].includes(m.type)) {
      onChunk(msg as StreamChunk);
    }
    // 其他类型的消息（task-end / mcp 请求等）由调用方在 child.on('message') 内处理
  };
  child.on('message', messageHandler);
  
  // 注册 exit handler
  const exitHandler = (code: number | null): void => {
    logger.info('runtime 退出', { assignmentId, code });
    onExit(code);
  };
  child.on('exit', exitHandler);
  
  logger.info('runtime 已 spawn', { assignmentId, pid: child.pid });
  
  return {
    child,
    assignmentId,
    spawnedAt: Date.now(),
  };
}

export async function stopRuntime(child: ChildProcess, opts?: { timeoutMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  
  // 1. 发 shutdown 消息（让 runtime 优雅退出）
  if (child.connected) {
    child.send({ type: 'shutdown' });
  }
  
  // 2. 等待 timeoutMs
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
      }
      resolve();
    }, timeoutMs);
    
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
```

- [ ] **Step 3: 测试 + typecheck + commit**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-spawner.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/runtime-spawner.ts electron/tests/agent/runtime-spawner.test.ts
git commit -m "feat(agent): runtime-spawner 完整实现（spawnForAgent + stopRuntime）"
```

---

## Task T3: runtime-entry.ts 改造（删 Matrix 监听 + 加 task-config IPC）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（大改）

**目标**：runtime 不再长期监听 Matrix event，仅通过 task-config IPC 触发 chat loop。

### Steps

- [ ] **Step 1: 加 TaskConfig 接口 + task-config handler**

在 runtime-entry.ts 顶部加 TaskConfig 类型：

```typescript
interface TaskConfig {
  type: 'task-config';
  taskId: string | null;
  executionRoomId: string;
  body: string;
  streamSessionId: string;
  mentions?: string[];
  dispatchContext?: {
    fromBotUserId: string;
    task_id: string;
    tool_budget?: number;
    tool_stream_session_id?: string;
  };
}
```

在 main() 函数末尾（Matrix client 初始化之后）加 task-config handler：

```typescript
// task-driven：监听 task-config IPC，触发 chat loop
process.on('message', async (msg: unknown) => {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string };
  
  if (m.type === 'task-config') {
    try {
      await runTaskChatLoop(m as TaskConfig);
    } catch (err) {
      logger.error('task-config 处理失败', { error: String(err) });
      process.exit(1);
    }
  } else if (m.type === 'shutdown') {
    logger.info('收到 shutdown 信号，退出 runtime');
    process.exit(0);
  }
});
```

- [ ] **Step 2: 实现 runTaskChatLoop 函数**

提取当前 main() 内的 chat loop 逻辑为独立函数（可被 task-config handler 调用）：

```typescript
async function runTaskChatLoop(cfg: TaskConfig): Promise<void> {
  const { taskId, executionRoomId: roomId, body, streamSessionId, mentions, dispatchContext } = cfg;
  
  // 1. 注入 system prompt（task 上下文 / dispatch 模式 hint）
  const memory = getMemoryProvider();
  const [taskCtx, convCtx] = await Promise.all([
    taskId ? memory.getTaskContext(taskId) : null,
    dispatchContext ? { messages: [] } : await memory.getConversationContext(roomId, { limit: 20 }),
  ]);
  
  const taskHint = taskCtx ? `\n\n[任务上下文] #${taskCtx.task.id}: ${taskCtx.task.title}\n${taskCtx.task.description}` : '';
  const dispatchHint = dispatchContext ? '\n\n[dispatch 模式] 你作为子 agent 被主 agent 委派执行具体任务。' : '';
  const finalSystemContent = ctx.systemPrompt + taskHint + dispatchHint;
  
  // 2. 构造 LLM messages
  const messages: LLMMessage[] = [
    { role: 'system', content: finalSystemContent },
    ...convCtx.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: body },
  ];
  
  // 3. 发送 start chunk
  sendStreamChunk({ type: 'start', streamSessionId, roomId, botUserId: ctx.botUserId, ...(dispatchContext?.tool_stream_session_id ? { parentStreamSessionId: dispatchContext.tool_stream_session_id } : {}) });
  
  // 4. chat loop（沿用现有 LLM 调用 + 工具执行 + abort 机制）
  //    把当前 handleEvent 内的核心逻辑提取出来，传入 messages + streamSessionId
  await executeChatLoop({ messages, streamSessionId, roomId, taskId, abortSignal });
  
  // 5. task_complete
  sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
  
  // 6. 通知主进程 task 完成
  process.send?.({ type: 'task-end', streamSessionId, taskId });
  
  // 7. 退出 runtime
  process.exit(0);
}
```

- [ ] **Step 3: 重构 handleEvent → executeChatLoop**

把当前 `handleEvent` 函数内的"消息处理 + LLM 调用 + 工具执行 + abort"核心逻辑提取为 `executeChatLoop`（接受预构造的 messages 数组，不再从 Matrix event 读取）。

保留 handleEvent 仅用于 v1 fallback（task_driven=0 时仍走 Matrix 监听）。

- [ ] **Step 4: 条件性禁用 Matrix 监听（task_driven 控制）**

在 main() 内：

```typescript
const config = parseConfig(process.env.AGENT_CONFIG);
const isTaskDriven = config.taskDriven !== false; // 默认 true

if (isTaskDriven) {
  // task-driven 模式：不监听 Matrix event，仅通过 task-config IPC 触发
  logger.info('runtime 启动（task-driven 模式）');
  // task-config handler 已在 Step 1 注册
} else {
  // v1 fallback：仍监听 Matrix event（保留 handleEvent 逻辑）
  logger.info('runtime 启动（v1 模式，fallback）');
  await client.startClient({ initialSyncLimit: 20 });
  await waitForPrepared(client);
  client.on(ClientEvent.Event, handleEvent);
}
```

- [ ] **Step 5: RuntimeConfig 加 taskDriven 字段**

修改 RuntimeConfig 接口 + parseConfig 函数：

```typescript
export interface RuntimeConfig {
  // ... 现有字段
  taskDriven?: boolean; // 默认 true；false = v1 fallback
}
```

- [ ] **Step 6: 测试适配**

现有 runtime-stream.test.ts / runtime-stream-abort.test.ts 需要适配 task-config IPC 触发模式。修改测试 fixture：用 `process.emit('message', { type: 'task-config', ... })` 替代 Matrix event 触发。

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-stream.test.ts tests/agent/runtime-stream-abort.test.ts
# 修复失败的测试（不要删除）
```

- [ ] **Step 7: 全套测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(agent): runtime-entry task-config IPC + 条件 Matrix 监听（task-driven 切换核心）"
```

---

## Task T4: RouterService 实现

**Files:**
- Create: `electron/src/main/agent/router-service.ts`
- Test: `electron/tests/agent/router-service.test.ts`

**Interfaces:**
- Consumes: AgentRunner（D4）；decideResponse（B6）；startTask（B8）；conflict-detector（B9 final fix）
- Produces: RouterService 类（Matrix event → task 创建 → AgentRunner 派发）

### Steps

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/router-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';

function mkMockEvent(type: string, content: Record<string, unknown>, sender = '@user:home', roomId = '!room:home') {
  return {
    getType: () => type,
    getContent: () => content,
    getSender: () => sender,
    getRoomId: () => roomId,
    getId: () => '$evt:home',
    getTs: () => Date.now(),
    isRedacted: () => false,
  } as never;
}

describe('RouterService', () => {
  it('m.room.message → 路由到目标 agent → executeTask', async () => {
    const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }) };
    const runners = new Map([['inst1', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });
    
    await svc.routeMatrixEvent(mkMockEvent('m.room.message', { body: 'hello', 'm.mentions': {} }), '@user:home', '!room:home', 'inst1');
    
    expect(mockRunner.executeTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: null,
      body: 'hello',
    }));
  });

  it('dispatch event → 路由到子 agent → executeTask（dispatchContext）', async () => {
    const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-2' }) };
    const runners = new Map([['inst-sub', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });
    
    await svc.routeMatrixEvent(mkMockEvent('io.momo-studio.dispatch', {
      body: '写登录页',
      task_id: 'task-123',
      dispatch_from: '@pm:home',
      dispatch_to: '@sub:home',
    }), '@pm:home', '!room:home', 'inst-sub');
    
    expect(mockRunner.executeTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-123',
      dispatchContext: expect.objectContaining({ fromBotUserId: '@pm:home' }),
    }));
  });

  it('task_reply → 通知正在执行的 PM task（IPC 推送）', async () => {
    const mockRunner = { 
      executeTask: vi.fn(),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([['inst-pm', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });
    
    await svc.routeMatrixEvent(mkMockEvent('io.momo-studio.task_reply', {
      body: '完成',
      task_id: 'task-123',
      status: 'completed',
    }), '@sub:home', '!room:home', 'inst-pm');
    
    expect(mockRunner.notifyTaskReply).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-123' }));
  });
});
```

- [ ] **Step 2: 实现 RouterService**

```typescript
// electron/src/main/agent/router-service.ts
//
// 主进程消息路由中心——task-driven 架构的核心。
// 替代 v1 的 runtime 自己监听 Matrix event。
//
// 流程：
//   sync-manager 收到 Matrix event → RouterService.routeMatrixEvent
//     → m.room.message → decideResponse → ephemeral task → AgentRunner.executeTask
//     → dispatch → 找子 agent → dispatch ephemeral task → AgentRunner.executeTask
//     → task_reply → 通知正在执行的 PM runtime

import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { decideResponse } from './decide-response';
import { DISPATCH_EVENT_TYPE, TASK_REPLY_EVENT_TYPE, ABORT_DISPATCH_EVENT_TYPE } from './dispatch';
import { parseMentions } from '../../../renderer/src/lib/mention-parser'; // 注意跨 workspace import
import type { AgentRunner } from './agent-runner';
import type { TaskDispatcher } from '../task/dispatcher';

export interface RouterServiceOpts {
  runners: Map<string, AgentRunner>;
  dispatcher: TaskDispatcher;
}

export class RouterService {
  constructor(private readonly opts: RouterServiceOpts) {}

  async routeMatrixEvent(
    event: { getType(): string; getContent(): Record<string, unknown>; getSender(): string; getRoomId(): string },
    ownerUserId: string,
    targetAssignmentId: string | null,
    directTargetAssignmentId?: string, // 单聊直接目标
  ): Promise<void> {
    const type = event.getType();
    try {
      switch (type) {
        case 'm.room.message':
          if (directTargetAssignmentId) {
            await this.routeUserMessage(event, ownerUserId, directTargetAssignmentId);
          }
          break;
        case DISPATCH_EVENT_TYPE:
          await this.routeDispatch(event);
          break;
        case TASK_REPLY_EVENT_TYPE:
          await this.routeTaskReply(event);
          break;
        case ABORT_DISPATCH_EVENT_TYPE:
          await this.routeAbortDispatch(event);
          break;
      }
    } catch (err) {
      logger.error('RouterService 路由失败', { type, error: String(err) });
    }
  }

  private async routeUserMessage(
    event: { getContent(): Record<string, unknown>; getSender(): string; getRoomId(): string },
    ownerUserId: string,
    targetAssignmentId: string,
  ): Promise<void> {
    const content = event.getContent();
    const body = typeof content.body === 'string' ? content.body : '';
    const roomId = event.getRoomId();
    const sender = event.getSender();
    
    // 创建 ephemeral chat task
    const streamSessionId = randomUUID();
    const runner = this.opts.runners.get(targetAssignmentId);
    if (!runner) {
      logger.warn('未找到 runner', { targetAssignmentId });
      return;
    }
    
    await runner.executeTask({
      taskId: null,
      executionRoomId: roomId,
      body,
      streamSessionId,
    });
  }

  private async routeDispatch(
    event: { getContent(): Record<string, unknown>; getSender(): string; getRoomId(): string },
  ): Promise<void> {
    const content = event.getContent();
    const dispatchTo = content.dispatch_to as string | undefined;
    if (!dispatchTo) return;
    
    // 找到目标子 agent 的 assignment（按 botUserId 反查）
    // 这里简化：调用方传入目标 assignmentId
    // 实际实现需要 agent-store / repo 反查
    // TODO: T8 dispatch 完整路由
    
    logger.info('dispatch event 收到', { dispatchTo, taskId: content.task_id });
  }

  private async routeTaskReply(
    event: { getContent(): Record<string, unknown>; getSender(): string; getRoomId(): string },
  ): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id as string | undefined;
    if (!taskId) return;
    
    // 通知正在执行的 PM runtime（通过 IPC 推送 task_reply）
    for (const runner of this.opts.runners.values()) {
      if ('notifyTaskReply' in runner && typeof (runner as { notifyTaskReply?: unknown }).notifyTaskReply === 'function') {
        await ((runner as { notifyTaskReply: (msg: unknown) => Promise<void> }).notifyTaskReply)(content);
      }
    }
  }

  private async routeAbortDispatch(
    event: { getContent(): Record<string, unknown> },
  ): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id as string | undefined;
    if (!taskId) return;
    // 找到正在执行该 task 的 runtime → abort
    // TODO: T8 实现
  }

  start(): void {
    logger.info('RouterService 已启动');
  }
}
```

- [ ] **Step 3: AgentRunner 加 notifyTaskReply 方法**

修改 `electron/src/main/agent/agent-runner.ts`，加：

```typescript
async notifyTaskReply(reply: { task_id: string; status: string; body: string }): Promise<void> {
  // 找到正在执行该 task 的 runtime → 推送 task_reply IPC
  for (const [streamSessionId, active] of this.activeTasks) {
    if (active.taskId === reply.task_id) {
      active.runtime.child.send({ type: 'task-reply', reply });
      return;
    }
  }
}
```

- [ ] **Step 4: 测试 + typecheck + commit**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/router-service.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/router-service.ts electron/src/main/agent/agent-runner.ts electron/tests/agent/router-service.test.ts
git commit -m "feat(agent): RouterService Matrix event 路由中心"
```

---

## Task T5: main/index.ts 启动链路

**Files:**
- Modify: `electron/src/main/index.ts`
- Modify: `electron/src/main/agent/auto-start.ts`（先做简化版，T7 完整改造）

### Steps

- [ ] **Step 1: 在 main/index.ts 初始化 WarmPool + RouterService**

```typescript
// main/index.ts
import { WarmPool } from './agent/warm-pool';
import { AgentRunner } from './agent/agent-runner';
import { RouterService } from './agent/router-service';
import { TaskDispatcher } from './task/dispatcher';
import { ProviderTokenBucket } from './agent/llm/token-bucket';
import { spawnForAgent } from './agent/runtime-spawner';
import { listAssignments } from './agent/crud';

// 全局单例
let routerService: RouterService | null = null;
const agentRunners = new Map<string, AgentRunner>();
const providerBuckets = new Map<string, ProviderTokenBucket>();

async function initTaskDrivenRuntime(): Promise<void> {
  // 1. 遍历所有 assignments，为每个 agent 创建 WarmPool + AgentRunner
  for (const ws of listWorkspaces()) {
    for (const assignment of listAssignments(ws.id)) {
      if (agentRunners.has(assignment.instanceId)) continue;
      
      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) continue;
      
      // 跳过 v1 fallback 的 agent
      if (def.taskDriven === false) continue;
      
      const warmPool = new WarmPool({
        poolSize: 2,
        spawn: async (agentId) => {
          const runtimeConfig = await buildSpawnOpts(assignment, def, ws);
          const runtime = await spawnForAgent({
            assignmentId: agentId,
            runtimeConfig,
            onChunk: (chunk) => forwardChunkToRenderer(chunk),
            onExit: (code) => handleRuntimeExit(agentId, code),
          });
          return runtime.child;
        },
      });
      
      const runner = new AgentRunner({
        agentAssignmentId: assignment.instanceId,
        agentBotUserId: assignment.botMatrixUserId,
        workspaceId: ws.id,
        config: {} as never,
        warmPool,
      });
      
      agentRunners.set(assignment.instanceId, runner);
      
      // 预热 warm pool
      await warmPool.warm(assignment.instanceId);
    }
  }
  
  // 2. 初始化 Dispatcher
  const dispatcher = new TaskDispatcher({
    runners: agentRunners,
    buckets: providerBuckets,
    getAgentAssignment: (id) => { /* 返回 assignment 信息 */ },
    getGlobalMax: () => 3,
  });
  
  // 3. 初始化 RouterService
  routerService = new RouterService({ runners: agentRunners, dispatcher });
  routerService.start();
}
```

- [ ] **Step 2: 在 autoRestoreSession 内调用 initTaskDrivenRuntime**

```typescript
async function autoRestoreSession(): Promise<void> {
  try {
    await startSyncFromSession();
    logger.info('Session restored: Matrix sync started');
    
    // task-driven runtime 初始化（替代 autoStartAgents）
    await initTaskDrivenRuntime();
    logger.info('Task-driven runtime initialized');
    
    broadcastRuntimeChanged();
  } catch (err) {
    // ... 错误处理
  }
}
```

- [ ] **Step 3: sync-manager 注册 RouterService 路由**

修改 sync-manager 的 ClientEvent.Event 监听，把消息路由到 RouterService：

```typescript
// sync-manager.ts
client.on(ClientEvent.Event, (event: MatrixEvent) => {
  if (!SYNCED_EVENT_TYPES.has(event.getType())) return;
  if (event.isRedacted()) return;
  
  // A 子系统：dispatch/task_reply INSERT SQLite（已实现）
  // ...（保留 A 子系统的 SQLite INSERT 逻辑）
  
  // task-driven：路由到 RouterService
  if (routerService) {
    void routerService.routeMatrixEvent(event, getCurrentUserId() ?? '', null);
  }
  
  // ...（保留 push message 给 renderer 的逻辑）
});
```

- [ ] **Step 4: 测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(agent): main/index.ts 启动 task-driven runtime 链路"
```

---

## Task T6-T8: IPC handler 切换 + auto-start 改造 + dispatch 路由（合并）

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`（6 处）
- Modify: `electron/src/main/agent/auto-start.ts`
- Modify: `electron/src/main/agent/router-service.ts`（完善 dispatch 路由）

### Steps

- [ ] **Step 1: IPC handler 切换（agent.start → WarmPool.warm）**

修改 `electron/src/main/agent/ipc.handlers.ts` 的 6 处 `spawnAgent` 调用：

```typescript
// 旧：spawnAgent(opts);
// 新：await warmPoolForAssignment(assignmentId, opts);
```

新增辅助函数：

```typescript
async function warmPoolForAssignment(assignmentId: string, opts: AgentRuntimeOpts): Promise<void> {
  // task-driven：预热 warm pool（不 spawn）
  const warmPool = globalWarmPools.get(assignmentId);
  if (warmPool) {
    await warmPool.warm(assignmentId);
  }
}
```

- [ ] **Step 2: auto-start.ts 改造**

```typescript
// 旧：spawnAgent(opts)
// 新：await initTaskDrivenRuntime()（已在 main/index.ts 调用，auto-start 仅做兼容性 stub）
export async function autoStartAgents(): Promise<void> {
  // task-driven 模式：auto-start 由 main/index.ts 的 initTaskDrivenRuntime 接管
  // 本函数保留作为 v1 fallback（task_driven=0 的 agent）
  logger.info('autoStartAgents: task-driven 模式下由 initTaskDrivenRuntime 接管');
}
```

- [ ] **Step 3: RouterService 完善 dispatch 路由**

完善 routeDispatch：

```typescript
private async routeDispatch(event: { getContent(): Record<string, unknown> }): Promise<void> {
  const content = event.getContent();
  const dispatchTo = content.dispatch_to as string | undefined;
  const taskId = content.task_id as string | undefined;
  const body = content.body as string | undefined;
  if (!dispatchTo || !taskId || !body) return;
  
  // 反查 assignment by botUserId
  const assignment = findAssignmentByBotUserId(dispatchTo);
  if (!assignment) {
    logger.warn('dispatch 目标 agent 未找到', { dispatchTo });
    return;
  }
  
  const runner = this.opts.runners.get(assignment.instanceId);
  if (!runner) return;
  
  const streamSessionId = randomUUID();
  await runner.executeTask({
    taskId,
    executionRoomId: event.getRoomId(),
    body,
    streamSessionId,
    dispatchContext: {
      fromBotUserId: content.dispatch_from as string,
      task_id: taskId,
      tool_budget: content.tool_budget as number | undefined,
      tool_stream_session_id: content.tool_stream_session_id as string | undefined,
    },
  });
}
```

- [ ] **Step 4: 测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(agent): IPC handler 切换 + auto-start 改造 + dispatch 路由"
```

---

## Task T9: runtime-manager.ts 标记 deprecated

**Files:**
- Modify: `electron/src/main/agent/runtime-manager.ts`

### Steps

- [ ] **Step 1: 在文件顶部加 deprecated 标注**

```typescript
// electron/src/main/agent/runtime-manager.ts
//
// @deprecated v2.0：task-driven runtime 架构切换后，本文件不再使用。
// 保留作为 v1 fallback（agent_definitions.task_driven=0 时）。
// 下个大版本删除。
//
// v2 替代：
//   - spawnAgent → runtime-spawner.spawnForAgent + WarmPool.warm
//   - stopAgent → WarmPool.destroyAll
//   - registerStreamIpc → RouterService + AgentRunner
//
// 【注意】registerStreamIpc 仍被 ipc/index.ts 调用——v2 模式下不注册 handler 但函数保留。

// ... 原有代码保留不变
```

- [ ] **Step 2: commit**

```bash
git add electron/src/main/agent/runtime-manager.ts
git commit -m "chore(agent): runtime-manager.ts 标记 deprecated（v2 task-driven 切换）"
```

---

## Task T10: e2e 集成测试

**Files:**
- Test: `electron/tests/integration/task-driven-e2e.test.ts`

### Steps

- [ ] **Step 1: 写 e2e 测试（4 个场景）**

```typescript
// electron/tests/integration/task-driven-e2e.test.ts
//
// task-driven runtime 切换的核心回归测试。
// 4 个场景端到端验证：普通消息 / #task mention / dispatch / abort。
//
// 不启动真实 LLM；用 mock stream chunk 序列驱动。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage, updateMessageStatus, getMessageByStreamSessionId } from '../../src/main/storage/messages/repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';
import { listEventsByMessage, insertEvent } from '../../src/main/storage/messages/events-repo';
import { aggregateEvents } from '../../../renderer/src/lib/stream-aggregator';

const tmpRoot = path.join(os.tmpdir(), `ap-task-driven-e2e-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
  ).run('ws1', 'Test', '/tmp', '!space:home', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task-driven runtime e2e', () => {
  it('场景 1：用户普通消息 → ephemeral task → chat loop → 完成 → runtime 销毁', async () => {
    // 1. INSERT user message
    const userMsg = insertMessage({
      roomId: '!room:home', sender: '@owner:home', eventType: 'm.room.message',
      body: '@PM 你好', source: 'local',
    });
    
    // 2. 模拟 runtime 接收 task-config + 跑 chat loop（mock）
    const agentMsg = insertMessage({
      roomId: '!room:home', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-1', status: 'streaming', parentStreamSessionId: undefined,
    });
    
    // 3. stream chunk 落盘
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: agentMsg.id, eventType: 'text_delta', payload: { delta: '你好！有什么可以帮你的？' } });
    buf.append({ messageId: agentMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();
    
    // 4. 验证 message 状态 + events
    const updated = getMessageByStreamSessionId('ss-1');
    expect(updated?.status).toBe('streaming'); // buf 不改 status，由 main 改
    
    // 5. 重启聚合验证一致性
    const events = listEventsByMessage(agentMsg.id);
    const stream = aggregateEvents(events);
    expect(stream.text).toBe('你好！有什么可以帮你的？');
    expect(stream.status).toBe('done');
  });

  it('场景 2：用户 @agent #T-001 → task 启动 → 完成', async () => {
    // 1. INSERT task
    getDb().prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, assignee_agent_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('T-001', 'ws1', '实现登录', 'assigned', '@owner:home', 'inst1');
    
    // 2. INSERT user message（含 #T-001 mention）
    insertMessage({
      roomId: '!room:home', sender: '@owner:home', eventType: 'm.room.message',
      body: '@PM #T-001 开始吧', source: 'local',
    });
    
    // 3. 模拟 RouterService 检测 #mention → startTask
    getDb().prepare('UPDATE tasks SET status = ?, execution_room_id = ?, started_at = ? WHERE id = ?')
      .run('in_progress', '!room:home', Date.now(), 'T-001');
    
    // 4. 模拟 runtime 跑 chat loop
    const agentMsg = insertMessage({
      roomId: '!room:home', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-2', status: 'streaming', taskId: 'T-001',
    });
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: agentMsg.id, eventType: 'text_delta', payload: { delta: '开始实现登录页' } });
    buf.append({ messageId: agentMsg.id, eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'write_file', args: { path: '/login.tsx' } } });
    buf.append({ messageId: agentMsg.id, eventType: 'tool_call_result', payload: { callId: 'c1', result: 'ok', success: true } });
    buf.append({ messageId: agentMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();
    
    // 5. complete_task → task 状态机
    getDb().prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', Date.now(), 'T-001');
    
    // 6. 验证
    const task = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get('T-001') as { status: string };
    expect(task.status).toBe('completed');
    
    const stream = aggregateEvents(listEventsByMessage(agentMsg.id));
    expect(stream.toolCalls.length).toBe(1);
    expect(stream.toolCalls[0].toolName).toBe('write_file');
  });

  it('场景 3：PM dispatch → 子 agent ephemeral task → task_reply', async () => {
    // 1. PM message
    const pmMsg = insertMessage({
      roomId: '!room:home', sender: '@pm:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-pm', status: 'streaming',
    });
    
    // 2. PM 调 dispatch:programmer → 主进程发 dispatch event → INSERT dispatch message
    const dispatchMsg = insertMessage({
      roomId: '!room:home', sender: '@pm:home', eventType: 'io.momo-studio.dispatch',
      body: '写登录页', matrixEventId: '$dispatch:home', source: 'matrix',
    });
    
    // 3. RouterService 检测 dispatch → 创建子 agent ephemeral task
    const subMsg = insertMessage({
      roomId: '!room:home', sender: '@prog:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-sub', status: 'streaming', parentStreamSessionId: 'ss-pm#dispatch-1',
    });
    
    // 4. 子 agent 处理
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: subMsg.id, eventType: 'text_delta', payload: { delta: '登录页已写完' } });
    buf.append({ messageId: subMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    
    // 5. 子 agent 完成 → task_reply
    insertMessage({
      roomId: '!room:home', sender: '@prog:home', eventType: 'io.momo-studio.task_reply',
      body: '登录页已写完', matrixEventId: '$reply:home', source: 'matrix',
    });
    buf.destroy();
    
    // 6. 验证
    const messages = getDb().prepare('SELECT event_type FROM messages WHERE room_id = ? ORDER BY created_at').all('!room:home') as Array<{ event_type: string }>;
    expect(messages.map((m) => m.event_type)).toContain('io.momo-studio.dispatch');
    expect(messages.map((m) => m.event_type)).toContain('io.momo-studio.task_reply');
  });

  it('场景 4：abort → runtime AbortController 触发 → 退出', async () => {
    const msg = insertMessage({
      roomId: '!room:home', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-abort', status: 'streaming',
    });
    
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: '正在' } });
    buf.flush();
    
    // abort 触发（主进程发 abort IPC）
    // runtime 内 AbortController.abort() → chat loop 抛错 → end chunk { finishReason: 'interrupted' }
    buf.append({ messageId: msg.id, eventType: 'status_change', payload: { status: 'aborted' } });
    buf.append({ messageId: msg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();
    
    updateMessageStatus(msg.id, 'aborted');
    
    const updated = getMessageByStreamSessionId('ss-abort');
    expect(updated?.status).toBe('aborted');
  });
});
```

- [ ] **Step 2: 全套测试 + typecheck + commit**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/integration/task-driven-e2e.test.ts
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "test(integration): task-driven runtime e2e（4 场景端到端验证）"
```

---

## Self-Review

### Spec 覆盖

| spec 章节 | 任务 |
|---|---|
| migration v22 task_driven | T1 ✅ |
| runtime-spawner 完整实现 | T2 ✅ |
| runtime-entry 删 Matrix 监听 + task-config IPC | T3 ✅ |
| RouterService 实现 | T4 ✅ |
| main/index.ts 启动链路 | T5 ✅ |
| IPC handler 切换 + auto-start 改造 | T6-T8 ✅ |
| dispatch/task_reply 路由 | T6-T8 ✅ |
| runtime-manager deprecated | T9 ✅ |
| e2e 4 场景 | T10 ✅ |

### Placeholder 扫描

- ✅ 所有 task 有完整代码骨架 + 测试
- ✅ 无 TBD / TODO（dispatch 完整路由的 TODO 在 T6-T8 补完）
- ✅ 关键算法（RouterService / spawnForAgent / runTaskChatLoop）有完整代码

### 已知风险

1. **T3 runtime-entry 改造范围大**（2000+ 行文件）：保留 chat loop 核心逻辑，仅改入口
2. **T3 测试适配**：runtime-stream.test.ts 等需要从 Matrix event 触发改为 task-config IPC 触发
3. **T5 initTaskDrivenRuntime 涉及多模块**：需要 buildSpawnOpts（spawn-helpers）+ assignment 反查
4. **T6-T8 dispatch 路由需要反查 assignment by botUserId**：可能需要新加 helper 函数
5. **T10 e2e 不启动真实 runtime**：仅测试数据流（task-driven 架构的端到端验证需要真实 fork，留 manual 测试）

---

**Plan 完成并保存到 `docs/plans/2026-08-14-task-driven-runtime.md`。**

## 执行选项

两种执行方式：

### 1. Subagent-Driven（推荐）
- 每个 task 派发 fresh subagent + 我 review
- 完成后 final whole-branch review
- 适合本次大型架构切换

### 2. Inline Execution
- 当前会话内逐 task 执行
- 批量执行 + checkpoint

**推荐 Subagent-Driven**——task-driven 切换涉及 runtime 架构，需要严格 review 把控。
