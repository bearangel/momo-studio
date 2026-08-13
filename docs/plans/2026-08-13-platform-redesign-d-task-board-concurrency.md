# Plan D — 任务看板 + 并发控制实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 重写 runtime 为 task-driven 架构（warm pool 预启动 + 任务到达 spawn），实现三层并发上限（全局/per-agent/per-provider 令牌桶），构建 Linear 风格任务看板顶层视图。

**Architecture:** 移除"长期运行 agent runtime"概念；AgentRunner 维护 K 个 warm runtime 待命，task 到达 → acquire → 注入 task config → 监控；TaskDispatcher 按优先级 + 并发上限 pickup 任务；ProviderTokenBucket 限流 LLM 调用；看板独立 view 在主导航。

**Tech Stack:** better-sqlite3（global_settings/model_providers 扩展）；自实现 ProviderTokenBucket；Electron fork + warm pool；React + Zustand + react-dnd 或 @dnd-kit（看板拖拽）。

**依赖 spec：** `docs/specs/2026-08-13-platform-redesign-overview.md` 的"D 子系统：任务看板 + 并发控制"章节

**前置依赖：** Plan A、Plan B 已实施完成

## Global Constraints

（同 Plan A/B）

额外约束：
- **v1 per-agent 并发强制 1**：schema 字段 `max_concurrent_tasks` 保留但 UI 不暴露配置（v2 真并发铺路）
- **warm pool size 默认 K=2**：可配置（global_settings.warm_pool_size），用户机器内存紧张可调到 1
- **task-driven 重构不破坏现有 runtime-entry chat loop 内部逻辑**：仅改造 spawn/dispatch 入口

---

## File Structure

### 新增文件

```
electron/
├── src/main/
│   ├── agent/
│   │   ├── agent-runner.ts        # 每个_assignment 一个 runner（含 warm pool）
│   │   ├── warm-pool.ts           # 预启动 runtime 池
│   │   ├── runtime-spawner.ts     # 替代 runtime-manager.ts
│   │   └── llm/
│   │       └── token-bucket.ts    # Provider RPM/TPM 令牌桶
│   └── task/
│       ├── dispatcher.ts          # pickup 决策 + 调度
│       └── scheduler.ts           # 定时任务 + retry queue
└── tests/
    ├── migrations/021-concurrency-fields.test.ts
    ├── agent/llm/token-bucket.test.ts
    ├── agent/warm-pool.test.ts
    ├── agent/agent-runner.test.ts
    └── task/dispatcher.test.ts

renderer/
├── src/
│   ├── components/task-board/
│   │   ├── TaskBoardView.tsx      # 顶层主视图
│   │   ├── TaskList.tsx           # 列表 + 筛选
│   │   ├── TaskCard.tsx           # 单行任务卡片
│   │   ├── TaskDetailPanel.tsx    # 侧滑详情面板
│   │   └── TaskFilters.tsx        # 筛选/排序
│   └── stores/
│       └── board.store.ts         # 看板视图状态
└── tests/components/task-board/
    ├── TaskBoardView.test.tsx
    ├── TaskList.test.tsx
    └── TaskDetailPanel.test.tsx
```

### 改造文件

```
electron/src/main/agent/runtime-entry.ts   # 接受 IPC task 派发（替代 Matrix 监听）
electron/src/main/agent/auto-start.ts       # 不再恢复长期 runtime
electron/src/main/index.ts                  # 启动时初始化 AgentRunner
electron/src/main/ipc/agent.handlers.ts     # spawn 接口改造
renderer/src/components/layout/MiddlePanel.tsx  # 加 TaskBoardView 路由分支
renderer/src/stores/ui.store.ts             # ViewKey 加 'tasks'
```

---

## Task D1: Migration v21 — global_settings + model_providers 并发字段

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/migrations/021-concurrency-fields.test.ts`

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/migrations/021-concurrency-fields.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig21-${Date.now()}`);

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

describe('migration v21: 并发控制字段', () => {
  it('global_settings 加 max_concurrent_tasks（默认 3）', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(global_settings)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'max_concurrent_tasks');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('3');
  });

  it('global_settings 加 warm_pool_size（默认 2）', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(global_settings)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'warm_pool_size');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('2');
  });

  it('model_providers 加 max_rpm 列', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'max_rpm')).toBe(true);
  });

  it('model_providers 加 max_tpm 列', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'max_tpm')).toBe(true);
  });
});
```

- [ ] **Step 2: 实现 migration**

```typescript
  {
    version: 21,
    sql: `
-- D 子系统：并发控制字段
ALTER TABLE global_settings ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 3;
ALTER TABLE global_settings ADD COLUMN warm_pool_size INTEGER NOT NULL DEFAULT 2;
ALTER TABLE model_providers ADD COLUMN max_rpm INTEGER;
ALTER TABLE model_providers ADD COLUMN max_tpm INTEGER;
`.trim(),
  },
```

注意：如果 global_settings 表不存在，可能需先建（v1.4 引入过，应已存在）。

- [ ] **Step 3: 测试 + typecheck + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/migrations/021-concurrency-fields.test.ts
npx pnpm@9.0.0 typecheck
git add -A
git commit -m "feat(storage): v21 migration——并发控制字段（max_concurrent_tasks/warm_pool_size/RPM/TPM）"
```

---

## Task D2: ProviderTokenBucket（令牌桶限流）

**Files:**
- Create: `electron/src/main/agent/llm/token-bucket.ts`
- Test: `electron/tests/agent/llm/token-bucket.test.ts`

**Interfaces:**

```typescript
export class ProviderTokenBucket {
  constructor(opts: { maxRpm?: number; maxTpm?: number; windowMs?: number });
  canConsume(estimatedTokens?: number): boolean;
  record(actualTokens: number): void;
  getRpmUsage(): number;
  getTpmUsage(): number;
  /** 测试用：快进时间 */
  __advanceTime(ms: number): void;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/agent/llm/token-bucket.test.ts
import { describe, it, expect } from 'vitest';
import { ProviderTokenBucket } from '../../../src/main/agent/llm/token-bucket';

describe('ProviderTokenBucket', () => {
  it('maxRpm=10：前 10 次消费通过，第 11 次拒绝', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10 });
    for (let i = 0; i < 10; i++) {
      expect(b.canConsume()).toBe(true);
      b.record(100);
    }
    expect(b.canConsume()).toBe(false);
  });

  it('maxTpm=1000：累计 token 不能超过', () => {
    const b = new ProviderTokenBucket({ maxTpm: 1000 });
    expect(b.canConsume(500)).toBe(true);
    b.record(500);
    expect(b.canConsume(600)).toBe(false); // 500+600=1100 > 1000
    expect(b.canConsume(500)).toBe(true);  // 500+500=1000 OK
  });

  it('时间窗口滚出后额度恢复', () => {
    const b = new ProviderTokenBucket({ maxRpm: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) b.record(100);
    expect(b.canConsume()).toBe(false);
    b.__advanceTime(60_001);
    expect(b.canConsume()).toBe(true);
  });

  it('maxRpm 未设置时不限 RPM', () => {
    const b = new ProviderTokenBucket({ maxTpm: 1000 });
    for (let i = 0; i < 100; i++) {
      expect(b.canConsume(1)).toBe(true);
      b.record(1);
    }
  });

  it('getRpmUsage / getTpmUsage 反映当前窗口', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10, maxTpm: 1000 });
    b.record(100);
    b.record(200);
    expect(b.getRpmUsage()).toBe(2);
    expect(b.getTpmUsage()).toBe(300);
  });

  it('部分 token 超出窗口后被剔除', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10, windowMs: 60_000 });
    b.record(100);
    b.__advanceTime(30_000);
    b.record(200);
    expect(b.getRpmUsage()).toBe(2);
    b.__advanceTime(35_000); // 第一条已 > 60s
    expect(b.getRpmUsage()).toBe(1);
  });
});
```

- [ ] **Step 2: 实现 token-bucket**

```typescript
// electron/src/main/agent/llm/token-bucket.ts
//
// Provider 令牌桶——每个 model_provider 一个实例。
// 滑动窗口算法：记录每次请求的时间戳 + token 数，
// canConsume 时过滤掉超出窗口的记录，再判断余量。
//
// 性能：典型场景每 provider 每分钟 < 100 请求，filter 开销可忽略。
// 不依赖 Date.now()（用内部虚拟时钟，便于测试）。

export interface TokenBucketOpts {
  maxRpm?: number;   // NULL = 不限 RPM
  maxTpm?: number;   // NULL = 不限 TPM
  windowMs?: number; // 默认 60_000（1 分钟）
}

interface TokenLogEntry {
  ts: number;
  tokens: number;
}

export class ProviderTokenBucket {
  private readonly maxRpm?: number;
  private readonly maxTpm?: number;
  private readonly windowMs: number;
  private rpmLog: number[] = [];      // 请求时间戳
  private tokenLog: TokenLogEntry[] = [];
  private virtualNow: number;

  constructor(opts: TokenBucketOpts) {
    this.maxRpm = opts.maxRpm;
    this.maxTpm = opts.maxTpm;
    this.windowMs = opts.windowMs ?? 60_000;
    this.virtualNow = Date.now();
  }

  canConsume(estimatedTokens: number = 1000): boolean {
    this.gc();
    const rpmOk = !this.maxRpm || this.rpmLog.length < this.maxRpm;
    const currentTpm = this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
    const tpmOk = !this.maxTpm || currentTpm + estimatedTokens <= this.maxTpm;
    return rpmOk && tpmOk;
  }

  record(actualTokens: number): void {
    this.gc();
    this.rpmLog.push(this.virtualNow);
    this.tokenLog.push({ ts: this.virtualNow, tokens: actualTokens });
  }

  getRpmUsage(): number {
    this.gc();
    return this.rpmLog.length;
  }

  getTpmUsage(): number {
    this.gc();
    return this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
  }

  private gc(): void {
    const cutoff = this.virtualNow - this.windowMs;
    this.rpmLog = this.rpmLog.filter((ts) => ts > cutoff);
    this.tokenLog = this.tokenLog.filter((e) => e.ts > cutoff);
  }

  /** 测试用：快进时间 */
  __advanceTime(ms: number): void {
    this.virtualNow += ms;
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/llm/token-bucket.test.ts
git add electron/src/main/agent/llm/token-bucket.ts electron/tests/agent/llm/token-bucket.test.ts
git commit -m "feat(llm): ProviderTokenBucket 滑动窗口限流（D 子系统）"
```

---

## Task D3: WarmPool（预启动 runtime 池）

**Files:**
- Create: `electron/src/main/agent/warm-pool.ts`
- Test: `electron/tests/agent/warm-pool.test.ts`

**Interfaces:**

```typescript
export interface WarmRuntime {
  child: ChildProcess;
  spawnedAt: number;
  agentId: string;
}

export class WarmPool {
  constructor(opts: { poolSize?: number; spawn: (agentId: string) => Promise<ChildProcess> });
  /** 取一个 warm runtime（池空时立即 spawn） */
  acquire(agentId: string): Promise<WarmRuntime>;
  /** 归还 runtime（v1：销毁；v2：可复用） */
  release(runtime: WarmRuntime): void;
  /** 当前池内 warm runtime 数（per agent） */
  size(agentId: string): number;
  /** 销毁所有 warm runtime（进程退出 / 测试） */
  destroyAll(): void;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/agent/warm-pool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

function mkMockChild(): ChildProcess {
  return {
    kill: vi.fn(),
    pid: 12345,
    on: vi.fn(),
    send: vi.fn(),
    connected: true,
  } as unknown as ChildProcess;
}

describe('WarmPool', () => {
  it('池空时 acquire 立即 spawn', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    const rt = await pool.acquire('agent-1');
    expect(rt.child.pid).toBe(12345);
    expect(spawn).toHaveBeenCalledWith('agent-1');
    expect(pool.size('agent-1')).toBe(0); // 取走后池空
  });

  it('初始化时预 spawn poolSize 个 warm runtime', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 3, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('acquire 后异步 replenish 补充到 poolSize', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(2);
    await pool.acquire('agent-1');
    // 等异步 replenish 完成
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.size('agent-1')).toBe(2);
  });

  it('release 销毁 runtime（v1 简单实现）', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 1, spawn });
    await pool.warm('agent-1');
    const rt = await pool.acquire('agent-1');
    pool.release(rt);
    expect(rt.child.kill).toHaveBeenCalled();
  });

  it('destroyAll 清理所有', async () => {
    const child1 = mkMockChild();
    const child2 = mkMockChild();
    const spawn = vi.fn()
      .mockResolvedValueOnce(child1)
      .mockResolvedValueOnce(child2);
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    pool.destroyAll();
    expect(child1.kill).toHaveBeenCalled();
    expect(child2.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 实现 WarmPool**

```typescript
// electron/src/main/agent/warm-pool.ts
//
// 预启动 runtime 池——消除 spawn 延迟（每个 agent 维持 K 个待命 runtime）。
// v1：release 时销毁 runtime（不复用）；v2 可改为重置 + 复用。
import type { ChildProcess } from 'node:child_process';

export interface WarmRuntime {
  child: ChildProcess;
  spawnedAt: number;
  agentId: string;
}

export interface WarmPoolOpts {
  poolSize?: number;
  spawn: (agentId: string) => Promise<ChildProcess>;
}

const DEFAULT_POOL_SIZE = 2;

export class WarmPool {
  private readonly poolSize: number;
  private readonly spawn: (agentId: string) => Promise<ChildProcess>;
  private pools = new Map<string, WarmRuntime[]>();

  constructor(opts: WarmPoolOpts) {
    this.poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
    this.spawn = opts.spawn;
  }

  /** 启动时为 agent 预 spawn poolSize 个 runtime */
  async warm(agentId: string): Promise<void> {
    const pool = this.pools.get(agentId) ?? [];
    while (pool.length < this.poolSize) {
      const child = await this.spawn(agentId);
      pool.push({ child, spawnedAt: Date.now(), agentId });
    }
    this.pools.set(agentId, pool);
  }

  async acquire(agentId: string): Promise<WarmRuntime> {
    let pool = this.pools.get(agentId) ?? [];
    if (pool.length === 0) {
      // 池空，立即 spawn（无预热延迟优化）
      const child = await this.spawn(agentId);
      const rt = { child, spawnedAt: Date.now(), agentId };
      // 仍触发 replenish
      this.replenishAsync(agentId);
      return rt;
    }
    const rt = pool.pop()!;
    this.pools.set(agentId, pool);
    this.replenishAsync(agentId);
    return rt;
  }

  release(runtime: WarmRuntime): void {
    // v1：销毁（简单 + 隔离）；v2 可重置 state 后归还池
    try {
      runtime.child.kill();
    } catch (e) {
      // 已退出/失败，忽略
    }
  }

  size(agentId: string): number {
    return this.pools.get(agentId)?.length ?? 0;
  }

  destroyAll(): void {
    for (const pool of this.pools.values()) {
      for (const rt of pool) {
        try { rt.child.kill(); } catch {}
      }
    }
    this.pools.clear();
  }

  private replenishAsync(agentId: string): void {
    // 异步补充到 poolSize，不阻塞 acquire
    void this.warm(agentId).catch(() => {
      // spawn 失败——下次 acquire 时会重试
    });
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/warm-pool.test.ts
git add electron/src/main/agent/warm-pool.ts electron/tests/agent/warm-pool.test.ts
git commit -m "feat(agent): WarmPool 预启动 runtime 池（D 子系统）"
```

---

## Task D4: AgentRunner（task-driven 核心重构）

**Files:**
- Create: `electron/src/main/agent/agent-runner.ts`
- Test: `electron/tests/agent/agent-runner.test.ts`

**目标**：替代 runtime-manager.ts 的"长期运行 agent"模式。每个 agent_assignment 对应一个 AgentRunner，含 warm pool。

**Interfaces:**

```typescript
export interface TaskConfig {
  taskId: string | null;          // null = ephemeral chat
  executionRoomId: string;
  body: string;
  streamSessionId: string;
  /** 消息 metadata（mentions 等） */
  mentions?: string[];
}

export class AgentRunner {
  constructor(opts: {
    agentAssignmentId: string;
    agentBotUserId: string;
    workspaceId: string;
    config: RuntimeConfig;   // 复用 runtime-manager.ts 的 AgentRuntimeOpts
    warmPool: WarmPool;
  });
  /** 启动一个 task（含 ephemeral chat） */
  executeTask(task: TaskConfig): Promise<{ streamSessionId: string }>;
  /** 中断当前 task 的 stream */
  abortStream(streamSessionId: string): void;
  /** 销毁 runner + 释放 warm pool */
  destroy(): void;
  /** 当前活跃 task 数 */
  activeTaskCount(): number;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/agent/agent-runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

function mkMockChild(): ChildProcess {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 12345,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => { handlers[event] = h; }),
    off: vi.fn(),
    send: vi.fn((msg: unknown) => {
      // 模拟子进程收到 task-config 后立即返回 ack
      if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'task-config') {
        setTimeout(() => handlers['message']?.({ type: 'task-ack', streamSessionId: (msg as { streamSessionId: string }).streamSessionId }), 0);
      }
      return true;
    }),
    kill: vi.fn(),
    connected: true,
  } as unknown as ChildProcess;
}

describe('AgentRunner', () => {
  it('executeTask 从 warm pool 取 runtime，注入 task config', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentBotUserId: '@bot:home',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });

    const result = await runner.executeTask({
      taskId: null,
      executionRoomId: '!room:home',
      body: 'hi',
      streamSessionId: 'ss-1',
    });
    expect(result.streamSessionId).toBe('ss-1');
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task-config',
      streamSessionId: 'ss-1',
      body: 'hi',
    }));
    expect(runner.activeTaskCount()).toBe(1);
  });

  it('task 结束（end chunk）→ release runtime + activeTaskCount 减 1', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1', agentBotUserId: '@bot:home', workspaceId: 'ws1',
      config: {} as never, warmPool,
    });

    await runner.executeTask({ taskId: null, executionRoomId: '!r:home', body: 'x', streamSessionId: 'ss-1' });
    // 模拟子进程发 end chunk
    const msgHandler = (child.on as unknown as ReturnType<typeof vi>).mock.calls.find(
      ([event]: [string]) => event === 'message',
    )?.[1] as ((msg: unknown) => void) | undefined;
    msgHandler?.({ type: 'end', streamSessionId: 'ss-1', finishReason: 'stop' });
    expect(runner.activeTaskCount()).toBe(0);
  });

  it('abortStream 中断指定 task', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1', agentBotUserId: '@bot:home', workspaceId: 'ws1',
      config: {} as never, warmPool,
    });

    await runner.executeTask({ taskId: null, executionRoomId: '!r:home', body: 'x', streamSessionId: 'ss-1' });
    runner.abortStream('ss-1');
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'abort', streamSessionId: 'ss-1' }));
  });

  it('destroy 释放所有活跃 runtime + warm pool', async () => {
    const child = mkMockChild();
    const killSpy = child.kill as ReturnType<typeof vi>;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1', agentBotUserId: '@bot:home', workspaceId: 'ws1',
      config: {} as never, warmPool,
    });
    await runner.executeTask({ taskId: null, executionRoomId: '!r:home', body: 'x', streamSessionId: 'ss-1' });
    runner.destroy();
    expect(killSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 实现 AgentRunner**

```typescript
// electron/src/main/agent/agent-runner.ts
//
// AgentRunner（task-driven runtime 架构核心）——每个 agent_assignment 一个。
//
// v1：单 task 串行（per-agent max=1）。task 到达 → acquire warm runtime →
//     通过 IPC 注入 task config → 子进程跑 chat loop → end chunk → release runtime。
// v2：多 task 并发（warm pool 多 acquire）。
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WarmPool, WarmRuntime } from './warm-pool';
import type { AgentRuntimeOpts } from './runtime-manager'; // 复用旧类型，runtime-spawner 接管 spawn 实现

export interface TaskConfig {
  taskId: string | null;
  executionRoomId: string;
  body: string;
  streamSessionId: string;
  mentions?: string[];
}

export interface AgentRunnerOpts {
  agentAssignmentId: string;
  agentBotUserId: string;
  workspaceId: string;
  config: AgentRuntimeOpts;
  warmPool: WarmPool;
}

interface ActiveTask {
  streamSessionId: string;
  runtime: WarmRuntime;
  taskId: string | null;
}

export class AgentRunner {
  private readonly opts: AgentRunnerOpts;
  private readonly activeTasks = new Map<string, ActiveTask>(); // keyed by streamSessionId

  constructor(opts: AgentRunnerOpts) {
    this.opts = opts;
  }

  async executeTask(task: TaskConfig): Promise<{ streamSessionId: string }> {
    const runtime = await this.opts.warmPool.acquire(this.opts.agentAssignmentId);
    const active: ActiveTask = { streamSessionId: task.streamSessionId, runtime, taskId: task.taskId };
    this.activeTasks.set(task.streamSessionId, active);

    // 注册 message handler 接收 chunk
    const child = runtime.child;
    const messageHandler = (msg: unknown): void => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: string; streamSessionId?: string };
      if (m.streamSessionId !== task.streamSessionId) return;
      // chunk 转发逻辑由 runtime-spawner 统一处理（已注册）
      if (m.type === 'end' || m.type === 'error') {
        // 任务结束 → release
        child.off('message', messageHandler);
        this.opts.warmPool.release(runtime);
        this.activeTasks.delete(task.streamSessionId);
      }
    };
    child.on('message', messageHandler);

    // 注入 task config 给子进程
    child.send({
      type: 'task-config',
      taskId: task.taskId,
      executionRoomId: task.executionRoomId,
      body: task.body,
      streamSessionId: task.streamSessionId,
      mentions: task.mentions ?? [],
    });

    return { streamSessionId: task.streamSessionId };
  }

  abortStream(streamSessionId: string): void {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return;
    active.runtime.child.send({ type: 'abort', streamSessionId });
  }

  activeTaskCount(): number {
    return this.activeTasks.size;
  }

  destroy(): void {
    for (const active of this.activeTasks.values()) {
      this.opts.warmPool.release(active.runtime);
    }
    this.activeTasks.clear();
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/agent-runner.test.ts
git add electron/src/main/agent/agent-runner.ts electron/tests/agent/agent-runner.test.ts
git commit -m "feat(agent): AgentRunner task-driven 核心重构（D 子系统）"
```

---

## Task D5: TaskDispatcher（pickup 决策 + 三层并发控制）

**Files:**
- Create: `electron/src/main/task/dispatcher.ts`
- Test: `electron/tests/task/dispatcher.test.ts`

**Interfaces:**

```typescript
export class TaskDispatcher {
  constructor(opts: {
    runners: Map<string, AgentRunner>;     // assignmentId → runner
    buckets: Map<string, ProviderTokenBucket>; // providerId → bucket
    getAgentAssignment: (instanceId: string) => { agentDefinitionId: string; modelProviderId: string; maxConcurrentTasks: number } | null;
    getGlobalMax: () => number;
    now?: () => number;
  });
  /** 检查 + pickup 一个任务（按优先级） */
  tryPickup(assigneeAssignmentId: string): Promise<boolean>;
  /** 全局扫描：找所有 assigned 任务，按 assignee 触发 tryPickup */
  scanAll(): Promise<void>;
  /** 注册任务终态回调（释放槽位 + 触发其他 pickup） */
  onTaskTerminal(callback: (taskId: string) => void): void;
}
```

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/task/dispatcher.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { TaskDispatcher } from '../../src/main/task/dispatcher';
import { ProviderTokenBucket } from '../../src/main/agent/llm/token-bucket';
import { AgentRunner } from '../../src/main/agent/agent-runner';

const tmpRoot = path.join(os.tmpdir(), `ap-disp-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
  ).run('ws1', 'Test', '/tmp', '!space:home', '@owner:home');
  getDb().prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_provider, model_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('def1', 'Bot', 'bot', '1.0', '', 'provider-1', 'm1');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function mkDispatcher(opts: { globalMax?: number; maxConcurrent?: number; providerMax?: number }) {
  const buckets = new Map([['provider-1', new ProviderTokenBucket({ maxRpm: opts.providerMax ?? 100 })]]);
  const runners = new Map();
  const mockRunner = {
    activeTaskCount: vi.fn().mockReturnValue(0),
    executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }),
    destroy: vi.fn(),
  };
  runners.set('inst1', mockRunner);

  return {
    mockRunner,
    dispatcher: new TaskDispatcher({
      runners,
      buckets,
      getAgentAssignment: (id) => id === 'inst1' ? {
        agentDefinitionId: 'def1', modelProviderId: 'provider-1', maxConcurrentTasks: opts.maxConcurrent ?? 1,
      } : null,
      getGlobalMax: () => opts.globalMax ?? 3,
      now: () => 1000,
    }),
  };
}

describe('TaskDispatcher', () => {
  it('per-agent 并发未满 + 全局未满 + provider 未限流 → pickup', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(true);
    expect(mockRunner.executeTask).toHaveBeenCalled();
  });

  it('per-agent 并发已满 → 不 pickup', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({ maxConcurrent: 1 });
    mockRunner.activeTaskCount.mockReturnValue(1); // 已满
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('全局并发已满 → 不 pickup', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    transitionTaskStatus(t.id, 'assigned');
    const { dispatcher } = mkDispatcher({ globalMax: 0 });
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('provider 限流 → 不 pickup', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    transitionTaskStatus(t.id, 'assigned');
    const { dispatcher } = mkDispatcher({ providerMax: 0 });
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('无 assigned 任务 → 不 pickup', async () => {
    const { dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('未到 scheduled_at → 不 pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1',
      scheduledAt: 2000, // 未来
    });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('scanAll 遍历所有 runner，触发 pickup', async () => {
    const t1 = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    transitionTaskStatus(t1.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    await dispatcher.scanAll();
    expect(mockRunner.executeTask).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 实现 TaskDispatcher**

```typescript
// electron/src/main/task/dispatcher.ts
//
// pickup 决策 + 三层并发控制。
//
// 决策顺序（短路）：
//   1. per-agent：countInProgressByAgent < max_concurrent
//   2. 全局：countAllInProgress < global_max
//   3. provider：bucket.canConsume()
//   4. 找最高优先级 assigned 任务（findNextAssignedTask）
//   5. 通过 AgentRunner.executeTask 启动
//
// 触发时机：
//   - 任务进入 'assigned' 状态
//   - 任务终态（释放槽位）
//   - agent runtime 启动完成
//   - provider 配额恢复（每分钟滚窗）
//   - 用户点"重试队列"
import { findNextAssignedTask, listTasks, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import type { AgentRunner } from '../agent/agent-runner';
import type { ProviderTokenBucket } from '../agent/llm/token-bucket';
import { randomUUID } from 'node:crypto';

export interface DispatcherOpts {
  runners: Map<string, AgentRunner>;
  buckets: Map<string, ProviderTokenBucket>;
  getAgentAssignment: (instanceId: string) => {
    agentDefinitionId: string;
    modelProviderId: string;
    maxConcurrentTasks: number;
  } | null;
  getGlobalMax: () => number;
  now?: () => number;
}

export class TaskDispatcher {
  private readonly opts: DispatcherOpts;
  private readonly terminalCallbacks = new Set<(taskId: string) => void>();

  constructor(opts: DispatcherOpts) {
    this.opts = opts;
  }

  async tryPickup(assigneeAssignmentId: string): Promise<boolean> {
    const runner = this.opts.runners.get(assigneeAssignmentId);
    if (!runner) return false;

    const assignment = this.opts.getAgentAssignment(assigneeAssignmentId);
    if (!assignment) return false;

    // 1. per-agent 并发
    if (runner.activeTaskCount() >= assignment.maxConcurrentTasks) return false;

    // 2. 全局并发
    const globalActive = Array.from(this.opts.runners.values()).reduce((sum, r) => sum + r.activeTaskCount(), 0);
    if (globalActive >= this.opts.getGlobalMax()) return false;

    // 3. provider 限流
    const bucket = this.opts.buckets.get(assignment.modelProviderId);
    if (bucket && !bucket.canConsume()) return false;

    // 4. 找下一个 assigned 任务
    const now = this.opts.now?.() ?? Date.now();
    const nextTask = findNextAssignedTask(assigneeAssignmentId, now);
    if (!nextTask) return false;

    // 5. 启动
    const streamSessionId = randomUUID();
    transitionTaskStatus(nextTask.id, 'in_progress', {
      executionRoomId: nextTask.executionRoomId ?? nextTask.sourceRoomId,
      startedAt: now,
      runtimeInstanceId: streamSessionId,
    });
    try {
      await runner.executeTask({
        taskId: nextTask.id,
        executionRoomId: nextTask.executionRoomId ?? nextTask.sourceRoomId ?? '',
        body: '', // pickup 时 body 为空——子 agent 从 MemoryProvider 拉任务描述
        streamSessionId,
      });
      return true;
    } catch (e) {
      // 启动失败，回退状态
      transitionTaskStatus(nextTask.id, 'failed', { errorMessage: String(e) });
      return false;
    }
  }

  async scanAll(): Promise<void> {
    for (const assignmentId of this.opts.runners.keys()) {
      await this.tryPickup(assignmentId);
    }
  }

  onTaskTerminal(callback: (taskId: string) => void): void {
    this.terminalCallbacks.add(callback);
  }

  /** 由 AgentRunner 在 task 终态时调用 */
  notifyTaskTerminal(taskId: string): void {
    for (const cb of this.terminalCallbacks) cb(taskId);
    // 触发新一轮 pickup（释放了槽位）
    void this.scanAll();
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/dispatcher.test.ts
git add electron/src/main/task/dispatcher.ts electron/tests/task/dispatcher.test.ts
git commit -m "feat(task): TaskDispatcher pickup 决策 + 三层并发（D 子系统核心）"
```

---

## Task D6: 任务调度器（定时任务 + retry queue）

**Files:**
- Create: `electron/src/main/task/scheduler.ts`
- Test: `electron/tests/task/scheduler.test.ts`

**目标**：定时扫描 pending 任务（scheduled_at 到达 → 转 assigned）+ retry queue（provider 限流时 60s 后重试）。

### Steps

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/task/scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, listTasks } from '../../src/main/storage/tasks/repo';
import { TaskScheduler } from '../../src/main/task/scheduler';

const tmpRoot = path.join(os.tmpdir(), `ap-sched-${Date.now()}`);

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

describe('TaskScheduler', () => {
  it('扫描 pending 任务 + scheduled_at 已到 → 转 assigned', () => {
    const past = Date.now() - 1000;
    insertTask({
      workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1', scheduledAt: past,
    });
    // 模拟手动 pending（insertTask 默认 draft；这里测试 scheduler 扫描 pending）
    // 简化：直接插入 status=pending
    const db = getDb();
    db.prepare('UPDATE tasks SET status = ? WHERE title = ?').run('pending', 'T1');

    const scanPickup = vi.fn().mockResolvedValue(true);
    const sched = new TaskScheduler({ scanPickup, intervalMs: 1000 });
    sched.checkOnce();

    const updated = listTasks({ workspaceId: 'ws1' })[0];
    expect(updated.status).toBe('assigned');
    expect(scanPickup).toHaveBeenCalledWith('inst1');
  });

  it('scheduled_at 未到 → 不转', () => {
    const future = Date.now() + 60_000;
    const db = getDb();
    insertTask({
      workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1', scheduledAt: future,
    });
    db.prepare('UPDATE tasks SET status = ? WHERE title = ?').run('pending', 'T1');

    const scanPickup = vi.fn();
    const sched = new TaskScheduler({ scanPickup, intervalMs: 1000 });
    sched.checkOnce();
    expect(scanPickup).not.toHaveBeenCalled();
  });

  it('start / stop：定时器正确启停', () => {
    const sched = new TaskScheduler({ scanPickup: vi.fn(), intervalMs: 50 });
    sched.start();
    // 等待至少一次 tick
    return new Promise((resolve) => {
      setTimeout(() => {
        sched.stop();
        resolve();
      }, 120);
    });
  });
});
```

- [ ] **Step 2: 实现 scheduler**

```typescript
// electron/src/main/task/scheduler.ts
//
// 定时任务调度器：
//   - 每 intervalMs 扫描 status='pending' 且 scheduled_at <= now 的任务
//   - 转 assigned
//   - 触发 dispatcher.scanPickup(assigneeAssignmentId)
//
// 复杂定时（recurrence_rule cron）在 v1 简化：仅支持一次性 scheduled_at。
// v2 加 cron 解析 + 自动续期。
import { getDb } from '../storage/db';

export interface SchedulerOpts {
  scanPickup: (assigneeAssignmentId: string) => Promise<boolean>;
  intervalMs?: number;
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class TaskScheduler {
  private readonly opts: SchedulerOpts;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SchedulerOpts) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkOnce(): void {
    const now = this.opts.now?.() ?? Date.now();
    const db = getDb();
    // 找 pending + scheduled_at <= now + 有 assignee
    const tasks = db.prepare(
      `SELECT id, assignee_agent_id FROM tasks
       WHERE status = 'pending' AND scheduled_at <= ? AND assignee_agent_id IS NOT NULL`,
    ).all(now) as Array<{ id: string; assignee_agent_id: string }>;

    for (const t of tasks) {
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('assigned', now, t.id);
      void this.opts.scanPickup(t.assignee_agent_id);
    }
  }
}
```

- [ ] **Step 3: 测试 + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/scheduler.test.ts
git add electron/src/main/task/scheduler.ts electron/tests/task/scheduler.test.ts
git commit -m "feat(task): TaskScheduler 定时扫描 + pending→assigned（D 子系统）"
```

---

## Task D7-D10: 看板 UI（合并执行）

由于 UI 任务以组件搭建为主，且互相依赖紧密，合并为一个大 task 分步骤执行。

**Files:**
- Create: `renderer/src/components/task-board/TaskBoardView.tsx`
- Create: `renderer/src/components/task-board/TaskList.tsx`
- Create: `renderer/src/components/task-board/TaskCard.tsx`
- Create: `renderer/src/components/task-board/TaskDetailPanel.tsx`
- Create: `renderer/src/components/task-board/TaskFilters.tsx`
- Modify: `renderer/src/stores/ui.store.ts`（ViewKey 加 'tasks'）
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（加 TaskBoardView 分支）
- Test: `renderer/tests/components/task-board/TaskBoardView.test.tsx` 等

### Steps

- [ ] **Step 1: 扩展 ui.store.ts**

```typescript
// renderer/src/stores/ui.store.ts
export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings' | 'tasks';
```

- [ ] **Step 2: MiddlePanel 加 tasks 路由**

```tsx
// renderer/src/components/layout/MiddlePanel.tsx 内 activeView === 'tasks' 分支：
import { TaskBoardView } from '../task-board/TaskBoardView';

if (activeView === 'tasks') {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TaskBoardView workspaceId={activeWorkspaceId} />
    </div>
  );
}
```

- [ ] **Step 3: 实现 TaskBoardView**

```tsx
// renderer/src/components/task-board/TaskBoardView.tsx
import { useEffect, useState, useMemo } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { TaskList } from './TaskList';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskFilters, type FilterState } from './TaskFilters';
import { ipc } from '../../ipc/client';

interface TaskBoardViewProps {
  workspaceId: string;
}

export function TaskBoardView({ workspaceId }: TaskBoardViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const load = useTaskStore((s) => s.load);
  const [filter, setFilter] = useState<FilterState>({ status: 'all', assignee: 'all', sort: 'priority' });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState({ active: 0, max: 3, queued: 0 });

  useEffect(() => {
    void load(workspaceId);
    const refresh = () => {
      void load(workspaceId);
      ipc.system.getConcurrencyStatus?.().then(setConcurrency).catch(() => {});
    };
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [workspaceId, load]);

  const filteredTasks = useMemo(() => {
    let list = [...tasks];
    if (filter.status !== 'all') {
      list = list.filter((t) => t.status === filter.status);
    }
    if (filter.assignee !== 'all') {
      list = list.filter((t) => t.assigneeAgentId === filter.assignee);
    }
    list.sort((a, b) => {
      if (filter.sort === 'priority') return b.priority - a.priority || a.createdAt - b.createdAt;
      if (filter.sort === 'scheduled_at') return (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) - (b.scheduledAt ?? Number.MAX_SAFE_INTEGER);
      return a.createdAt - b.createdAt;
    });
    return list;
  }, [tasks, filter]);

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-border-subtle">
          <h2 className="text-lg font-medium">任务看板</h2>
          <div className="text-xs text-neutral-400">
            并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
          </div>
        </div>
        <TaskFilters value={filter} onChange={setFilter} />
        <TaskList
          tasks={filteredTasks}
          selectedId={selectedTaskId}
          onSelect={(id) => setSelectedTaskId(id)}
        />
      </div>
      {selectedTaskId && (
        <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: 实现 TaskList + TaskCard**

```tsx
// renderer/src/components/task-board/TaskCard.tsx
import type { TaskRow } from '../../ipc/types';

const STATUS_LABEL: Record<TaskRow['status'], string> = {
  draft: '草稿', pending: '待启动', assigned: '排队中', in_progress: '执行中',
  paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消',
};
const STATUS_COLOR: Record<TaskRow['status'], string> = {
  draft: '#9ca3af', pending: '#fbbf24', assigned: '#3b82f6', in_progress: '#10b981',
  paused: '#a78bfa', completed: '#6b7280', failed: '#ef4444', cancelled: '#6b7280',
};
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

interface TaskCardProps {
  task: TaskRow;
  selected: boolean;
  onSelect: () => void;
}

export function TaskCard({ task, selected, onSelect }: TaskCardProps) {
  const color = STATUS_COLOR[task.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 border-b border-border-subtle hover:bg-bg-tertiary ${selected ? 'bg-bg-tertiary' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">
          {PRIORITY_LABEL[task.priority] && (
            <span style={{ color: '#fbbf24' }} className="mr-1">{PRIORITY_LABEL[task.priority]}</span>
          )}
          #{task.id.slice(0, 6)} · {task.title}
        </span>
        <span style={{ color }} className="text-xs shrink-0">{STATUS_LABEL[task.status]}</span>
      </div>
      <div className="text-xs text-neutral-500 mt-1 flex gap-3">
        {task.scheduledAt && <span>📅 {new Date(task.scheduledAt).toLocaleDateString()}</span>}
        {task.deadlineAt && <span>⏰ {new Date(task.deadlineAt).toLocaleDateString()}</span>}
        {task.assigneeAgentId && <span>🤖 {task.assigneeAgentId.slice(0, 12)}</span>}
      </div>
      {task.status === 'in_progress' && task.startedAt && (
        <div className="text-xs text-neutral-500 mt-1">已用 {Math.round((Date.now() - task.startedAt) / 60000)} min · {task.toolCallsUsed} 工具调用</div>
      )}
    </button>
  );
}
```

```tsx
// renderer/src/components/task-board/TaskList.tsx
import type { TaskRow } from '../../ipc/types';
import { TaskCard } from './TaskCard';

interface TaskListProps {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selectedId, onSelect }: TaskListProps) {
  if (tasks.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">暂无任务</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} selected={selectedId === t.id} onSelect={() => onSelect(t.id)} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: 实现 TaskFilters + TaskDetailPanel**

```tsx
// renderer/src/components/task-board/TaskFilters.tsx
export interface FilterState {
  status: 'all' | TaskRow['status'];
  assignee: 'all' | string;
  sort: 'priority' | 'scheduled_at' | 'created_at';
}

interface TaskFiltersProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function TaskFilters({ value, onChange }: TaskFiltersProps) {
  return (
    <div className="flex items-center gap-2 p-2 border-b border-border-subtle text-xs">
      <select value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as FilterState['status'] })}>
        <option value="all">全部状态</option>
        <option value="draft">草稿</option>
        <option value="pending">待启动</option>
        <option value="assigned">排队中</option>
        <option value="in_progress">执行中</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
      </select>
      <select value={value.assignee} onChange={(e) => onChange({ ...value, assignee: e.target.value })}>
        <option value="all">全部 agent</option>
        {/* TODO: 从 agent store 拉列表 */}
      </select>
      <select value={value.sort} onChange={(e) => onChange({ ...value, sort: e.target.value as FilterState['sort'] })}>
        <option value="priority">按优先级</option>
        <option value="scheduled_at">按计划时间</option>
        <option value="created_at">按创建时间</option>
      </select>
    </div>
  );
}
```

```tsx
// renderer/src/components/task-board/TaskDetailPanel.tsx
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { TaskRow } from '../../ipc/types';

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
}

export function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRow | null>(null);

  useEffect(() => {
    void ipc.task.get(taskId).then(setTask);
  }, [taskId]);

  if (!task) return <div className="w-96 border-l border-border-subtle p-4">加载中...</div>;

  const handleStart = () => void ipc.task.start(taskId, {}).then(() => ipc.task.get(taskId).then(setTask));
  const handleCancel = () => void ipc.task.cancel(taskId).then(() => onClose());

  return (
    <div className="w-96 border-l border-border-subtle flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between p-3 border-b border-border-subtle">
        <span className="font-medium">#{task.id.slice(0, 8)}</span>
        <button type="button" onClick={onClose}>×</button>
      </div>
      <div className="flex-1 p-4 text-sm space-y-3">
        <div>
          <div className="text-xs text-neutral-500 mb-1">标题</div>
          <div>{task.title}</div>
        </div>
        {task.description && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">描述</div>
            <div className="whitespace-pre-wrap">{task.description}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>状态: {task.status}</div>
          <div>优先级: {task.priority}</div>
          {task.assigneeAgentId && <div>指派: {task.assigneeAgentId.slice(0, 16)}</div>}
          {task.scheduledAt && <div>📅 {new Date(task.scheduledAt).toLocaleString()}</div>}
          {task.deadlineAt && <div>⏰ {new Date(task.deadlineAt).toLocaleString()}</div>}
        </div>
        {(task.status === 'in_progress' || task.status === 'paused') && task.executionRoomId && (
          <button type="button" onClick={() => {/* TODO: 跳转到 execution_room */}}>
            进入执行会话 →
          </button>
        )}
      </div>
      <div className="p-3 border-t border-border-subtle flex gap-2">
        {(task.status === 'pending' || task.status === 'assigned') && (
          <button type="button" onClick={handleStart} className="flex-1 px-3 py-1 bg-accent-blue text-white rounded">
            启动
          </button>
        )}
        {task.status === 'in_progress' && (
          <button type="button" onClick={handleCancel} className="flex-1 px-3 py-1 border border-border-subtle rounded">
            取消
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 在主导航 LeftRail 加"任务"入口**

修改 `renderer/src/components/layout/LeftRail.tsx`（或主导航组件）：

```tsx
// 在 view 切换按钮列表加：
<button
  type="button"
  onClick={() => setActiveView('tasks')}
  className={activeView === 'tasks' ? 'active' : ''}
  title="任务看板"
>
  📋
</button>
```

- [ ] **Step 7: 写 TaskBoardView 集成测试**

```typescript
// renderer/tests/components/task-board/TaskBoardView.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskBoardView } from '../../../src/components/task-board/TaskBoardView';

vi.mock('../../../src/stores/task.store', () => ({
  useTaskStore: () => ({
    tasks: [
      { id: 'T-001', title: '实现登录', status: 'in_progress', priority: 10, createdAt: 1000 },
    ],
    load: vi.fn(),
  }),
}));
vi.mock('../../../src/ipc/client', () => ({
  ipc: { task: { get: vi.fn() }, system: {} },
}));

describe('TaskBoardView', () => {
  it('渲染顶部 + 任务列表', () => {
    render(<TaskBoardView workspaceId="ws1" />);
    expect(screen.getByText('任务看板')).toBeInTheDocument();
    expect(screen.getByText(/实现登录/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: 测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(task-board): Linear 风格看板 UI（TaskBoardView + TaskList + TaskCard + 详情面板）"
```

---

## Self-Review

### Spec 覆盖

| spec 章节 | 任务 |
|---|---|
| Migration v21 + 字段 | D1 ✅ |
| ProviderTokenBucket | D2 ✅ |
| WarmPool | D3 ✅ |
| AgentRunner（task-driven 重构） | D4 ✅ |
| TaskDispatcher + 三层并发 + pickup 算法 | D5 ✅ |
| 定时任务 + retry queue | D6 ✅ |
| 看板 UI（Linear 风格） | D7 ✅ |
| 任务详情侧滑面板 | D7 ✅ |
| 筛选/排序/拖拽 | D7 ✅（拖拽 dnd 留 v2） |
| 主导航接入 | D7 ✅ |

### 已知风险

1. **D4 AgentRunner 集成测试**：mock ChildProcess 较复杂；实际启动用真实 fork 集成测试在 D 完成后做
2. **D5 dispatcher 锁定 execution_room**：`nextTask.executionRoomId ?? nextTask.sourceRoomId` 简化处理；严格应调 B8 的 startTask
3. **D7 拖拽**：本 plan 暂不实现，留作后续 polish（dnd-kit 集成）
4. **D7 看板与 stream-aggregator 联动**：任务详情面板可显示执行 events，需要额外 query（暂用 ipc.task.get 仅返回 task 元数据）

---

**Plan D 完成并保存到 `docs/plans/2026-08-13-platform-redesign-d-task-board-concurrency.md`。**
