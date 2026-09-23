// electron/tests/agent/runtime-boot-handshake.test.ts
//
// P0 静默回合丢失（WarmPool boot 竞态）回归锁——fake child 层。
//
// 根因（.superpowers/e2e/mcp-realmodel-report.md 缺陷 #1）：
//   spawnForAgent 只等 fork 返回即 resolve，WarmPool.acquire 随即把「已 fork 但
//   未完成 boot」的子进程交给 AgentRunner.executeTask 立即 send(task-config)；
//   runtime-entry 的 task-config 监听器在 boot 末尾（含 MCP 发现 await）才注册，
//   消息在监听器注册前被 channel parser emit → 永久丢弃（零 chunk / 零消息行 /
//   零错误）。修复 = boot 完成握手：子进程注册完监听器后发一次性
//   {type:'runtime-ready'}，spawnForAgent 在 resolve 前等该信号。
//
// 本文件（fork 被 mock）覆盖的契约：
//   A. spawnForAgent 仅在收到 runtime-ready 后 resolve（未 ready 前保持 pending）
//   B. 等不到 ready 超时 → 中文错误 reject + kill 子进程（不静默悬挂）
//   C. 握手完成前子进程退出 → 中文错误 reject（非静默悬挂）
//   D. runtime-registry 的 spawn 闭包在握手期收到 child exit 不解引用未赋值的
//      runtime（TDZ 回归锁——exit handler 抛 ReferenceError 会变 uncaught）
//
// 真实 fork dist 产物的端到端复现锁见 runtime-boot-handshake-fork.test.ts。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { createTaskDrivenRuntime, __clearRuntimeRegistryForTest } from '../../src/main/agent/runtime-registry';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';

// ─── fake child：手写最小 EventEmitter（vi.hoisted 供 mock 工厂引用） ───────
// fork 每调用一次创建一个新 child 并入列表——WarmPool.warm 会顺序 spawn 多个，
// 测试按需对指定 child 发消息 / 退出事件。

const fake = vi.hoisted(() => {
  type Cb = (arg?: unknown) => void;
  interface FakeChild {
    pid: number;
    connected: boolean;
    sent: unknown[];
    killCalls: number;
    on(event: string, cb: Cb): FakeChild;
    off(event: string, cb: Cb): FakeChild;
    once(event: string, cb: Cb): FakeChild;
    send(msg: unknown): boolean;
    kill(): boolean;
    emit(event: string, arg?: unknown): void;
  }
  const children: FakeChild[] = [];
  const make = (): FakeChild => {
    const listeners = new Map<string, Cb[]>();
    const child: FakeChild = {
      pid: 4321 + children.length,
      connected: true,
      sent: [],
      killCalls: 0,
      on(event, cb) {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
        return child;
      },
      off(event, cb) {
        listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== cb));
        return child;
      },
      once(event, cb) {
        return child.on(event, cb);
      },
      send(msg) {
        child.sent.push(msg);
        return true;
      },
      kill() {
        child.killCalls += 1;
        return true;
      },
      emit(event, arg) {
        for (const cb of [...(listeners.get(event) ?? [])]) cb(arg);
      },
    };
    return child;
  };
  return {
    children,
    reset(): void {
      children.length = 0;
    },
    newChild(): FakeChild {
      const c = make();
      children.push(c);
      return c;
    },
    last(): FakeChild {
      return children[children.length - 1]!;
    },
  };
});

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => fake.newChild()),
}));

import { spawnForAgent } from '../../src/main/agent/runtime-spawner';

// ─── 公共装置 ───────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `ap-boot-handshake-${Date.now()}`);

const runtimeConfig: AgentRuntimeOpts = {
  instanceId: 'inst-hs',
  workspaceId: 'ws-hs',
  workspaceDir: '/tmp/ws-hs',
  agentAssignmentId: 'inst-hs',
  agentUserId: 'agent-hs-1',
  systemPrompt: '',
  modelName: 'test-model',
  llmApiKey: 'k',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function spawnOpts(overrides: Record<string, any> = {}): Parameters<typeof spawnForAgent>[0] {
  return {
    assignmentId: 'inst-hs',
    runtimeConfig,
    onChunk: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 等一个宏任务，让 fork + 监听器注册完成 */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('runtime-ready 握手（fake child 层）', () => {
  it('A. 未收到 runtime-ready 前 spawnForAgent 保持 pending；收到后 resolve', async () => {
    const p = spawnForAgent(spawnOpts({ readyTimeoutMs: 5000 }));
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    await tick();
    await new Promise((r) => setTimeout(r, 60));
    // 修复前：spawnForAgent 在 fork 后立即 resolve（红）；修复后：等待握手信号
    expect(resolved).toBe(false);

    fake.last().emit('message', { type: 'runtime-ready' });
    const runtime = await p;
    expect(runtime.child).toBe(fake.last() as unknown);
  }, 10000);

  it('B. 等不到 runtime-ready 超时 → 中文错误 reject + kill 子进程', async () => {
    const p = spawnForAgent(spawnOpts({ readyTimeoutMs: 80 }));
    await expect(p).rejects.toThrow(/握手超时/);
    await expect(p).rejects.toThrow(/runtime-ready/);
    expect(fake.last().killCalls).toBe(1);
  }, 10000);

  it('C. 握手完成前子进程退出 → 中文错误 reject（不悬挂）', async () => {
    const p = spawnForAgent(spawnOpts({ readyTimeoutMs: 5000 }));
    await tick();
    fake.last().emit('exit', 1);
    await expect(p).rejects.toThrow(/退出/);
  }, 10000);

  it('C2. 握手完成后子进程退出不影响已 resolve 的 spawn（gate 幂等）', async () => {
    const p = spawnForAgent(spawnOpts({ readyTimeoutMs: 5000 }));
    await tick();
    fake.last().emit('message', { type: 'runtime-ready' });
    const runtime = await p;
    // ready 之后的 exit：gate 已 settle，重复 settle 为 no-op
    fake.last().emit('exit', 0);
    expect(runtime.child.connected).toBe(true);
  }, 10000);
});

describe('runtime-registry spawn 闭包（握手期 exit 的 TDZ 回归锁）', () => {
  beforeEach(() => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __clearRuntimeRegistryForTest();
  });

  it('D. 握手期 child exit → onExit 闭包不解引用未赋值的 runtime（无 ReferenceError）', async () => {
    const opts: AgentRuntimeOpts = { ...runtimeConfig, instanceId: 'inst-tdz', agentAssignmentId: 'inst-tdz' };
    const pool = createTaskDrivenRuntime(opts);
    // warm 不 await：让 spawn 闭包停在 await spawnForAgent(...) 挂起点
    const warmP = pool.warm('inst-tdz').catch(() => undefined);
    await tick();

    // 修复前：onExit 闭包解引用 TDZ 的 runtime → ReferenceError 向 emit 冒泡（红）
    expect(() => fake.last().emit('exit', 1)).not.toThrow();

    await warmP;
    // 握手期退出的子进程绝不入池
    expect(pool.size('inst-tdz')).toBe(0);
    __clearRuntimeRegistryForTest();
  }, 10000);

  it('D2. 握手完成后入池 + 池内 child 退出被 evict（既有清理链不回归）', async () => {
    const opts: AgentRuntimeOpts = { ...runtimeConfig, instanceId: 'inst-ok', agentAssignmentId: 'inst-ok' };
    const pool = createTaskDrivenRuntime(opts);
    const warmP = pool.warm('inst-ok');
    // warm 串行 spawn K=2 个：逐个等 fork 发生后发 ready
    for (let i = 0; i < 2; i++) {
      for (let guard = 0; fake.children.length <= i && guard < 50; guard++) {
        await tick();
      }
      fake.children[i]!.emit('message', { type: 'runtime-ready' });
      await tick();
    }
    await warmP;
    expect(pool.size('inst-ok')).toBe(2);

    // 仍在池中的第一个 child 退出 → evict 生效（池减一）
    fake.children[0]!.emit('exit', 0);
    expect(pool.size('inst-ok')).toBe(1);
    __clearRuntimeRegistryForTest();
  }, 15000);
});

// 进程级收尾：registry 用例打开了 DB，这里兜底关闭
afterEach(() => {
  if (process.env.AP_USER_DATA_DIR) {
    closeDb();
    delete process.env.AP_USER_DATA_DIR;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
