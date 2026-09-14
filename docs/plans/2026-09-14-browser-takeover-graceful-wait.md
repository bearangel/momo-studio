# 浏览器接管优雅等待实施计划（驻留等待 + 空闲自愈 + 释放提示卡）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 的 browser_* 工具在用户接管时驻留等待（可释放/空闲自愈/超时兜底）而非立即失败放弃任务，配一张「释放并继续」提示卡。

**Architecture:** 全部落主进程 `BrowserManager`（gateAgentSide 单飞等待 + 1s tick + lastUserInputAt 空闲判定），对子进程 IPC 桥透明；renderer 克隆信任卡形态做提示卡。设计依据：`docs/specs/2026-09-14-browser-takeover-graceful-wait-design.md`。

**Tech Stack:** Electron 主进程 TS（CommonJS）、React/TS renderer、vitest（fake timers）。

## Global Constraints

- **Node 20**：所有测试命令前 `nvm use 20`（workdir `electron/` 或 `renderer/`）。
- **中文注释**；TypeScript strict，禁 `any` / `as any` / `@ts-ignore`。
- **UI 设计系统（v2.1）**：renderer 新代码只用语义 token + lucide-react（16px/stroke 1.75）+ `components/ui/` 原子组件。
- **Conventional Commits**；不动版本号；单测位置：electron 集中 `electron/tests/`（browser 域在 `tests/browser/`），renderer 贴源 colocated。
- **契约（boundary-rules）**：`browser:notice` 新 kind `'agent-waiting-release'` + 可选 `durationMs` 字段 + hooks 签名扩展，主进程生产者（Task 1）与 renderer 消费者（Task 3）成对交付。
- 测试保真度：manager 测试用结构性 mock view（对齐 `tests/browser/manager.test.ts` 既有 fixture 模式）+ `vi.useFakeTimers` 控制 tick/超时。

---

### Task 1: BrowserManager 驻留等待 + 空闲自愈（核心）

**Files:**
- Modify: `electron/src/main/browser/manager.ts`（gateAgentSide / waiters / lastUserInputAt / 清理 / hooks 扩展）
- Modify: `electron/src/main/browser/errors.ts`（BrowserTakenOverError 支持自定义 message）
- Modify: `electron/src/main/browser/ipc.ts:175-180`（createBrowserPushHooks 透传 durationMs）
- Test: `electron/tests/browser/manager-agent-wait.test.ts`（新建；fixture 模式照抄 `tests/browser/manager.test.ts` 的 mock factory 结构）

**Interfaces:**
- Produces（Task 2/3 消费）:
  - `BrowserManagerOpts.readAgentWaitMs?: (wsId: string) => number`（缺省恒 60000）
  - `BrowserManagerOpts.readIdleAutoReleaseMs?: (wsId: string) => number`（缺省恒 90000）
  - `BrowserManagerHooks.pushNotice(kind, text, workspaceId, durationMs?)`（第 4 参可选，加法）
  - notice kind `'agent-waiting-release'`

- [ ] **Step 1: 写失败测试（新建文件，完整代码）**

```ts
// electron/tests/browser/manager-agent-wait.test.ts
//
// 接管驻留等待回归矩阵（spec 2026-09-14-browser-takeover §6 用例 1-8）。
// fixture：结构性 mock factory（对齐 manager.test.ts 模式）+ fake timers 控 tick/超时。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import { BrowserTakenOverError } from '../../src/main/browser/errors';

// === 结构性 mock（形状照抄 manager.test.ts 的 factory/view fixture）===

function makeView(url = 'https://example.com'): ManagedView {
  const wc = {
    loadURL: vi.fn(async () => {}),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => url,
    getTitle: () => 'Example',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  return { webContents: wc, bounds: { setBounds: vi.fn() } } as unknown as ManagedView;
}

function makeManager(opts?: { waitMs?: number; idleMs?: number }) {
  const factory: ViewFactory = { create: () => makeView(), destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Array<{ takeover: string }> = [];
  const notices: Array<{ kind: string; durationMs?: number }> = [];
  const manager = new BrowserManager(
    factory,
    // policy 结构性子集：assertUrl 直通（本测试不测策略）
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    {
      pushState: (s) => states.push({ takeover: s.takeover }),
      pushNotice: (kind, _text, _wsId, durationMs) => notices.push({ kind, durationMs }),
    },
    {
      readAgentWaitMs: () => opts?.waitMs ?? 60_000,
      readIdleAutoReleaseMs: () => opts?.idleMs ?? 90_000,
    },
  );
  return { manager, states, notices };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('gateAgentSide 驻留等待（spec §6）', () => {
  it('用例1：user 态 navigate 不立即抛，释放后放行并完成导航', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    // 微任务排空后仍 pending（不立即 reject）
    await vi.advanceTimersByTimeAsync(0);
    manager.releaseTakeover('w1');
    const r = await p;
    expect(r.url).toBe('https://example.com');
  });

  it('用例2：超时抛 BrowserTakenOverError，文案含等待秒数与 webfetch 指引', async () => {
    const { manager } = makeManager({ waitMs: 5_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await expect(p).rejects.toBeInstanceOf(BrowserTakenOverError);
    await expect(p).rejects.toThrow(/已等待 5 秒/);
    await expect(p).rejects.toThrow(/webfetch/);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('用例3：并发 join 单飞——两个调用只推一次 notice，释放后都放行', async () => {
    const { manager, notices } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p1 = manager.navigate('w1', 'https://example.com');
    const p2 = manager.snapshot('w1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices.filter((n) => n.kind === 'agent-waiting-release')).toHaveLength(1);
    manager.releaseTakeover('w1');
    await Promise.all([p1, p2]);
  });

  it('用例2b：notice 载荷携带 durationMs（= 实际生效等待时长）', async () => {
    const { manager, notices } = makeManager({ waitMs: 5_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    expect(notices[0]).toMatchObject({ kind: 'agent-waiting-release', durationMs: 5_000 });
    manager.releaseTakeover('w1');
    await p;
  });

  it('用例4：释放后被再接管——循环复查继续等（deadline 内不误放行）', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    manager.releaseTakeover('w1');
    manager.userTakeover('w1'); // 释放瞬间再接管（同步竞态仿真）
    await vi.advanceTimersByTimeAsync(1_000);
    // 仍 user 态：p 不得 resolve（挂起断言——用竞态标志）
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    manager.releaseTakeover('w1');
    await p;
  });

  it('用例5a：空闲自愈——lastUserInputAt 过期 → 自动回切并放行', async () => {
    const { manager, states } = makeManager({ idleMs: 10_000, waitMs: 120_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1'); // lastUserInputAt ≈ now
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(10_000); // 空闲到期
    const r = await p;
    expect(r.url).toBe('https://example.com');
    expect(states[states.length - 1]!.takeover).toBe('agent'); // 状态已回切
  });

  it('用例5b：等待中用户持续输入刷新计时 → 不自愈，走向超时', async () => {
    const { manager } = makeManager({ idleMs: 10_000, waitMs: 30_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    // 每 8s 模拟一次用户输入（before-input-event 路径经 userTakeover 幂等 + 刷新时刻）
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
      manager.userTakeover('w1');
    }
    await vi.advanceTimersByTimeAsync(30_000); // 总超时
    await expect(p).rejects.toBeInstanceOf(BrowserTakenOverError);
  });

  it('用例6：不打扰原则——无 waiter 挂起时输入过期绝不自动回切', () => {
    const { manager, states } = makeManager({ idleMs: 10_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    vi.advanceTimersByTime(60_000);
    expect(states[states.length - 1]!.takeover).toBe('user'); // 保持 user
  });

  it('用例7：清理——park 中 closeBrowser 后 waiter 不悬挂（settle，后续门控自然接管）', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    await manager.closeBrowser('w1', 'user'); // 用户路径关浏览器（agent 路径会先过 gate）
    // close 后 takeover 复位 agent → park resolve → navigate 走空视图重建路径正常完成
    const r = await p;
    expect(r.url).toBe('https://example.com');
  });

  it('用例8：快路径零回归——agent 态调用零延迟且不推 notice', async () => {
    const { manager, notices } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    const r = await manager.navigate('w1', 'https://example.com');
    expect(r.url).toBe('https://example.com');
    expect(notices).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/browser/manager-agent-wait.test.ts`
Expected: FAIL——`readAgentWaitMs` 不在 `BrowserManagerOpts`（TS 报错）或 user 态 navigate 立即 reject。

- [ ] **Step 3: 实现**

① `errors.ts`——`BrowserTakenOverError` 构造加可选 message（缺省保留旧文案，既有测试零影响）：

```ts
/** 用户接管中：browser_* 工具驻留等待（可配），超时/等待关闭时抛出 */
export class BrowserTakenOverError extends BrowserError {
  constructor(message?: string) {
    super('taken_over', message ?? '浏览器被用户接管，等待释放后重试');
  }
}
```

② `manager.ts` 常量区追加：

```ts
/** agent 驻留等待缺省时长（spec §4.1；readAgentWaitMs 注入覆盖，0=立即失败） */
const DEFAULT_AGENT_WAIT_MS = 60_000;
/** 空闲自动回切缺省阈值（spec §4.2；readIdleAutoReleaseMs 注入覆盖，0=关闭） */
const DEFAULT_IDLE_AUTO_RELEASE_MS = 90_000;
/** 驻留等待 tick 间隔（释放检测 + 空闲判定 + 超时判定共用） */
const AGENT_WAIT_TICK_MS = 1_000;
```

③ `BrowserManagerOpts` 追加两个注入（注释说明每 tick 重读、设置即时生效）；`BrowserManagerHooks.pushNotice` 追加第 4 参 `durationMs?: number`（注释：agent-waiting-release 卡片本地计时用）。

④ `ActiveWorkspace` 追加 `lastUserInputAt: number`；`onWorkspaceActivated` 初始化为 `Date.now()`；`userTakeover` 成功翻转前刷新 `ws.lastUserInputAt = Date.now()`（覆盖三入口 + overlay mousedown——全部经 userTakeover 收敛）；`before-input-event` 监听器**入口处**（agentInputDepth 判空后）无条件刷新 `ws.lastUserInputAt`（user 态持续输入刷新空闲计时——判定自愈用）。

⑤ 类内追加 waiter 基础设施与 gate：

```ts
/** agent 驻留等待条目（单飞：同 ws 并发工具 join 同一 promise，只推一次 notice） */
interface AgentWaitEntry {
  promise: Promise<void>;
  startedAt: number;
  timer: NodeJS.Timeout;
}

// BrowserManager 内：
private readonly agentWaiters = new Map<string, AgentWaitEntry>();

/** agent 门（带驻留等待）：user 态 park 至释放/空闲自愈；超时抛 BrowserTakenOverError。
 * 释放后被再接管 → while 复查重新 park（每次 park 独立 deadline，spec §4.1 竞态语义）。 */
private async gateAgentSide(ws: ActiveWorkspace): Promise<void> {
  while (ws.takeover === 'user') {
    const waitMs = this.readAgentWaitMs?.(ws.workspaceId) ?? DEFAULT_AGENT_WAIT_MS;
    if (waitMs <= 0) {
      throw new BrowserTakenOverError(
        '浏览器被用户接管（等待已关闭）。可请用户点击浏览器侧栏的「释放」按钮，或改用 webfetch 等非浏览器方式继续当前任务',
      );
    }
    await this.parkAgentSide(ws, waitMs);
  }
}

/** 单飞驻留：entry 存在则 join；创建时推 notice（trust 先例：notice 前置，推送抛错同步清理） */
private parkAgentSide(ws: ActiveWorkspace, waitMs: number): Promise<void> {
  const existing = this.agentWaiters.get(ws.workspaceId);
  if (existing) return existing.promise;
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  const entry: AgentWaitEntry = {
    promise,
    startedAt: Date.now(),
    timer: setInterval(() => this.agentWaitTick(ws.workspaceId), AGENT_WAIT_TICK_MS),
  };
  entry.timer.unref?.();
  this.agentWaiters.set(ws.workspaceId, entry);
  try {
    this.hooks.pushNotice(
      'agent-waiting-release',
      'agent 正在等待浏览器控制权——点击「释放并继续」恢复任务，或稍候自动恢复',
      ws.workspaceId,
      waitMs,
    );
  } catch (err) {
    this.agentWaiters.delete(ws.workspaceId);
    clearInterval(entry.timer);
    throw err;
  }
  return promise
    .catch((err: Error) => { throw err; })
    .finally(() => { /* settle 统一在 settleAgentWait 清 entry/timer */ });
  void reject; // reject 仅由 settleAgentWait 超时路径持有
}

/** tick：释放复查（双保险）/ 空闲自愈 / 超时（spec §4.1 三出口） */
private agentWaitTick(wsId: string): void {
  const ws = this.active;
  const entry = this.agentWaiters.get(wsId);
  if (!ws || ws.workspaceId !== wsId || !entry) return;
  if (ws.takeover !== 'user') { this.settleAgentWait(wsId, true); return; }
  const idleMs = this.readIdleAutoReleaseMs?.(wsId) ?? DEFAULT_IDLE_AUTO_RELEASE_MS;
  if (idleMs > 0 && Date.now() - ws.lastUserInputAt >= idleMs) {
    this.releaseTakeover(wsId); // 单一出口：翻转 + emitState + settle
    return;
  }
  const waitMs = this.readAgentWaitMs?.(wsId) ?? DEFAULT_AGENT_WAIT_MS;
  if (Date.now() - entry.startedAt >= waitMs) this.settleAgentWait(wsId, false, waitMs);
}

/** settle：resolve（释放/清理）或 reject 超时（文案诚实化，spec §4.5） */
private settleAgentWait(wsId: string, ok: boolean, waitedMs?: number): void {
  const entry = this.agentWaiters.get(wsId);
  if (!entry) return;
  this.agentWaiters.delete(wsId);
  clearInterval(entry.timer);
  if (ok) entry.promiseResolve();
  else entry.promiseReject(new BrowserTakenOverError(
    `浏览器被用户接管，已等待 ${Math.round((waitedMs ?? 0) / 1000)} 秒未释放。用户可点击浏览器侧栏/提示卡上的「释放」按钮；也可以改用 webfetch 等非浏览器方式继续当前任务，稍后再回到浏览器操作`,
  ));
}
```

> 实现注意：为让 settle 持有 resolve/reject，`AgentWaitEntry` 实际字段为 `promiseResolve: () => void; promiseReject: (err: Error) => void;`（parkAgentSide 闭包内赋值），`promise` 由调用方 await。上面代码块按此整理，勿留 `void reject` 类脚手架。

⑥ 接线改造：
- `assertAgentSide` 的**全部 agent 调用点**改为 `await this.gateAgentSide(ws)`：`navigate`、`tabsAction`（source==='agent' 分支）、`closeBrowser`（同）、`evaluate`、`requireCurrentTab`（动作原语族入口）。`assertAgentSide` 本体保留（纯判定，getState 等只读路径不等待）。
- `releaseTakeover` 成功翻转后调用 `this.settleAgentWait(wsId, true)`。
- `closeBrowser` / `onWorkspaceDeactivated` / `disposeAll` 中调用 `this.settleAgentWait(wsId, true)`（resolve 不悬挂——后续门控按新仲裁态自然接管）。
- `ipc.ts` `createBrowserPushHooks`：`pushNotice: (kind, text, workspaceId, durationMs) => webContentsLike.send('browser:notice', { kind, text, workspaceId, ...(durationMs !== undefined ? { durationMs } : {}) })`。

⑦ 构造器接注入：`this.readAgentWaitMs = opts?.readAgentWaitMs; this.readIdleAutoReleaseMs = opts?.readIdleAutoReleaseMs;`（readonly 可选字段，模式同 readSidebarCollapsed）。

- [ ] **Step 4: 跑测试确认通过 + 既有 manager/policy 套件零回归**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/browser/manager-agent-wait.test.ts tests/browser/manager.test.ts tests/browser/policy.test.ts tests/browser/ipc.test.ts tests/browser/trust-gate-integration.test.ts`
Expected: PASS（既有用例若因 assertAgentSide→gate 改造受影响，逐个核对：同步路径语义不变——gate 在 agent 态是同步 resolve 的等价路径，无需改动断言）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/browser/manager.ts electron/src/main/browser/errors.ts electron/src/main/browser/ipc.ts electron/tests/browser/manager-agent-wait.test.ts
git commit -m "feat: browser_* 工具接管驻留等待与空闲自愈（gateAgentSide 单飞 + 诚实超时文案）"
```

---

### Task 2: settings-store 新键 + boot 接线

**Files:**
- Modify: `electron/src/main/browser/settings-store.ts`（两键默认值；结构照既有 `sidebarCollapsed` 键模板）
- Modify: `electron/src/main/browser/boot.ts:104-107`（manager opts 注入 readers）
- Test: `electron/tests/browser/settings-store.test.ts`（追加用例）+ `electron/tests/browser/boot-wiring.test.ts`（如该文件锁 opts 注入形状则同步）

**Interfaces:**
- Consumes: Task 1 的 `readAgentWaitMs` / `readIdleAutoReleaseMs`
- Produces: settings 键 `agentWaitMs`（默认 60000，0=立即失败）、`idleAutoReleaseMs`（默认 90000，0=关闭自愈）

- [ ] **Step 1: 失败测试（settings-store.test.ts 追加）**

```ts
it('agentWaitMs / idleAutoReleaseMs 默认值与覆盖（接管驻留等待 §4.4）', () => {
  const s = makeStore(tmpDir); // 既有 fixture helper，按本文件实际形态调用
  expect(s.read('w1').agentWaitMs).toBe(60_000);
  expect(s.read('w1').idleAutoReleaseMs).toBe(90_000);
  s.write('w1', { agentWaitMs: 5_000, idleAutoReleaseMs: 0 });
  expect(s.read('w1').agentWaitMs).toBe(5_000);
  expect(s.read('w1').idleAutoReleaseMs).toBe(0);
});
```

（fixture/helper 名以该文件既有用例为准——照抄相邻用例的 store 构造方式。）

- [ ] **Step 2: 红 → 实现 → 绿**

settings-store：类型与 DEFAULTS 增补两键（int、可选覆盖；写路径合入既有 write 白名单）。boot.ts：

```ts
const manager = new BrowserManager(factory, policy, hooks, {
  screenshotDir: ...,
  readSidebarCollapsed: (wsId) => store.read(wsId).sidebarCollapsed,
  // 接管驻留等待（spec 2026-09-14 §4.4）：每 tick 重读——设置即时生效
  readAgentWaitMs: (wsId) => store.read(wsId).agentWaitMs,
  readIdleAutoReleaseMs: (wsId) => store.read(wsId).idleAutoReleaseMs,
});
```

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/browser/settings-store.test.ts tests/browser/boot-wiring.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add electron/src/main/browser/settings-store.ts electron/src/main/browser/boot.ts electron/tests/browser/settings-store.test.ts
git commit -m "feat: 接管驻留等待设置键 agentWaitMs/idleAutoReleaseMs 并接线 boot"
```

---

### Task 3: renderer 释放提示卡（visual-engineering 域）

**Files:**
- Modify: `renderer/src/ipc/types.d.ts:1127-1131`（`BrowserNotice` 追加 `durationMs?: number`）
- Create: `renderer/src/components/workspace/BrowserWaitReleaseNotice.tsx`
- Modify: `renderer/src/App.tsx`（挂载，紧邻 `<BrowserTrustNotice />`）
- Test: `renderer/src/components/workspace/BrowserWaitReleaseNotice.test.tsx`（colocated，模式照抄 `BrowserTrustNotice.test.tsx`）

**Interfaces:**
- Consumes: Task 1 的 notice kind `'agent-waiting-release'` + 可选 `durationMs`；既有 `ipc.browser.onBrowserNotice` / `onBrowserState` / `releaseTakeover`
- 执行注记：本任务派发时用 visual-engineering 类别并加载 frontend skill。

- [ ] **Step 1: 类型扩展（先行，两端契约）**

```ts
export interface BrowserNotice {
  kind: string;
  text: string;
  workspaceId: string;
  /** agent-waiting-release 专用：本轮驻留等待实际时长 ms——卡片本地兜底计时用（超时出口 takeover 不翻转，state 不会触发卸载） */
  durationMs?: number;
}
```

- [ ] **Step 2: 失败测试（照抄 BrowserTrustNotice.test.tsx 的 mock 骨架）**

用例矩阵：
1. 非 `agent-waiting-release` kind 不挂载；
2. 收到 notice 挂载，标题「agent 正在等待浏览器」、按钮「释放并继续」；
3. `onBrowserState` 推送 `takeover: 'agent'` → 卸载；
4. `durationMs` 到期（fake timers）→ 卸载（超时兜底）；
5. state 推送 `workspaceId` 与卡片目标不符 → 不卸载（ws 切换保护的反向：仅目标 ws 回切才卸载）；
6. 点击「释放并继续」→ `ipc.browser.releaseTakeover(targetWsId)` 调用。

- [ ] **Step 3: 实现组件（完整代码）**

```tsx
// renderer/src/components/workspace/BrowserWaitReleaseNotice.tsx
//
// 接管释放提示卡（spec 2026-09-14 §4.3）：agent 的 browser_* 工具驻留等待时，
// 主进程推 kind='agent-waiting-release' notice。三个卸载出口：
//   1. browser:state takeover='agent'（手动释放 / 空闲自愈——目标 ws 匹配才卸载）
//   2. 本地 durationMs 兜底计时（超时出口——takeover 不翻转，state 不触发）
//   3. 收到新的 agent-waiting-release notice 刷新计时（单飞下不应出现，防御）
// 动作：单一按钮走既有 releaseTakeover 通道（零新 IPC）。
// 挂载点 App 层（与 BrowserTrustNotice 一致）；路由用 notice.workspaceId（M7 语义）。
import { useEffect, useRef, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserNotice } from '../../ipc/types';
import { Button } from '../ui/Button';

export function BrowserWaitReleaseNotice() {
  const [notice, setNotice] = useState<BrowserNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const offNotice = ipc.browser.onBrowserNotice((n) => {
      if (n.kind === 'agent-waiting-release') setNotice(n);
    });
    const offState = ipc.browser.onBrowserState((s) => {
      // 仅目标 ws 回切才卸载（用户切走查看其他 ws 不误删卡片）
      if (notice && s.workspaceId === notice.workspaceId && s.takeover === 'agent') {
        setNotice(null);
      }
    });
    return () => { offNotice(); offState(); };
  }, [notice]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (notice?.durationMs && notice.durationMs > 0) {
      timerRef.current = setTimeout(() => setNotice(null), notice.durationMs + 2_000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [notice]);

  if (!notice) return null;

  const release = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc.browser.releaseTakeover(notice.workspaceId);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="browser-wait-release-notice"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start gap-2 mb-2">
        <MousePointerClick size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">agent 正在等待浏览器</h2>
          <p className="text-xs text-tertiary mt-0.5">{notice.text}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => void release()}>释放并继续</Button>
      </div>
    </div>
  );
}
```

（+2s 宽限：释放请求在途/主进程 tick 分辨率；对齐 spec「兜底」语义。）

- [ ] **Step 4: App.tsx 挂载 + 跑测试**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run src/components/workspace/BrowserWaitReleaseNotice.test.tsx src/components/workspace/BrowserTrustNotice.test.tsx src/App.test.tsx`（workdir `renderer/`）
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/ipc/types.d.ts renderer/src/components/workspace/BrowserWaitReleaseNotice.tsx renderer/src/components/workspace/BrowserWaitReleaseNotice.test.tsx renderer/src/App.tsx
git commit -m "feat: 接管释放提示卡（agent-waiting-release 卡片 + durationMs 契约扩展）"
```

---

### Task 4: 工具层挂起锁 + 全量验证 + CHANGELOG

**Files:**
- Test: `electron/tests/agent/tools/browser-takenover-wait.test.ts`（新建）
- Modify: `CHANGELOG.md`（研发账本条目）

- [ ] **Step 1: 工具层挂起锁（spec §6-10 本质：port await 语义穿透）**

```ts
// 用 __resetBrowserToolsForTest + initBrowserTools 注入「user 态 manager mock」：
// navigate 返回一个由测试控制的 pending Promise（模拟 park），断言 execute 调用后
// 数微任务周期内未 reject（挂起而非立即失败）；resolve pending 后 execute 正常返回。
// 反向：注入 readAgentWaitMs=0 形态的立即失败 manager（抛 BrowserTakenOverError）
// → execute 原样穿透（错误文案含「等待已关闭」）。
```

（fixture 骨架照抄 `tests/agent/tools/` 既有 ToolModule 测试的 ctx 构造；具体以 `browser-tools` 既有测试文件形态为准。）

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/tools/browser-takenover-wait.test.ts tests/agent/runtime-browser-bridge-wiring.test.ts`
Expected: PASS（桥形态零回归）。

- [ ] **Step 2: 全量验证**

Run（仓库根）: `nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 0 error；双 workspace 全绿（pre-existing flaky 按 T6 先例记录上报不修）。

- [ ] **Step 3: CHANGELOG 研发账本（对齐既有独立条目格式）**

```markdown
### 浏览器接管优雅等待 `2026-09-14`
- feat: browser_* 工具用户接管时驻留等待（gateAgentSide 单飞，默认 60s 可配）+ 空闲自愈（90s 无输入自动回切，仅 agent 等待中判定）+「释放并继续」提示卡（notice kind agent-waiting-release / durationMs 契约加法）
- fix: 接管错误文案诚实化——超时出口携带等待秒数与 webfetch 改道指引（原「等待释放后重试」承诺了不存在的等待能力）
```

- [ ] **Step 4: Commit**

```bash
git add electron/tests/agent/tools/browser-takenover-wait.test.ts CHANGELOG.md
git commit -m "test+docs: 工具层接管挂起锁与 CHANGELOG 账本（浏览器接管优雅等待）"
```

---

## 计划自查记录

- **Spec 覆盖**：§4.1 驻留→Task1；§4.2 自愈→Task1（用例5/6）；§4.3 卡片→Task3；§4.4 设置→Task2；§4.5 文案→Task1；§5 契约→Task1+3 成对；§6 矩阵 1-8→Task1、9→Task3、10→Task4；M3 收尾→Task4。
- **占位符**：Task2 Step1 的 store fixture 与 Task4 Step1 的 ctx 骨架均指向仓库真实既有测试文件为模板（非计划内任务），其余代码完整。
- **类型一致性**：`readAgentWaitMs(wsId)=>number` / `readIdleAutoReleaseMs(wsId)=>number` / `pushNotice(kind,text,wsId,durationMs?)` / `BrowserNotice.durationMs?: number` / kind `'agent-waiting-release'`——Task1/2/3 交叉核对一致。Task1 代码块中 `AgentWaitEntry` 的 resolve/reject 持有方式已在实现注意中统一（`promiseResolve`/`promiseReject` 字段）。
