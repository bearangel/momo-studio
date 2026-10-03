# 写授权硬门控实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 授权卡弹出后 agent 硬等待用户处置（covered 原地重执行 / denied 即时返回 / aborted 随停止按钮终止），修复 `toolchainOn ||` 瞬断 bug，并把文件写工具接入同一门控。

**Architecture:** 等待循环泛化为 `write-grant-wait`（无限等待 + denied 推送出口）；覆盖判定单点化为 effective 三层合成成员判定；拒绝信号走 renderer→IPC→runtime 广播→子进程通知器；`WorkspaceFS` 增量 `extraRootDirs` 让授权目录对文件工具放行；`runWithWriteGrant` 包装文件写工具。

**Tech Stack:** Electron 主进程（CommonJS）+ runtime 子进程（fork IPC）+ React renderer；better-sqlite3 kv_store；vitest。

**Spec:** `docs/specs/2026-10-03-write-grant-hard-gate-design.md`（本计划一切行为语义以 spec 为准；执行者须同时读 spec）

## Global Constraints

- Node 20 LTS：所有命令先 `nvm use 20`；包管理一律 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `as any` / `@ts-ignore`（ESLint no-explicit-any: error）
- 所有代码注释中文；Conventional Commits（`feat:` / `test:` / `refactor:`，中文描述体，对照 `git log` 既有风格）
- 单测位置：electron 主进程集中在 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated；跑法 `cd electron && npx pnpm@9.0.0 vitest run tests/<path>`
- 线协议两端同 commit 修改（momo-boundary-rules）：`write-grant-denied` 的发送端（Task 4）与消费端（Task 2 的通知器 + Task 4 的 runtime-entry 路由）不得分批合入
- mock 保真（momo-test-rules）：不简化 this 绑定 / ID 唯一性；`process.send` 伪装用 `Object.defineProperty(process, 'send', {...})`（既有测试先例）
- renderer 改动纯行为接线（无视觉变更），momo-ui-preview-rules P2 豁免，事后跑既有组件测试验收
- typecheck 双 workspace：`npx pnpm@9.0.0 typecheck`（IPC 契约变更门禁）

## Review Focus

执行者对照下表——每行都是 spec 隐含但容易咬人的失效面，测试已钉在对应任务里：

1. **`toolchainOn ||` 瞬断复活**：`sandboxToolchainPolicy='allow'` 机器上非预置目录被拦必须真挂起（不是秒判 covered 烧完轮次）——Task 3 回归测试 + 源码子串锁
2. **拒绝广播链断环**：IPC→registry→child.send→runtime-entry 路由→通知器，任一环哑火即「拒绝无效、agent 永挂」——Task 2 通知器矩阵 / Task 4 广播 + 路由子串锁 / Task 5 IPC 纯函数
3. **停止按钮在无限等待中失效**：abortSignal 必须即时唤醒（否则无限等待变成不可终止的挂死）——Task 2 abort 用例
4. **带空格路径提取截断**：macOS 路径常含空格，regex 必须锚定固定后缀——Task 7 extractOutOfWsPath 用例 + Task 6 WorkspaceFS 错误文案锁
5. **extra 根 symlink 逃逸绕过**：授权目录内的符号链接指向根外必须仍被拒（逐根 realpath 判定）——Task 6 逃逸用例

---

### Task 1: effective 三层合成（spec §4.1）

**Files:**
- Modify: `electron/src/main/sandbox/network-trust.ts:59-85`
- Test: `electron/tests/sandbox/network-trust.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `getSandboxSettings()` / `getGrantedDirs(sessionId, workspaceId)` / `expandToolchainDirs(raw, home)`（均既有）
- Produces: `handleNetTrustOp` 的 `extraDirs` 含三层合成（后续任务的 isCovered 成员判定以此为准；字段形状 `string[]` 不变）

- [ ] **Step 1: 写失败测试**（追加到 `electron/tests/sandbox/network-trust.test.ts` 末尾）

```typescript
describe('effective extraDirs 三层合成（spec hard-gate §4.1——bug ① 根因修复）', () => {
  it('toolchainPolicy=allow + 预置清单 + ws 授权 → 预置层参与合成（去重归一）', async () => {
    __setSandboxSettingsForTest({
      mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'allow',
      toolchainDirs: ['~/.cargo-test-l3'],
    });
    grantWriteDirs('workspace', 'ws-l3', ['/tmp/ws-grant-l3']);
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'l3-1', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-l3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 预置层（~ 展开归一）与 ws 层都 present
      expect(r.payload.extraDirs).toContain(path.join(os.homedir(), '.cargo-test-l3'));
      expect(r.payload.extraDirs).toContain('/tmp/ws-grant-l3');
    }
  });

  it('toolchainPolicy=deny → 预置层不参与（仅动态两层）——回归锁：allow 开关不再被 isCovered 当覆盖用', async () => {
    __setSandboxSettingsForTest({
      mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'deny',
      toolchainDirs: ['~/.cargo-test-l3'],
    });
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'l3-2', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-l3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.extraDirs).not.toContain(path.join(os.homedir(), '.cargo-test-l3'));
    }
  });

  it('同目录双源去重（预置 ∯ ws 授权同一路径 → 单条）', async () => {
    const dual = path.join(os.tmpdir(), `dual-l3-${Date.now()}`);
    fs.mkdirSync(dual, { recursive: true });
    __setSandboxSettingsForTest({
      mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'allow',
      toolchainDirs: [dual],
    });
    grantWriteDirs('workspace', 'ws-l3', [dual]);
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'l3-3', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-l3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.extraDirs.filter((d) => d === fs.realpathSync(dual))).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/network-trust.test.ts`
Expected: FAIL——`l3-1` 用例 extraDirs 不含预置层（现状只回传两层）

- [ ] **Step 3: 最小实现**（`network-trust.ts`）

顶部 import 区追加：

```typescript
import os from 'node:os';
import { expandToolchainDirs } from './toolchain-grant';
```

`handleNetTrustOp` try 块内（`const extraDirs = getGrantedDirs(...)` 一行）替换为：

```typescript
    // extraDirs 三层合成（spec hard-gate §4.1）：预置层仅 allow 时展开参与——
    // 此前只回传两层，shell-tools 的 isCovered 用 `toolchainOn ||` 布尔补偿缺失
    // 层，导致 allow 开关下任何被拦目录瞬判 covered（bug ①）。字段形状不变。
    const presetDirs = toolchainOn
      ? expandToolchainDirs(settings.toolchainDirs, os.homedir())
      : [];
    const extraDirs = [...new Set([...presetDirs, ...getGrantedDirs(sessionId, parsed.workspaceId ?? null)])];
```

同时更新文件头注释第 13-15 行的三层描述为「预置(allow 时) ∪ 会话 ∪ 工作空间」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/network-trust.test.ts`
Expected: PASS 全绿（含既有用例——`settings()` 构造器默认 deny，既有断言 extraDirs:[] 不受影响）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/network-trust.ts electron/tests/sandbox/network-trust.test.ts
git commit -m "fix(sandbox): effective extraDirs 补全三层合成——预置层仅 allow 时参与（spec hard-gate §4.1）"
```

---

### Task 2: write-grant-wait 模块（改名 + denied 出口 + 无限等待，spec §5）

**Files:**
- Create: `electron/src/main/agent/tools/write-grant-wait.ts`（内容 = `bash-write-wait.ts` 泛化重写）
- Delete: `electron/src/main/agent/tools/bash-write-wait.ts`
- Modify: `electron/src/main/agent/tools/shell-tools.ts:39`（import 路径，其余不动——Task 3 再改逻辑）
- Test: 把 `electron/tests/agent/tools/bash-write-wait.test.ts` 重写为 `electron/tests/agent/tools/write-grant-wait.test.ts`

**Interfaces:**
- Produces（后续任务消费的精确签名）:
  - `waitForWriteGrant(opts: { dirs: string[]; isCovered: () => Promise<boolean>; tickMs?: number; signal?: AbortSignal }): Promise<WriteWaitOutcome>`
  - `WriteWaitOutcome = { kind: 'covered' } | { kind: 'denied' } | { kind: 'aborted' }`（**timeout 出口删除、budgetMs 参数删除**）
  - `notifyWriteGrantDenied(msg: unknown): void`（runtime-entry 路由入口，Task 4 消费）
  - `formatWriteDeniedResult(dirs: string[]): string`（denied 出口统一文案，Task 3/7 消费）
  - `WRITE_GRANT_WAIT_TICK_MS = 2_000`
  - `__clearDeniedWaitersForTest(): void`

- [ ] **Step 1: 重写测试文件**（`git mv` 后全量替换 `electron/tests/agent/tools/write-grant-wait.test.ts` 内容）

```typescript
// electron/tests/agent/tools/write-grant-wait.test.ts
// 写授权硬门控等待循环（spec hard-gate §5）：covered/denied/aborted 三出口、
// 无限等待（无预算）、denied 推送即时解除、非 fork 短路 denied。
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  waitForWriteGrant,
  notifyWriteGrantDenied,
  formatWriteDeniedResult,
  __clearDeniedWaitersForTest,
} from '../../../src/main/agent/tools/write-grant-wait';

const realSend = process.send;

afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __clearDeniedWaitersForTest();
  vi.useRealTimers();
});

function fakeFork(): void {
  Object.defineProperty(process, 'send', { value: (): boolean => true, configurable: true });
}

describe('waitForWriteGrant 出口三态（spec §5）', () => {
  it('isCovered 立即 true → covered（零等待）', async () => {
    fakeFork();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, tickMs: 10 });
    expect(r).toEqual({ kind: 'covered' });
  });

  it('前两拍 false 第三拍 true → covered（tick 轮询推进）', async () => {
    fakeFork();
    let n = 0;
    const r = await waitForWriteGrant({
      dirs: ['/d'],
      isCovered: async () => { n += 1; return n >= 3; },
      tickMs: 5,
    });
    expect(r).toEqual({ kind: 'covered' });
    expect(n).toBe(3);
  });

  it('无预算：fake timers 推进 10 分钟仍挂起，直至 covered（锁死 120s 有界语义不复活）', async () => {
    fakeFork();
    vi.useFakeTimers();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/d'], isCovered: async () => covered, tickMs: 2_000 });
    const done = p.then((r) => expect(r).toEqual({ kind: 'covered' }));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 10 分钟——旧 120s 预算下此处已 timeout
    covered = true;
    await vi.advanceTimersByTimeAsync(2_100);
    await done;
  });

  it('等待中 abort → aborted（即时唤醒，不等下一拍）', async () => {
    fakeFork();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const t0 = Date.now();
    const r = await waitForWriteGrant({
      dirs: ['/d'], isCovered: async () => false, tickMs: 60_000, signal: ac.signal,
    });
    expect(r).toEqual({ kind: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('非 fork 环境（process.send 缺失）→ 立即 denied（无人可答 = 拒绝收敛）', async () => {
    Object.defineProperty(process, 'send', { value: undefined, configurable: true });
    const t0 = Date.now();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, tickMs: 10 });
    expect(r).toEqual({ kind: 'denied' });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe('denied 推送即时解除（spec §4.4 匹配规则）', () => {
  it('等待中收到匹配 dirs 的广播 → 立即 denied（不等下一拍）', async () => {
    fakeFork();
    const p = waitForWriteGrant({ dirs: ['/a', '/b'], isCovered: async () => false, tickMs: 5_000 });
    setTimeout(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/b', '/c'] }), 10);
    const t0 = Date.now();
    expect(await p).toEqual({ kind: 'denied' });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it('dirs 无交集 → 不解除（继续等到 covered）', async () => {
    fakeFork();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/a'], isCovered: async () => covered, tickMs: 5 });
    notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/x'] });
    setTimeout(() => { covered = true; }, 20);
    expect(await p).toEqual({ kind: 'covered' });
  });

  it('空对空：广播 dirs=[] 解除等待方 dirs=[]（降级卡关闭链路）', async () => {
    fakeFork();
    const p = waitForWriteGrant({ dirs: [], isCovered: async () => false, tickMs: 5_000 });
    setTimeout(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: [] }), 10);
    expect(await p).toEqual({ kind: 'denied' });
  });

  it('广播 dirs=[] 不解除非空等待方（空对空单向语义）', async () => {
    fakeFork();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/a'], isCovered: async () => covered, tickMs: 5 });
    notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: [] });
    setTimeout(() => { covered = true; }, 20);
    expect(await p).toEqual({ kind: 'covered' });
  });

  it('载荷形状防御：type 不符 / dirs 非数组 / 含非字符串 → no-op 不抛', () => {
    expect(() => notifyWriteGrantDenied({ type: 'other', dirs: ['/a'] })).not.toThrow();
    expect(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: 42 })).not.toThrow();
    expect(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/a', 7] })).not.toThrow();
    expect(() => notifyWriteGrantDenied('not-an-object')).not.toThrow();
  });
});

describe('文案与接线锁', () => {
  it('formatWriteDeniedResult 逐字（spec §7）', () => {
    expect(formatWriteDeniedResult(['/a', '/b'])).toBe(
      '用户已拒绝授权（目录：/a、/b）。请勿重试同一目标；如确需写入请与用户协商其他方案。',
    );
    expect(formatWriteDeniedResult([])).toBe(
      '用户已拒绝授权（目录：未能定位）。请勿重试同一目标；如确需写入请与用户协商其他方案。',
    );
  });

  it('runtime-entry 已路由 write-grant-denied（接线子串锁——防广播链断环）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/main/agent/runtime-entry.ts'),
      'utf-8',
    );
    expect(src).toContain("m.type === 'write-grant-denied'");
    expect(src).toContain('notifyWriteGrantDenied(msg)');
  });
});
```

注意：接线子串锁在本 Step 会 FAIL（runtime-entry 尚未接线）——本任务先让它跳过（`it.todo`）或与 Task 4 联动；**裁定：本 Step 先写成 `it('...', { todo: 'Task 4 接线后启用' })` 形态占位断言已写好，Task 4 Step 3 去掉 todo 后此测试转正。**

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-wait.test.ts`
Expected: FAIL——模块 `write-grant-wait` 不存在

- [ ] **Step 3: 写实现**（新建 `electron/src/main/agent/tools/write-grant-wait.ts`，删除 `bash-write-wait.ts`）

```typescript
// electron/src/main/agent/tools/write-grant-wait.ts
// 写授权硬门控等待循环（spec 2026-10-03 hard-gate §3/§5；前生 bash-write-wait §12）：
// 越界工具调用挂起等待用户在授权卡上处置——三出口：
//   covered = 轮询 effective 成员判定命中（授权落地，调用方原地重执行）
//   denied  = 主进程广播 write-grant-denied 推送解除（用户拒绝，即时返回）
//   aborted = ctx.abortSignal（停止按钮——无限等待下唯一的机器侧逃生口）
// 无限等待：无预算上限（产品裁定对齐 Claude Code）。
//
// 非 fork 环境（process.send 缺失——直跑单测/CLI）短路为立即 denied：没有主进程
// 就没有授权卡，等待无人应答，语义上等价用户缺席时的拒绝收敛。

export type WriteWaitOutcome =
  | { kind: 'covered' }
  | { kind: 'denied' }
  | { kind: 'aborted' };

/** 轮询节拍（每拍一次 effective 桥查询，IPC 开销可忽略） */
export const WRITE_GRANT_WAIT_TICK_MS = 2_000;

/** 拒绝广播的等待方匹配（spec §4.4）：dirs 有交集，或两侧均为空（降级卡关闭意图） */
function denialMatches(waitDirs: string[], denyDirs: string[]): boolean {
  if (denyDirs.length === 0) return waitDirs.length === 0;
  return waitDirs.some((d) => denyDirs.includes(d));
}

interface DeniedWaiter {
  dirs: string[];
  fire: () => void;
}

/** 在途等待订阅表（模块级——同进程多个工具调用各自注册互不干扰） */
const deniedWaiters = new Set<DeniedWaiter>();

/**
 * 主进程 write-grant-denied 广播的消费入口（runtime-entry 的 taskMessageListener
 * 分发到此）。按 §4.4 匹配规则唤醒在途等待；无匹配 no-op。载荷形状不符静默忽略
 * （未知消息不崩——线协议向后兼容铁律）。
 */
export function notifyWriteGrantDenied(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: unknown; dirs?: unknown };
  if (m.type !== 'write-grant-denied') return;
  if (!Array.isArray(m.dirs) || m.dirs.some((d) => typeof d !== 'string')) return;
  for (const w of [...deniedWaiters]) {
    if (denialMatches(w.dirs, m.dirs as string[])) w.fire();
  }
}

/** 测试用：清空订阅表（防跨用例泄漏） */
export function __clearDeniedWaitersForTest(): void {
  deniedWaiters.clear();
}

export async function waitForWriteGrant(opts: {
  dirs: string[];
  /** 覆盖判定（生产 = effective 桥轮询：dirs ⊆ extraDirs 三层合成） */
  isCovered: () => Promise<boolean>;
  tickMs?: number;
  signal?: AbortSignal;
}): Promise<WriteWaitOutcome> {
  // 非 fork 短路（原 §12 timeout 短路的拒绝语义迁移）
  if (typeof process.send !== 'function') return { kind: 'denied' };
  const tick = opts.tickMs ?? WRITE_GRANT_WAIT_TICK_MS;

  let deniedFired = false;
  let deniedResolve!: () => void;
  const deniedPromise = new Promise<void>((resolve) => {
    deniedResolve = resolve;
  });
  const waiter: DeniedWaiter = {
    dirs: opts.dirs,
    fire: () => {
      deniedFired = true;
      deniedResolve();
    },
  };
  deniedWaiters.add(waiter);
  try {
    for (;;) {
      if (opts.signal?.aborted) return { kind: 'aborted' };
      if (await opts.isCovered()) return { kind: 'covered' };
      // 三路竞速：denied 推送 / abort / tick 到点。denied 胜出时 sleep 侧 timer
      // 可能仍挂一拍（≤tick 后自然 resolve，无副作用）——可接受的悬挂粒度。
      await Promise.race([deniedPromise, sleepInterruptible(tick, opts.signal)]);
      if (opts.signal?.aborted) return { kind: 'aborted' };
      if (deniedFired) return { kind: 'denied' };
    }
  } finally {
    deniedWaiters.delete(waiter);
  }
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** denied 出口回给 LLM 的统一文案（bash 与文件工具共用，spec §7 逐字） */
export function formatWriteDeniedResult(dirs: string[]): string {
  return `用户已拒绝授权（目录：${dirs.join('、') || '未能定位'}）。请勿重试同一目标；如确需写入请与用户协商其他方案。`;
}
```

同步改 `shell-tools.ts:39` 的 import：`import { waitForWriteGrant } from './write-grant-wait';`（`budgetMs` 未在 shell-tools 出现，无其他破坏）。此时 shell-tools 的 `if (wait.kind === 'timeout') break;` 分支类型不再穷尽匹配——TS 会报 timeout 不存在于 WriteWaitOutcome，**先临时改为 `if (wait.kind !== 'covered') break;` 保持编译绿，Task 3 再正式改 denied 分支**。

删除旧文件与旧测试：`git rm electron/src/main/agent/tools/bash-write-wait.ts`（旧测试文件已被重写替代）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-wait.test.ts tests/agent/tools/shell-tools.test.ts`
Expected: write-grant-wait 全绿（todo 除外）；shell-tools 既有 §12 用例中引用 `{ kind: 'timeout' }` 的替身会类型不过/断言失败——**同 commit 内把这三处替身改为 `{ kind: 'denied' }` 并把断言改为拒绝文案**（正式改造在 Task 3，此处仅保编译与套件绿：最小改法——`timeout` 用例改 `denied` + 断言 `formatWriteDeniedResult`；详见 Task 3 Step 1，可提前借用）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/write-grant-wait.ts electron/tests/agent/tools/write-grant-wait.test.ts electron/src/main/agent/tools/shell-tools.ts
git rm electron/src/main/agent/tools/bash-write-wait.ts electron/tests/agent/tools/bash-write-wait.test.ts
git commit -m "refactor(sandbox): bash-write-wait 泛化为 write-grant-wait——无限等待 + denied 推送出口（spec hard-gate §5）"
```

---

### Task 3: shell-tools isCovered 修复 + denied 集成 + hint 文案（spec §4.2/§9）

**Files:**
- Modify: `electron/src/main/agent/tools/shell-tools.ts:180-215`（execute 等待段）
- Modify: `electron/src/main/agent/tools/sandbox-write-hint.ts:110-111`（WRITE_BLOCKED_HINT）
- Test: `electron/tests/agent/tools/shell-tools.test.ts`（§12 describe 重写）+ `electron/tests/agent/tools/sandbox-write-hint.test.ts`（文案锁更新）

**Interfaces:**
- Consumes: Task 2 的 `WriteWaitOutcome` / `formatWriteDeniedResult`
- Produces: bash 工具 denied → 返回 `formatWriteDeniedResult(dirs)` 文本；isCovered 纯成员判定

- [ ] **Step 1: 重写 shell-tools.test.ts 的 §12 describe**（保留 describe 头与 beforeEach/afterEach 不动，替换三个 itDarwin 用例并新增回归用例）

```typescript
  itDarwin('真被拦 → 上报 write-blocked-report → covered 后重执行成功（无缝续跑）', async () => {
    // —— 原用例保持不变（covered 路径行为未变），此处省略重复：保留 276-303 行原体 ——
  });

  itDarwin('denied → 返回统一拒绝文案（无 hint、无重执行）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    __setNetQueryForTest(async () => ({ netOn: false, toolchainOn: false, extraDirs: [] }));
    __setBashWriteWaitForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    // dirs 形态取决于 WRITE_BLOCKED_CMD 的路径提取——锁前缀语义，不锁具体目录
    expect(result).toMatch(/^用户已拒绝授权（目录：.+）。请勿重试同一目标；如确需写入请与用户协商其他方案。$/);
    expect(result).not.toContain('工作空间外路径写入被沙箱拦截');
    expect(capturedSends.filter((m) => m.type === 'write-blocked-report')).toHaveLength(1);
  });

  itDarwin('covered 但重执行仍被拦（新目录）→ 循环再等待；denied 收敛', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    __setNetQueryForTest(async () => ({ netOn: false, toolchainOn: false, extraDirs: [] }));
    let waitCalls = 0;
    __setBashWriteWaitForTest({
      wait: async () => {
        waitCalls += 1;
        return waitCalls <= 1 ? { kind: 'covered' as const } : { kind: 'denied' as const };
      },
    });
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    expect(waitCalls).toBe(2);
    expect(result).toContain('用户已拒绝授权');
    expect(capturedSends.filter((m) => m.type === 'write-blocked-report').length).toBeGreaterThanOrEqual(2);
  });

  itDarwin('回归锁 bug ①：toolchainOn=true 且被拦目录不在 extraDirs → isCovered 必须为 false（不瞬断）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    // 旧 bug 形态：allow 开关 + 非预置目录被拦——isCovered 曾恒 true
    __setNetQueryForTest(async () => ({ netOn: false, toolchainOn: true, extraDirs: [] }));
    let probe: boolean | undefined;
    __setBashWriteWaitForTest({
      wait: async (o) => {
        probe = await o.isCovered();
        return { kind: 'denied' as const };
      },
    });
    const tools = new ShellTools();
    await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    expect(probe).toBe(false); // 旧代码此处为 true——瞬判 covered 零等待
  });
```

import 区补 `formatWriteDeniedResult`（与 waitForWriteGrant 同源）。文件末尾追加源码子串锁：

```typescript
describe('isCovered 源码锁（spec hard-gate §4.2）', () => {
  it('不再以 eff.toolchainOn 作覆盖判定（bug ① 防复活）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/main/agent/tools/shell-tools.ts'),
      'utf-8',
    );
    expect(src).not.toContain('eff.toolchainOn ||');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tools.test.ts`
Expected: FAIL——denied 分支未实现（result 含 hint 而非拒绝文案）、`eff.toolchainOn ||` 仍在源码

- [ ] **Step 3: 实现**（`shell-tools.ts`）

execute 的等待段（183-215 行区域）改为：

```typescript
    // spec hard-gate §5 硬门控等待：首轮被拦 → 上报主进程（弹授权卡）→ 无限等待
    // （covered 原地重执行 / denied 即时返回 / aborted 随停止按钮）。
    // queryNet 每轮现解析 override（等待回调里可能翻转替身——模拟授权落地）
    let last = await this.bashOnce(command, timeoutMs, ctx);
    for (let round = 0; last.blocked && round < WRITE_WAIT_MAX_ROUNDS; round += 1) {
      // fire-and-forget 上报（proc-group:register 同形态；非 fork 环境 no-op）
      process.send?.({
        type: 'write-blocked-report',
        streamSessionId: ctx.streamSessionId,
        workspaceId: ctx.workspaceId,
        dirs: last.dirs,
        command,
      });
      const queryNet = netQueryOverride ?? requestEffectiveNetwork;
      const doWait = writeWaitOverride ?? waitForWriteGrant;
      const wait = await doWait({
        dirs: last.dirs,
        signal: ctx.abortSignal,
        isCovered: async () => {
          try {
            const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
            // spec hard-gate §4.2 纯成员判定：toolchainOn 与被拦目录是否放行无关
            return last.dirs.some((d) => eff.extraDirs.includes(d));
          } catch {
            return false;
          }
        },
      });
      if (wait.kind === 'aborted') {
        const e = new Error('bash 被中断');
        e.name = 'AbortError';
        throw e;
      }
      if (wait.kind === 'denied') return formatWriteDeniedResult(last.dirs);
      last = await this.bashOnce(command, timeoutMs, ctx);
    }
    return last.text;
```

import 行改为 `import { waitForWriteGrant, formatWriteDeniedResult } from './write-grant-wait';`。

`sandbox-write-hint.ts` 的 `WRITE_BLOCKED_HINT` 逐字替换：

```typescript
export const WRITE_BLOCKED_HINT =
  '⚠ 工作空间外路径写入被沙箱拦截。系统已弹出授权卡并暂停等待用户处置：用户放行后本命令会自动重试；用户拒绝时你会收到明确的拒绝结果。请勿用临时目录或缓存重定向绕过，也勿在等待期间尝试其他写入路径。';
```

同步更新 `sandbox-write-hint.test.ts` 中旧文案断言（grep 旧子串「请暂停后续重试并告知用户」定位；替换为新文案全量或首句锚定）。renderer `stream.store.test.ts` 若有子串锁引用旧文案，同步更新（先跑 `cd renderer && npx pnpm@9.0.0 vitest run src` 观察失败点）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tools.test.ts tests/agent/tools/sandbox-write-hint.test.ts && cd ../renderer && npx pnpm@9.0.0 vitest run src`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/shell-tools.ts electron/src/main/agent/tools/sandbox-write-hint.ts electron/tests/agent/tools/shell-tools.test.ts electron/tests/agent/tools/sandbox-write-hint.test.ts renderer/src/stores/stream.store.test.ts
git commit -m "fix(sandbox): isCovered 纯成员判定修复瞬断 bug + denied 即时返回 + hint 三态文案（spec hard-gate §4.2/§9）"
```

---

### Task 4: 拒绝广播链（spec §4.4——AgentRunner / runtime-registry / runtime-entry）

**Files:**
- Modify: `electron/src/main/agent/agent-runner.ts`（notifyTaskReply 后追加方法，~815 行）
- Modify: `electron/src/main/agent/runtime-registry.ts`（abortTasksBySessionEverywhere 后追加，~301 行）
- Modify: `electron/src/main/agent/runtime-entry.ts:345-361`（taskMessageListener 加分支）
- Test: 新建 `electron/tests/agent/write-grant-broadcast.test.ts`；启用 Task 2 的 todo 接线锁

**Interfaces:**
- Consumes: Task 2 的 `notifyWriteGrantDenied(msg)`
- Produces: `broadcastWriteGrantDenied(dirs: string[]): boolean`（Task 5 的 IPC handler 消费）；`AgentRunner.notifyWriteGrantDenied(dirs: string[]): void`；`__pushRunnerForTest(runner: AgentRunner): void`

- [ ] **Step 1: 写失败测试**（新建 `electron/tests/agent/write-grant-broadcast.test.ts`）

```typescript
// electron/tests/agent/write-grant-broadcast.test.ts
// 写授权拒绝广播链（spec hard-gate §4.4）：registry 遍历 runner → 活跃流 child.send。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastWriteGrantDenied,
  __clearRuntimeRegistryForTest,
  __pushRunnerForTest,
} from '../../src/main/agent/runtime-registry';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

beforeEach(() => __clearRuntimeRegistryForTest());
afterEach(() => __clearRuntimeRegistryForTest());

/** stub runner：只实现广播链消费的两个方法（结构 typing——AgentRunner 其余成员不参与本链路） */
function stubRunner(active: number): AgentRunner {
  return {
    activeTaskCount: () => active,
    notifyWriteGrantDenied: vi.fn(),
  } as unknown as AgentRunner;
}

describe('broadcastWriteGrantDenied（spec §4.4）', () => {
  it('有活跃流的 runner → 推送；无活跃流跳过；返回命中', () => {
    const busy = stubRunner(1);
    const idle = stubRunner(0);
    __pushRunnerForTest(busy);
    __pushRunnerForTest(idle);
    const hit = broadcastWriteGrantDenied(['/d']);
    expect(hit).toBe(true);
    expect(busy.notifyWriteGrantDenied).toHaveBeenCalledWith(['/d']);
    expect(idle.notifyWriteGrantDenied).not.toHaveBeenCalled();
  });

  it('无 runner / 全空闲 → false', () => {
    expect(broadcastWriteGrantDenied(['/d'])).toBe(false);
    __pushRunnerForTest(stubRunner(0));
    expect(broadcastWriteGrantDenied(['/d'])).toBe(false);
  });

  it('空 dirs 合法载荷（降级卡链路）——原样广播不拦截', () => {
    const busy = stubRunner(1);
    __pushRunnerForTest(busy);
    broadcastWriteGrantDenied([]);
    expect(busy.notifyWriteGrantDenied).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/write-grant-broadcast.test.ts`
Expected: FAIL——`broadcastWriteGrantDenied` / `__pushRunnerForTest` 未导出

- [ ] **Step 3: 实现**

`agent-runner.ts`（`notifyTaskReply` 方法后追加）：

```typescript
  /**
   * 写授权拒绝广播（spec 2026-10-03 hard-gate §4.4）：向全部活跃流的子进程推送
   * write-grant-denied——等待中的 waitForWriteGrant 按 §4.4 匹配规则解除为
   * denied；无等待的子进程侧 no-op。照 notifyTaskReply 形态（5 行同构）。
   */
  notifyWriteGrantDenied(dirs: string[]): void {
    for (const active of this.activeTasks.values()) {
      active.runtime.child.send({ type: 'write-grant-denied', dirs });
    }
  }
```

`runtime-registry.ts`（`abortTasksBySessionEverywhere` 后追加）：

```typescript
/**
 * 写授权拒绝广播入口（spec 2026-10-03 hard-gate §4.4）：sandbox:denyWrite IPC →
 * 遍历全部 runner 的活跃流推送。fire-and-forget：无活跃流返回 false。
 */
export function broadcastWriteGrantDenied(dirs: string[]): boolean {
  let hit = false;
  for (const runner of agentRunners.values()) {
    if (runner.activeTaskCount() > 0) {
      runner.notifyWriteGrantDenied(dirs);
      hit = true;
    }
  }
  return hit;
}

/** 测试用：直接注入 stub runner（广播链单测——绕过 startTask 重组件 fixture） */
export function __pushRunnerForTest(runner: AgentRunner): void {
  agentRunners.set(runner.assignmentId, runner);
}
```

`runtime-entry.ts`：import 区补 `import { notifyWriteGrantDenied } from './tools/write-grant-wait';`；taskMessageListener 的 `net-trust-op:result` 分支（350-351 行）后追加同构分支：

```typescript
    } else if (m.type === 'write-grant-denied') {
      notifyWriteGrantDenied(msg);
```

同时删除 Task 2 测试文件中接线锁用例的 `{ todo: ... }` 标记，转正。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/write-grant-broadcast.test.ts tests/agent/tools/write-grant-wait.test.ts`
Expected: PASS（含转正的接线子串锁）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/agent-runner.ts electron/src/main/agent/runtime-registry.ts electron/src/main/agent/runtime-entry.ts electron/tests/agent/write-grant-broadcast.test.ts electron/tests/agent/tools/write-grant-wait.test.ts
git commit -m "feat(sandbox): write-grant-denied 拒绝广播链——registry 遍历活跃流推送 + runtime-entry 路由（spec hard-gate §4.4）"
```

---

### Task 5: sandbox:denyWrite IPC（spec §4.3——含 preload / types.d.ts）

**Files:**
- Modify: `electron/src/main/sandbox/ipc.handlers.ts`（grantWrite 后追加）
- Modify: `renderer/src/ipc/types.d.ts:1438-1448`（grantWrite 邻位）
- Modify: `electron/src/preload/index.ts`（grantWrite 邻位——grep `grantWrite` 定位）
- Test: 新建 `electron/tests/sandbox/deny-write-ipc.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `broadcastWriteGrantDenied`
- Produces: `handleDenyWrite(arg: unknown, broadcast: (dirs: string[]) => void): void`（纯函数，测试面）；renderer 侧 `ipc.sandbox.denyWrite({ sessionId: string | null; dirs: string[] }): Promise<void>`（Task 9 消费）

- [ ] **Step 1: 写失败测试**（新建 `electron/tests/sandbox/deny-write-ipc.test.ts`）

```typescript
// electron/tests/sandbox/deny-write-ipc.test.ts
// sandbox:denyWrite 载荷处理（spec hard-gate §4.3）：逐字段校验 + 广播转发。
// 纯函数直测（ipcMain 注册壳不进单测——electron 模块依赖）。
import { describe, it, expect, vi } from 'vitest';
import { handleDenyWrite } from '../../src/main/sandbox/ipc.handlers';

describe('handleDenyWrite（spec §4.3）', () => {
  it('合法载荷 → 广播原样转发（dirs 透传，sessionId 仅日志用途不进广播）', () => {
    const broadcast = vi.fn();
    handleDenyWrite({ sessionId: 's-1', dirs: ['/a', '/b'] }, broadcast);
    expect(broadcast).toHaveBeenCalledWith(['/a', '/b']);
  });

  it('sessionId=null 合法（卡事件解析失败降级形态）', () => {
    const broadcast = vi.fn();
    expect(() => handleDenyWrite({ sessionId: null, dirs: [] }, broadcast)).not.toThrow();
    expect(broadcast).toHaveBeenCalledWith([]);
  });

  it('dirs 非数组 / 含非字符串 → 抛中文错误（防串写，照 grantWrite 校验风格）', () => {
    const broadcast = vi.fn();
    expect(() => handleDenyWrite({ sessionId: 's', dirs: 42 }, broadcast)).toThrow('dirs 非法');
    expect(() => handleDenyWrite({ sessionId: 's', dirs: ['/a', 7] }, broadcast)).toThrow('dirs 非法');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sessionId 非法类型（非 string 非 null）→ 抛错', () => {
    expect(() => handleDenyWrite({ sessionId: 42, dirs: [] }, vi.fn())).toThrow('sessionId 非法');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/deny-write-ipc.test.ts`
Expected: FAIL——`handleDenyWrite` 未导出

- [ ] **Step 3: 实现**

`ipc.handlers.ts`：import 区补 `import { broadcastWriteGrantDenied } from '../agent/runtime-registry';`；`registerSandboxIpc` 内 `sandbox:grantWrite` handler 后追加：

```typescript
  /**
   * 写授权拒绝（spec hard-gate §4.3）：卡「拒绝」/「X 关闭」→ 广播解除等待中的
   * 工具调用。无状态转发（匹配在子进程侧）；载荷校验风格照 grantWrite。
   */
  ipcMain.handle('sandbox:denyWrite', (_e, arg: unknown) => {
    handleDenyWrite(arg, broadcastWriteGrantDenied);
  });
```

模块级（registerSandboxIpc 外）导出纯函数：

```typescript
/** sandbox:denyWrite 载荷处理（纯函数——ipcMain 壳的测试面） */
export function handleDenyWrite(
  arg: unknown,
  broadcast: (dirs: string[]) => void,
): void {
  const a = arg as { sessionId?: unknown; dirs?: unknown };
  if (a.sessionId !== null && typeof a.sessionId !== 'string') throw new Error('sessionId 非法');
  if (!Array.isArray(a.dirs) || a.dirs.some((d) => typeof d !== 'string')) throw new Error('dirs 非法');
  broadcast(a.dirs as string[]);
  logger.info('写授权已拒绝（广播解除等待）', { sessionId: a.sessionId, count: (a.dirs as string[]).length });
}
```

`renderer/src/ipc/types.d.ts`（grantWrite 声明后邻位追加）：

```typescript
    /** 写授权拒绝（spec 2026-10-03 hard-gate §4.3）：广播解除等待中的工具调用 */
    denyWrite(arg: { sessionId: string | null; dirs: string[] }): Promise<void>;
```

`electron/src/preload/index.ts`（grantWrite 实现邻位，同款 invoke 形态追加）：

```typescript
      denyWrite: (arg: { sessionId: string | null; dirs: string[] }) =>
        ipcRenderer.invoke('sandbox:denyWrite', arg),
```

- [ ] **Step 4: 跑测试 + 双 workspace typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/deny-write-ipc.test.ts && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / typecheck 双绿（IPC 契约门禁）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/sandbox/deny-write-ipc.test.ts
git commit -m "feat(sandbox): sandbox:denyWrite IPC——拒绝广播的 renderer 入口 + preload/types 契约（spec hard-gate §4.3）"
```

---

### Task 6: WorkspaceFS extraRootDirs（spec §6）

**Files:**
- Modify: `electron/src/main/files/workspace-fs.ts:28-81`
- Test: `electron/tests/files/workspace-fs.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 既有 `isInsideDir` / `PATH_SEMANTICS_WIN32`
- Produces: `setExtraRootDirs(dirs: string[]): void`（Task 7 的 covered 刷新消费）；`assertInWorkspace` 多根放行语义；错误文案保持 `/路径越界: (.+) 不在 workspace 内/` 与 `/符号链接逃逸: (.+)/`（Task 7 regex 的契约）

- [ ] **Step 1: 写失败测试**（追加到 `electron/tests/files/workspace-fs.test.ts`；fixture 对齐该文件既有的临时目录构造方式——若既有用例有 `mkWs()` helper 则复用，否则按下述自建）

```typescript
describe('extraRootDirs（spec hard-gate §6）', () => {
  let root: string;
  let extra: string;
  let wfs: WorkspaceFS;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-root-'));
    extra = fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-extra-'));
    wfs = new WorkspaceFS(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  });

  it('默认空 → 越界行为与文案不变', () => {
    expect(() => wfs.assertInWorkspace(path.join(extra, 'f.txt'))).toThrow(
      /路径越界: .+ 不在 workspace 内/,
    );
  });

  it('setExtraRootDirs 后：extra 根内路径放行（读写在根外成功）', async () => {
    wfs.setExtraRootDirs([extra]);
    await wfs.writeFile(path.join(extra, 'f.txt'), 'x');
    expect((await wfs.readFile(path.join(extra, 'f.txt'))).toString()).toBe('x');
  });

  it('extra 根内 symlink 指向两根之外 → 逃逸拒绝（逐根 realpath 判定）', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-outside-'));
    try {
      fs.symlinkSync(outside, path.join(extra, 'link'));
      wfs.setExtraRootDirs([extra]);
      expect(() => wfs.assertInWorkspace(path.join(extra, 'link', 'f.txt'))).toThrow(
        /符号链接逃逸: .+/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('.git 保护仅 workspace 根：extra 根下 .git 路径放行（与 bash 授权后对齐）', () => {
    wfs.setExtraRootDirs([extra]);
    expect(wfs.assertInWorkspace(path.join(extra, '.git', 'config'))).toBe(
      path.join(extra, '.git', 'config'),
    );
    expect(() => wfs.assertInWorkspace(path.join(root, '.git', 'config'))).toThrow(
      /禁止操作 \.git 目录/,
    );
  });

  it('越界错误文案锁（含空格路径——write-grant-tool regex 的消费契约）', () => {
    const spaced = path.join(extra, 'My Dir With Spaces', 'f.txt');
    try {
      wfs.assertInWorkspace(spaced);
      throw new Error('应越界');
    } catch (err) {
      const m = /路径越界: (.+) 不在 workspace 内/.exec((err as Error).message);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(spaced); // 提取值必须完整还原带空格路径
    }
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs.test.ts`
Expected: FAIL——`setExtraRootDirs` 不存在

- [ ] **Step 3: 实现**（`workspace-fs.ts` 的 class 头与 `assertInWorkspace` 全量替换）

```typescript
export class WorkspaceFS {
  /** 写授权扩展根（spec 2026-10-03 hard-gate §6）：realpath 归一去重；默认空 = 既有行为 */
  private extraRootDirs: string[] = [];

  constructor(private rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** 设置写授权扩展根（子进程工具侧 covered 后注入三层合成目录） */
  setExtraRootDirs(dirs: string[]): void {
    const norm = dirs.map((d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return path.resolve(d);
      }
    });
    this.extraRootDirs = [...new Set(norm)];
  }

  /** 验证路径在 workspace 或任一 extra 根内，返回绝对路径 */
  assertInWorkspace(relativeOrAbsolutePath: string): string {
    const abs = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.rootDir, relativeOrAbsolutePath);

    const normalized = path.normalize(abs);

    // 1) 逐根判定（spec hard-gate §6）：workspace 根 + extra 根，命中任一根即通过
    //    该根的三查。symlink 逃逸记录首个错误但不立即抛——其他根仍可能合法容纳
    //    （如 extra 根恰为 symlink 目标所在）；全部根失败才抛逃逸。
    let escapeErr: Error | null = null;
    for (const root of [this.rootDir, ...this.extraRootDirs]) {
      if (!isInsideDir(root, normalized, { win32: PATH_SEMANTICS_WIN32 })) continue;

      // 2) 符号链接逃逸检查（相对该根；逐级上溯支持尚未创建的文件路径）
      let anchor = normalized;
      while (anchor !== root && !fs.existsSync(anchor)) {
        anchor = path.dirname(anchor);
      }
      if (anchor !== root) {
        const realRoot = fs.realpathSync(root);
        const realAnchor = fs.realpathSync(anchor);
        if (realAnchor !== realRoot && !realAnchor.startsWith(realRoot + path.sep)) {
          escapeErr ??= new Error(`符号链接逃逸: ${relativeOrAbsolutePath}`);
          continue;
        }
      }

      // 3) .git 保护仅 workspace 根（spec hard-gate §6：授权目录与 bash 授权后
      //    行为对齐）。段精确匹配语义与注释照旧（.github 等前缀 dotfile 不误伤）。
      if (root === this.rootDir) {
        const rel = path.relative(root, normalized).toLowerCase();
        if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) {
          throw new Error(`禁止操作 .git 目录: ${relativeOrAbsolutePath}`);
        }
      }

      return normalized;
    }
    if (escapeErr !== null) throw escapeErr;
    throw new Error(`路径越界: ${relativeOrAbsolutePath} 不在 workspace 内`);
  }
```

（其余方法不动。注意：原实现的 `const realRoot = fs.realpathSync(this.rootDir)` 顶部单点计算移入逐根分支。）

- [ ] **Step 4: 跑测试确认通过（含 win32 变体防回归）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/`
Expected: PASS——win32 变体（如存在）走 mock path 分支，多根循环不改变其判定输入

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/files/workspace-fs.ts electron/tests/files/workspace-fs.test.ts
git commit -m "feat(files): WorkspaceFS extraRootDirs 写授权扩展根——多根三查泛化 + 文案锁（spec hard-gate §6）"
```

---

### Task 7: runWithWriteGrant 工具包装（spec §7）

**Files:**
- Create: `electron/src/main/agent/tools/write-grant-tool.ts`
- Test: 新建 `electron/tests/agent/tools/write-grant-tool.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `waitForWriteGrant` / `formatWriteDeniedResult`；Task 6 的 `setExtraRootDirs`；既有 `normalizeGrantDirs` / `requestEffectiveNetwork` / `ToolContext`
- Produces（Task 8 消费）:
  - `runWithWriteGrant<T>(ctx: ToolContext, toolName: string, pathArg: string, op: () => Promise<T>): Promise<T | string>`
  - `extractOutOfWsPath(errorMessage: string): string | null`
  - `__setWriteGrantToolForTest(o: { wait?: WaitFn; net?: NetQueryFn } | null): void`

- [ ] **Step 1: 写失败测试**（新建 `electron/tests/agent/tools/write-grant-tool.test.ts`）

```typescript
// electron/tests/agent/tools/write-grant-tool.test.ts
// 文件写工具的写授权硬门控包装（spec hard-gate §7）：越界捕获 → 上报 → 等待三态 →
// covered 刷新 extra 根重执行。等待/桥均注入替身（非 fork 环境桥不可达——IPC 边界替身）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  runWithWriteGrant,
  extractOutOfWsPath,
  __setWriteGrantToolForTest,
} from '../../../src/main/agent/tools/write-grant-tool';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const capturedSends: Array<Record<string, unknown>> = [];
const realSend = process.send;

beforeEach(() => {
  capturedSends.length = 0;
  Object.defineProperty(process, 'send', {
    value: (msg: unknown): boolean => {
      capturedSends.push(msg as Record<string, unknown>);
      return true;
    },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __setWriteGrantToolForTest(null);
});

/** 最小 ctx（helper 仅触达 streamSessionId/workspaceId/wsFs/abortSignal 四字段） */
function mkCtx(wsFs?: { setExtraRootDirs: (d: string[]) => void }): ToolContext {
  return {
    streamSessionId: 'ss-tool',
    workspaceId: 'ws-tool',
    wsFs: wsFs ?? { setExtraRootDirs: vi.fn() },
  } as unknown as ToolContext;
}

const OUTSIDE = path.join('/', 'tmp', 'outside-dir', 'My File.txt'); // 带空格路径

function throwOutOfWs(): never {
  throw new Error(`路径越界: ${OUTSIDE} 不在 workspace 内`);
}

describe('extractOutOfWsPath（§7 regex 契约）', () => {
  it('越界文案提取完整路径（含空格不截断）', () => {
    expect(extractOutOfWsPath(`路径越界: ${OUTSIDE} 不在 workspace 内`)).toBe(OUTSIDE);
  });
  it('符号链接逃逸文案提取', () => {
    expect(extractOutOfWsPath(`符号链接逃逸: ${OUTSIDE}`)).toBe(OUTSIDE);
  });
  it('非越界错误 → null', () => {
    expect(extractOutOfWsPath('文件不存在: /x')).toBeNull();
    expect(extractOutOfWsPath('未知工具: foo')).toBeNull();
  });
});

describe('runWithWriteGrant（spec §7）', () => {
  it('op 成功 → 原样返回（零上报零等待）', async () => {
    const r = await runWithWriteGrant(mkCtx(), 'write_file', '/in/ws', async () => '文件已写入');
    expect(r).toBe('文件已写入');
    expect(capturedSends).toHaveLength(0);
  });

  it('非越界错误原样上抛（不进等待）', async () => {
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', '/x', async () => {
        throw new Error('文件不存在: /x');
      }),
    ).rejects.toThrow('文件不存在');
    expect(capturedSends).toHaveLength(0);
  });

  it('越界 → 上报 write-blocked-report（command=工具+路径）→ denied → 统一拒绝文案', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    let calls = 0;
    const r = await runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => {
      calls += 1;
      throwOutOfWs();
    });
    expect(calls).toBe(1); // denied 不重执行
    // dirs 形态取决于 normalizeGrantDirs 对不存在路径的上溯产物（/tmp → realpath）——锁前缀不锁值
    expect(r).toMatch(/^用户已拒绝授权（目录：.+）。请勿重试同一目标；如确需写入请与用户协商其他方案。$/);
    const report = capturedSends.find((m) => m.type === 'write-blocked-report') as
      | { dirs?: string[]; command?: string; streamSessionId?: string; workspaceId?: string }
      | undefined;
    expect(report).toBeDefined();
    expect(report?.streamSessionId).toBe('ss-tool');
    expect(report?.workspaceId).toBe('ws-tool');
    expect(report?.command).toBe(`write_file ${OUTSIDE}`);
  });

  it('越界 → covered → setExtraRootDirs(三层合成) → 重执行成功', async () => {
    const setExtra = vi.fn();
    __setWriteGrantToolForTest({
      net: async () => ({ netOn: false, toolchainOn: false, extraDirs: ['/granted-root'] }),
      wait: async () => ({ kind: 'covered' as const }),
    });
    let calls = 0;
    const r = await runWithWriteGrant(mkCtx({ setExtraRootDirs: setExtra }), 'write_file', OUTSIDE, async () => {
      calls += 1;
      if (calls === 1) throwOutOfWs();
      return '文件已写入';
    });
    expect(r).toBe('文件已写入');
    expect(calls).toBe(2);
    expect(setExtra).toHaveBeenCalledWith(['/granted-root']);
  });

  it('aborted → 抛 AbortError（穿透明既约定）', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'aborted' as const }) });
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => { throwOutOfWs(); }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('covered 后重执行仍越界（授权与目标不匹配）→ 轮次收敛：3 次等待后原始错误上抛（不无限循环）', async () => {
    __setWriteGrantToolForTest({
      net: async () => ({ netOn: false, toolchainOn: false, extraDirs: [] }),
      wait: async () => ({ kind: 'covered' as const }),
    });
    let calls = 0;
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => {
        calls += 1;
        throwOutOfWs();
      }),
    ).rejects.toThrow('路径越界');
    expect(calls).toBe(4); // 3 轮等待 + 末轮重执行
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-tool.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现**（新建 `electron/src/main/agent/tools/write-grant-tool.ts`）

```typescript
// electron/src/main/agent/tools/write-grant-tool.ts
// 文件写工具的写授权硬门控包装（spec 2026-10-03 hard-gate §7）：WorkspaceFS
// 越界异常 → 上报弹卡（复用 write-blocked-report 通道）→ 无限等待三态出口 →
// covered 刷新 extra 根后重执行。bash 不走本 helper（shell-tools 自带轮次循环
// ——其检测在结果文本侧）。
import os from 'node:os';
import { normalizeGrantDirs } from './sandbox-write-hint';
import { requestEffectiveNetwork } from './net-trust-bridge';
import { waitForWriteGrant, formatWriteDeniedResult } from './write-grant-wait';
import type { ToolContext } from './types';

/** WorkspaceFS 越界异常文案（文案锁见 workspace-fs.test.ts——本 regex 是其消费契约；
 *  贪婪 .+ 以固定后缀「 不在 workspace 内」为锚——路径可含空格，\S+ 会截断） */
const OUT_OF_WS = /路径越界: (.+) 不在 workspace 内/;
const SYMLINK_ESCAPE = /符号链接逃逸: (.+)/;

/** 轮次上限（spec §7：与 bash WRITE_WAIT_MAX_ROUNDS 同值——mv 双路径/patch 多根收敛） */
const WRITE_TOOL_MAX_ROUNDS = 3;

type WaitFn = typeof waitForWriteGrant;
type NetQueryFn = typeof requestEffectiveNetwork;
let waitOverride: WaitFn | null = null;
let netOverride: NetQueryFn | null = null;
export function __setWriteGrantToolForTest(o: { wait?: WaitFn; net?: NetQueryFn } | null): void {
  waitOverride = o?.wait ?? null;
  netOverride = o?.net ?? null;
}

/** 从错误消息提取越界路径；非越界错误返回 null */
export function extractOutOfWsPath(errorMessage: string): string | null {
  const m = OUT_OF_WS.exec(errorMessage) ?? SYMLINK_ESCAPE.exec(errorMessage);
  return m?.[1] ?? null;
}

export async function runWithWriteGrant<T>(
  ctx: ToolContext,
  toolName: string,
  pathArg: string,
  op: () => Promise<T>,
): Promise<T | string> {
  const queryNet = netOverride ?? requestEffectiveNetwork;
  const doWait = waitOverride ?? waitForWriteGrant;
  for (let round = 0; round < WRITE_TOOL_MAX_ROUNDS; round += 1) {
    let rawPath: string | null = null;
    try {
      return await op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rawPath = extractOutOfWsPath(msg);
      if (rawPath === null) throw err; // 非越界错误不进门控
    }
    const dirs = normalizeGrantDirs([rawPath], os.homedir());
    process.send?.({
      type: 'write-blocked-report',
      streamSessionId: ctx.streamSessionId,
      workspaceId: ctx.workspaceId,
      dirs,
      command: `${toolName} ${pathArg}`.slice(0, 200),
    });
    const wait = await doWait({
      dirs,
      signal: ctx.abortSignal,
      isCovered: async () => {
        try {
          const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
          return dirs.some((d) => eff.extraDirs.includes(d));
        } catch {
          return false;
        }
      },
    });
    if (wait.kind === 'aborted') {
      const e = new Error(`${toolName} 被中断`);
      e.name = 'AbortError';
      throw e;
    }
    if (wait.kind === 'denied') return formatWriteDeniedResult(dirs);
    // covered：刷新 extra 根（三层合成）→ 循环头重执行
    try {
      const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
      ctx.wsFs.setExtraRootDirs(eff.extraDirs);
    } catch {
      // 刷新失败不阻断——下一轮越界会再走本 helper
    }
  }
  return await op(); // 末轮重执行：再越界则原始错误上抛（LLM 换方案或重发工具调用）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/write-grant-tool.ts electron/tests/agent/tools/write-grant-tool.test.ts
git commit -m "feat(sandbox): runWithWriteGrant 文件工具硬门控包装——越界弹卡/三态等待/covered 刷新重执行（spec hard-gate §7）"
```

---

### Task 8: file-tools / apply-patch 接线（spec §7）

**Files:**
- Modify: `electron/src/main/agent/tools/file-tools.ts`（write_file/edit_file/mkdir/rm/mv 五个 case 包装）
- Modify: `electron/src/main/agent/tools/apply-patch-tools.ts:53-57`（execute 包装）
- Test: 新建 `electron/tests/agent/tools/write-grant-file-tools.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `runWithWriteGrant`
- Produces: LLM 文件写工具的硬门控行为（终端交付物）

- [ ] **Step 1: 写失败测试**（新建 `electron/tests/agent/tools/write-grant-file-tools.test.ts`；自建最小 ctx + 真实 WorkspaceFS，不依赖既有 fixture 内部形态）

```typescript
// electron/tests/agent/tools/write-grant-file-tools.test.ts
// 文件写工具硬门控端到端（spec hard-gate §7）：真实 WorkspaceFS + 真实 FileTools /
// ApplyPatchTools，等待与桥注入替身。覆盖 write_file 越界→covered→落盘、denied、
// mv 源越界、apply_patch 越界、授权后 read_file 放行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTools } from '../../../src/main/agent/tools/file-tools';
import { ApplyPatchTools } from '../../../src/main/agent/tools/apply-patch-tools';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { formatWriteDeniedResult } from '../../../src/main/agent/tools/write-grant-wait';
import { __setWriteGrantToolForTest } from '../../../src/main/agent/tools/write-grant-tool';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const capturedSends: Array<Record<string, unknown>> = [];
const realSend = process.send;

let root: string;
let outside: string;
let wfs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wgf-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wgf-outside-'));
  wfs = new WorkspaceFS(root);
  ctx = {
    wsFs: wfs,
    workspaceId: 'ws-f',
    workspaceDir: root,
    streamSessionId: 'ss-f',
    roomId: 'room-f',
  } as unknown as ToolContext;
  capturedSends.length = 0;
  Object.defineProperty(process, 'send', {
    value: (msg: unknown): boolean => {
      capturedSends.push(msg as Record<string, unknown>);
      return true;
    },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __setWriteGrantToolForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** covered 替身：授权 = outside 根（三层合成的动态层等价物） */
function grantOutsideOnWait(): void {
  __setWriteGrantToolForTest({
    net: async () => ({ netOn: false, toolchainOn: false, extraDirs: [fs.realpathSync(outside)] }),
    wait: async () => ({ kind: 'covered' as const }),
  });
}

describe('write_file 硬门控（spec §7）', () => {
  it('越界 → 上报 → covered → extra 根生效 → 真实落盘成功', async () => {
    grantOutsideOnWait();
    const target = path.join(outside, 'out.txt');
    const r = await new FileTools().execute('write_file', { path: target, content: 'hi' }, ctx);
    expect(r).toBe(`文件已写入: ${target}`);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hi');
    expect(capturedSends.some((m) => m.type === 'write-blocked-report')).toBe(true);
  });

  it('越界 → denied → 拒绝文案返回 + 不落盘', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'denied.txt');
    const r = await new FileTools().execute('write_file', { path: target, content: 'x' }, ctx);
    expect(r).toBe(formatWriteDeniedResult([fs.realpathSync(outside)]));
    expect(fs.existsSync(target)).toBe(false);
  });

  it('授权后 read_file 放行（extra 根读开放——edit 链前提）', async () => {
    const src = path.join(outside, 'readable.txt');
    fs.writeFileSync(src, 'content-读取');
    grantOutsideOnWait();
    // 先经一次 write 触发 covered 刷新 extra 根
    await new FileTools().execute('write_file', { path: path.join(outside, 'trigger.txt'), content: 't' }, ctx);
    const r = await new FileTools().execute('read_file', { path: src }, ctx);
    expect(r).toContain('content-读取');
  });
});

describe('mkdir / mv / rm 硬门控', () => {
  it('mkdir 越界 denied → 拒绝文案 + 目录未建', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'newdir');
    const r = await new FileTools().execute('mkdir', { path: target }, ctx);
    expect(r).toContain('用户已拒绝授权');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('mv 源在工作空间外 → covered 后移动成功（src 越界捕获）', async () => {
    grantOutsideOnWait();
    const src = path.join(outside, 'mv-me.txt');
    fs.writeFileSync(src, 'payload');
    const dst = path.join(root, 'moved.txt');
    const r = await new FileTools().execute('mv', { src, dst }, ctx);
    expect(r).toBe(`已移动: ${src} → ${dst}`);
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });
});

describe('apply_patch 硬门控', () => {
  it('patch 目标越界 → covered → 原子补丁落盘', async () => {
    grantOutsideOnWait();
    const target = path.join(outside, 'patched.txt');
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+line1\n+line2\n*** End Patch\n`;
    const r = await new ApplyPatchTools().execute('apply_patch', { patch }, ctx);
    expect(r).toContain('已应用');
    expect(fs.readFileSync(target, 'utf-8')).toBe('line1\nline2\n');
  });

  it('patch 目标越界 → denied → 拒绝文案 + 未落盘', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'denied-patch.txt');
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch\n`;
    const r = await new ApplyPatchTools().execute('apply_patch', { patch }, ctx);
    expect(r).toContain('用户已拒绝授权');
    expect(fs.existsSync(target)).toBe(false);
  });
});
```

（若 `已应用` 成功文案与实际不符，以 `apply-patch-tools.ts` 实际返回串为准修正断言——执行时先读该文件 executePatch 尾部。）

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-file-tools.test.ts`
Expected: FAIL——write_file 直接抛「路径越界」（未包装）

- [ ] **Step 3: 实现接线**

`file-tools.ts` import 区补 `import { runWithWriteGrant } from './write-grant-tool';`，五个 case 包装（read_file / list_files / exists 不动）——以 write_file 为例，其余同构（case 体原样内移，返回串保持不变）：

```typescript
    case 'write_file': {
      const filePath = parseStringArg(args.path, 'path');
      const content = parseStringArg(args.content, 'content');
      return runWithWriteGrant(ctx, 'write_file', filePath, async () => {
        const abs = wsFs.assertInWorkspace(filePath);
        // ……原 case 体自 const abs 起逐行搬入（existed 守门 / 记账 / 写盘 / 标记已读）……
        return `文件已写入: ${filePath}`;
      });
    }
```

- `edit_file`：同构包装（pathArg = filePath，原体含 assertRead/readTracker/记账全内移）
- `mkdir`：pathArg = dirPath
- `rm`：pathArg = targetPath（记账在原体内——越界时不该记账，包装天然保证：越界抛在 assertInWorkspace，先于 recordDeleteTreeSafe）
- `mv`：pathArg = `` `${src} → ${dst}` ``（原体两个 assertInWorkspace 任一越界均被捕获；src/dst 双越界场景由轮次上限逐根收敛——spec §7）
- 注意各 case 原体的局部变量（`const wsFs = ctx.wsFs` 在 switch 外，闭包可及）

`apply-patch-tools.ts` import 区补 `import { runWithWriteGrant } from './write-grant-tool';` 与 `parsePatch`（既有 import 已有——确认补 `op.path` 用法无需新 import）；execute 改为：

```typescript
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name !== 'apply_patch') throw new Error(`未知 apply_patch 工具: ${name}`);
    const patchText = typeof args.patch === 'string' ? args.patch : '';
    // 首个 op 路径作上报预览（解析失败留空——非法 patch 由 executePatch 原样抛）
    let firstPath = '';
    try {
      firstPath = parsePatch(patchText).ops[0]?.path ?? '';
    } catch {
      /* 非法 patch：不进门控，直接走原执行路径抛解析错误 */
    }
    return runWithWriteGrant(ctx, 'apply_patch', firstPath, () => executePatch(patchText, ctx));
  }
```

（注意 execute 内 return 的函数返回 `Promise<string>`——`runWithWriteGrant<string>` 泛型自动推断，返回类型 `string`。若 TS 报联合类型不匹配（`string | string` 恒为 string），无需断言。）

- [ ] **Step 4: 跑测试确认通过（含既有文件工具回归）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/write-grant-file-tools.test.ts tests/agent/tools/file-tools.test.ts tests/agent/tools/file-tools-read-gate.test.ts tests/agent/tools/apply-patch-tools.test.ts`
Expected: PASS——既有用例全部不受影响（工作空间内路径零门控开销：op 成功即返回）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/file-tools.ts electron/src/main/agent/tools/apply-patch-tools.ts electron/tests/agent/tools/write-grant-file-tools.test.ts
git commit -m "feat(sandbox): 文件写工具接入硬门控——write_file/edit_file/mkdir/rm/mv/apply_patch 越界弹卡等待（spec hard-gate §7）"
```

---

### Task 9: renderer 卡接线 + 全量验证（spec §8）

**Files:**
- Modify: `renderer/src/components/settings/SandboxNotice.tsx:98-118,156-168,210-213`
- Test: `renderer/src/components/settings/SandboxNotice.test.tsx`（追加用例 + mock 补 denyWrite）

**Interfaces:**
- Consumes: Task 5 的 `ipc.sandbox.denyWrite`
- Produces: 拒绝按钮 / X 关闭 → 广播解除等待（终端交付物）

- [ ] **Step 1: 写失败测试**（`SandboxNotice.test.tsx`——ipc mock 对象补 `denyWrite: denyWriteMock`（照 line 26 `grantWriteMock` 形态）；事件种子照既有 writeBlocked 用例的播种方式（参考 562 行用例的渲染前置），追加三个用例）

```typescript
  it('拒绝 → denyWrite 广播（sessionId+dirs）+ 卡消失', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    // ……照 562 行用例渲染 writeBlocked 卡（dirs=['/Users/x/.cargo'], sessionId='s-1'）……
    await userEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: ['/Users/x/.cargo'] });
    // 卡消失：断言卡不再可见（照既有用例的消失断言形态）
  });

  it('X 关闭（writeBlocked 卡）→ 同 denyWrite（关闭即拒绝语义）', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    // ……同上渲染……
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: ['/Users/x/.cargo'] });
  });

  it('空 dirs 降级卡关闭 → denyWrite { sessionId, dirs: [] }（空对空匹配链路）', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    // ……渲染 dirs=[] 的 writeBlocked 卡……
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: [] });
  });
```

（渲染前置/断言细节以该测试文件既有 writeBlocked 用例的 fixture 为准补全——`beforeEach` 重置 `denyWriteMock`，照 106 行 `grantWriteMock.mockReset()` 先例。）

- [ ] **Step 2: 确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/SandboxNotice.test.tsx`
Expected: FAIL——`denyWrite` 未被调用（组件只调本地 denyPending）

- [ ] **Step 3: 实现**（`SandboxNotice.tsx`）

`grantNow` 定义后追加：

```typescript
  // 拒绝即时解除（spec hard-gate §8）：本地记忆（同 dirs 不再弹）+ IPC 广播解除
  // 子进程等待。fire-and-forget：广播失败只影响等待解除时延（下轮 abort 仍可终止）
  const denyNow = (): void => {
    if (!writePending) return;
    void ipc.sandbox
      .denyWrite({ sessionId: writePending.sessionId, dirs: writePending.dirs })
      .catch(() => {});
    denyPending();
  };
```

X 关闭分支（163 行）`else denyPending();` → `else denyNow();`；拒绝按钮（211 行）`onClick={() => denyPending()}` → `onClick={() => denyNow()}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/SandboxNotice.test.tsx`
Expected: PASS（含既有 562/573 行授权用例——grantNow 路径未动）

- [ ] **Step 5: 全量验证**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test
```
Expected: 双 workspace typecheck 绿 + 全部单测绿。失败则修复与本变更相关的破坏（既有无关失败单独列出不扩scope）。

- [ ] **Step 6: spec 状态收尾 + Commit**

`docs/specs/2026-10-03-write-grant-hard-gate-design.md` 状态行改为：`状态：已实施（docs/plans/2026-10-03-write-grant-hard-gate.md 9 任务执行完毕）`

```bash
git add renderer/src/components/settings/SandboxNotice.tsx renderer/src/components/settings/SandboxNotice.test.tsx docs/specs/2026-10-03-write-grant-hard-gate-design.md
git commit -m "feat(renderer): 授权卡拒绝/X 关闭接 denyWrite 广播——等待即时解除（spec hard-gate §8）"
```

---

## 验收清单（人工 GUI 复核，实施完成后）

1. strict + `sandboxToolchainPolicy=allow` 设置下，让 agent `bash` 写非预置目录 → 卡弹出、bash 卡片持续「执行中」（不再秒过）
2. 点「本会话允许」→ ≤2s 内同一命令自动重执行成功
3. 点「拒绝」→ bash 卡片立刻出结果，内容为统一拒绝文案
4. 让 agent `write_file` 工作空间外路径 → 同款卡 + 等待 + 授权后落盘
5. 等待期间点停止按钮 → 回合终止（abort 逃生口）
