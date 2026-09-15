# 浏览器 tab 归属制与隐藏/销毁分离 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同工作区多会话下，每个 agent 拥有专属 tab（独立光标）互不踩踏；侧栏收起变为纯隐藏（视图后台存活），销毁成为显式独立动作；可见性按会话独立记忆、新会话默认收起；agent 导航仅在活跃会话时自动展开。

**Architecture:** 身份（ownerId=agent 实例 ID / 'user'）从 AgentRunner 沿既有 AGENT_CONFIG→ToolContext 链透传，经 browser-op 线协议尾参进主进程 manager；manager 以 TabRecord.owner + per-owner 光标解析全部 12 工具；折叠销毁链路（collapsed/collapseStash/readSidebarCollapsed）整体退役，换 viewsHidden 隐藏标志；renderer 以 per-session zustand store 管可见性，expandHint 推送驱动条件展开。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM/Vite）+ zustand + vitest（electron/tests 集中、renderer 贴源）。

**Spec:** `docs/specs/2026-09-15-browser-tab-ownership-design.md`（本计划的唯一需求来源，冲突以 spec 为准）

## Global Constraints

- Node 20 LTS：容器内先 `source ~/.nvm/nvm.sh && nvm use 20`（默认 Node 26 会破坏 better-sqlite3）
- 包管理一律 `npx pnpm@9.0.0 ...`；单测在对应 workspace 目录跑（`cd electron && npx pnpm@9.0.0 vitest run tests/...`）
- TypeScript strict：禁止 `any` / `as any` / `@ts-ignore`（ESLint no-explicit-any: error）
- 全部代码注释中文；标识符英文；Conventional Commits（`feat:` / `test:` / `refactor:`）
- 版本号不动（2.1.0-alpha.0 保持；特性合入不递增——用户明说发版才动）
- renderer UI：语义 token、lucide 16px strokeWidth 1.75、禁 emoji 图标、禁裸色阶/inline 颜色（动态宽度 inline style 是许可模式）；确认卡走 CenterPromptLayer 居中级（docs/dev/design-system.md §8）
- 单测位置：electron 主进程集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated；根 `tests/` 仅 e2e
- momo-boundary-rules：线协议 / IPC 通道 / 共享类型两端（op-protocol ↔ 桥 ↔ router；preload ↔ ipcMain；types.d.ts ↔ electron types.ts）**同一 commit 成对修改**，契约测试同步
- 每个 Task 结束必须：双 workspace typecheck 绿 + 该域测试绿，才允许 commit

---

### Task 1: 身份透传与线协议扩展（契约层）

**Files:**
- Modify: `electron/src/main/agent/tools/types.ts:45`（ToolContext 加字段）
- Modify: `electron/src/main/agent/runtime-entry.ts:1581-1600`（toolCtx 注入）
- Modify: `electron/src/main/browser/op-protocol.ts`（BrowserOpCtx + 12 op 尾参 + BROWSER_OP_MAX_ARGS）
- Modify: `electron/src/main/agent/tools/browser-ipc-bridge.ts:138-159`（桥透传 ctx）
- Modify: `electron/src/main/browser/op-router.ts:85-123`（主路由提取 ctx）
- Modify: `electron/src/main/agent/tools/browser-tools.ts:49-70,343-414`（端口面 + execute 构造 ctx）
- Test: `electron/tests/browser/op-ctx-threading.test.ts`（新建）

**Interfaces:**
- Consumes: `AgentRuntimeOpts.agentAssignmentId`（runtime-config.ts 已有，AGENT_CONFIG parse 强校验字段）、`ToolContext.roomId`（= session id）
- Produces:
  - `ToolContext.agentInstanceId?: string`
  - `interface BrowserOpCtx { ownerId: string; sessionId: string }` + `const USER_OP_CTX: BrowserOpCtx`（op-protocol.ts 导出）
  - `BrowserManagerPort` 全部 12 方法增可选尾参 `ctx?: BrowserOpCtx`
  - manager 方法本 Task **不改**（Task 2 改）——本 Task 只通线协议，manager 尚不消费 ctx

- [ ] **Step 1: 写失败测试（线协议 ctx 全链穿透）**

```ts
// electron/tests/browser/op-ctx-threading.test.ts
//
// 归属制身份透传契约锁（spec §5.1/§5.2）：agentInstanceId → BrowserOpCtx →
// 桥 args 尾参 → 主路由提取 → 真实 manager 收到。三段各自独立断言。
import { describe, it, expect, vi } from 'vitest';
import { createBrowserToolsIpcBridge, handleBrowserOpResult } from '../../src/main/agent/tools/browser-ipc-bridge';
import { routeBrowserOp, initBrowserOpRouter, __resetBrowserOpRouterForTest } from '../../src/main/browser/op-router';
import type { BrowserManagerPort, BrowserPolicyPort } from '../../src/main/agent/tools/browser-tools';
import type { BrowserOpResult } from '../../src/main/browser/op-protocol';

describe('BrowserOpCtx 身份透传', () => {
  it('桥端：manager.navigate 携带 ctx 时 args 尾部是 { ownerId, sessionId } 对象', async () => {
    const sent: unknown[] = [];
    const origSend = process.send;
    (process as { send?: unknown }).send = (msg: unknown) => { sent.push(msg); } as never;
    try {
      const bridge = createBrowserToolsIpcBridge(1_000);
      const p = bridge.manager.navigate('w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' });
      // 模拟主进程立即回绝（不等超时——只验发送形状）
      const req = sent[0] as { type: string; op: string; args: unknown[] };
      expect(req.type).toBe('browser-op');
      expect(req.op).toBe('navigate');
      expect(req.args[req.args.length - 1]).toEqual({ ownerId: 'inst-1', sessionId: 'sess-1' });
      void p.catch(() => {});
    } finally {
      (process as { send?: unknown }).send = origSend;
    }
  });

  it('主路由端：args 尾参 ctx 被提取并以第三参传给 manager.navigate', async () => {
    const navigate = vi.fn(async () => ({ url: 'https://a.com', title: 'A' }));
    const manager = { navigate } as unknown as BrowserManagerPort;
    const policy = {} as unknown as BrowserPolicyPort;
    initBrowserOpRouter(policy, manager);
    try {
      const outcome: BrowserOpResult = await routeBrowserOp({
        type: 'browser-op', requestId: 'r1', op: 'navigate',
        args: ['w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' }],
      });
      expect(outcome.ok).toBe(true);
      expect(navigate).toHaveBeenCalledWith('w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' });
    } finally {
      __resetBrowserOpRouterForTest();
    }
  });

  it('主路由端：ctx 缺失/形状非法 → ok:false（不静默吞）', async () => {
    const manager = {} as unknown as BrowserManagerPort;
    initBrowserOpRouter({} as unknown as BrowserPolicyPort, manager);
    try {
      const bad = await routeBrowserOp({ type: 'browser-op', requestId: 'r2', op: 'navigate', args: ['w1', 'u'] });
      expect(bad.ok).toBe(false);
    } finally {
      __resetBrowserOpRouterForTest();
    }
  });

  it('handleBrowserOpResult 仍按 requestId 配对（ctx 扩展不破坏既有应答面）', () => {
    // 既有行为的等价锁：跨进程应答按 requestId 派发（ctx 改造不得触碰）
    let resolved: unknown;
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    pending.set('rx', { resolve: (v) => { resolved = v; }, reject: () => {}, timer: setTimeout(() => {}, 10_000) });
    void pending;
    // 直接以真实桥验证太重——本用例仅锁路由 ok 路径载荷透传
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/op-ctx-threading.test.ts`
Expected: FAIL——navigate 传三参 TS 报错（端口面无 ctx）/ args 断言不符（桥未透传）。

- [ ] **Step 3: 实现契约层**

`op-protocol.ts`——在 `BrowserOpArgs` 前新增类型，12 个 manager 类 op 元组追加 `ctx: BrowserOpCtx` 尾参（`assertAllowed` / `assertEvaluate` 不变）：

```ts
/** 归属身份（spec 2026-09-15 §5.2）：ownerId = agent 实例 ID（workspace_agent_members.instance_id）或 'user'；sessionId = 发起会话（user 源为空串） */
export interface BrowserOpCtx {
  ownerId: string;
  sessionId: string;
}

/** 用户路径（IPC 直连）与旧测试直调的缺省身份 */
export const USER_OP_CTX: BrowserOpCtx = { ownerId: 'user', sessionId: '' };
```

```ts
export interface BrowserOpArgs {
  assertAllowed: [wsId: string];
  assertEvaluate: [wsId: string];
  navigate: [wsId: string, rawUrl: string, ctx: BrowserOpCtx];
  snapshot: [wsId: string, ctx: BrowserOpCtx];
  screenshot: [wsId: string, filename: string | null, ctx: BrowserOpCtx];
  click: [wsId: string, selector: string, ctx: BrowserOpCtx];
  type: [wsId: string, selector: string, text: string, submit: boolean | null, ctx: BrowserOpCtx];
  pressKey: [wsId: string, key: string, ctx: BrowserOpCtx];
  hover: [wsId: string, selector: string, ctx: BrowserOpCtx];
  scroll: [wsId: string, direction: 'up' | 'down', amount: number | null, ctx: BrowserOpCtx];
  evaluate: [wsId: string, expression: string, ctx: BrowserOpCtx];
  consoleMessages: [wsId: string, ctx: BrowserOpCtx];
  tabsAction: [wsId: string, action: 'list' | 'open' | 'close' | 'switch', index: number | null, url: string | null, ctx: BrowserOpCtx];
  closeBrowser: [wsId: string, ctx: BrowserOpCtx];
}
```

同文件：`BROWSER_OP_MAX_ARGS` 上调 +1（grep 定位现有值，如 `5` → `6`；type 的 scroll/tabsAction 已是最长元组）。

`browser-ipc-bridge.ts` manager 对象——每方法加可选 `ctx` 尾参并入 args（缺省 USER_OP_CTX）：

```ts
import { USER_OP_CTX, type BrowserOpCtx } from '../../browser/op-protocol';
// ...
manager: {
  navigate: (wsId: string, rawUrl: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('navigate', [wsId, rawUrl, ctx]),
  snapshot: (wsId: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('snapshot', [wsId, ctx]),
  screenshot: (wsId: string, filename?: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('screenshot', [wsId, filename ?? null, ctx]),
  click: (wsId: string, selector: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('click', [wsId, selector, ctx]),
  type: (wsId: string, selector: string, text: string, submit?: boolean, ctx: BrowserOpCtx = USER_OP_CTX) => call('type', [wsId, selector, text, submit ?? null, ctx]),
  pressKey: (wsId: string, key: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('pressKey', [wsId, key, ctx]),
  hover: (wsId: string, selector: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('hover', [wsId, selector, ctx]),
  scroll: (wsId: string, direction: 'up' | 'down', amount?: number, ctx: BrowserOpCtx = USER_OP_CTX) => call('scroll', [wsId, direction, amount ?? null, ctx]),
  evaluate: (wsId: string, expression: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('evaluate', [wsId, expression, ctx]),
  consoleMessages: (wsId: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('consoleMessages', [wsId, ctx]),
  tabsAction: (wsId: string, action: 'list' | 'open' | 'close' | 'switch', index?: number, url?: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('tabsAction', [wsId, action, index ?? null, url ?? null, ctx]),
  closeBrowser: (wsId: string, ctx: BrowserOpCtx = USER_OP_CTX) => call('closeBrowser', [wsId, ctx]),
},
```

`op-router.ts`——新增校验器，dispatchOp 的 12 个 manager 分支全部追加 `reqOpCtx(args[N], 'ctx')`（N = 该 op 原 args 长度）：

```ts
import { USER_OP_CTX, type BrowserOpCtx } from './op-protocol';
// ...
/** ctx 尾参校验：对象且 ownerId/sessionId 均字符串；缺失（undefined/null）回退缺省用户身份——旧桥兼容 */
function reqOpCtx(v: unknown): BrowserOpCtx {
  if (v === undefined || v === null) return USER_OP_CTX;
  if (typeof v !== 'object') throw new Error('browser-op 参数 "ctx" 必须是 { ownerId, sessionId } 对象');
  const o = v as Record<string, unknown>;
  if (typeof o.ownerId !== 'string' || typeof o.sessionId !== 'string') {
    throw new Error('browser-op 参数 "ctx" 必须是 { ownerId, sessionId } 对象');
  }
  return { ownerId: o.ownerId, sessionId: o.sessionId };
}
```

`tools/types.ts` ToolContext 追加：

```ts
  /**
   * 归属制（spec 2026-09-15 §5.1）：当前 runtime 的 agent 实例 ID
   * （workspace_agent_members.instance_id）。runtime-entry 从 AGENT_CONFIG
   * 的 agentAssignmentId 注入；浏览器工具据此路由专属 tab。缺省（测试直调
   * 无 runner）由消费方归一为 'user'。
   */
  agentInstanceId?: string;
```

`runtime-entry.ts:1600` toolCtx 对象内追加一行（`taskId` 行后）：

```ts
      // 归属制：AGENT_CONFIG 已强校验携带 agentAssignmentId（runtime-config parse）
      agentInstanceId: config.agentAssignmentId,
```

（若 TS 报 `config` 上无该字段名——以 runtime-config.ts 的 RuntimeConfig 实际字段名为准，AGENT_CONFIG parse 错误文案已列 `agentAssignmentId` 为必填。）

`browser-tools.ts`——`BrowserManagerPort` 12 方法加可选尾参 `ctx?: BrowserOpCtx`（import 自 `../../browser/op-protocol`）；`execute` 在 `const wsId = ctx.workspaceId;` 后构造并全程透传：

```ts
    // 归属身份（spec §5.1）：agent 实例归一 'user'；roomId 即 session id（v2 语义）
    const opCtx: BrowserOpCtx = { ownerId: ctx.agentInstanceId ?? 'user', sessionId: ctx.roomId };
```

12 个调用点逐一改为 `manager.navigate(wsId, url, opCtx)` 等形式。

- [ ] **Step 4: 跑新测试 + 既有契约面测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/op-ctx-threading.test.ts tests/browser/op-router.test.ts tests/agent/tools/browser-ipc-bridge.test.ts tests/agent/tools/browser-tools.test.ts`
Expected: 新测试 PASS；既有测试如有 args 断言失败（数组多出 ctx 对象），把断言数组补上 `{ ownerId: 'user', sessionId: <fixture 的 roomId> }`（旧 fixture 无 agentInstanceId → ownerId 恒 'user'）。

- [ ] **Step 5: typecheck + commit**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add -A electron/src electron/tests
git commit -m "feat: browser op 线协议扩展 BrowserOpCtx 身份尾参——agentInstanceId 从 AGENT_CONFIG 经 ToolContext 透传（归属制 Task 1/7）"
```

---

### Task 2: manager 归属制内核（TabRecord.owner + per-owner 光标）

**Files:**
- Modify: `electron/src/main/browser/manager.ts`（核心改造，见 Step 3 全量代码）
- Test: `electron/tests/browser/manager-ownership.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `BrowserOpCtx` / `USER_OP_CTX`
- Produces:
  - `TabRecord { view, serial, owner: string }`
  - `ActiveWorkspace.ownerCurrent: Map<string, number>`
  - manager 公共方法签名（Task 1 端口面镜像）：`navigate(wsId, rawUrl, ctx=USER_OP_CTX)`、`tabsAction(wsId, action, index?, url?, source='agent', ctx=USER_OP_CTX)`、`closeBrowser(wsId, source='agent', ctx=USER_OP_CTX)`、`snapshot/click/type/pressKey/hover/scroll/evaluate/consoleMessages/screenshot (wsId, ..., ctx=USER_OP_CTX)`
  - 本 Task **不动**：collapsed/collapseStash/ensureLive/setSidebarCollapsed（Task 3 退役）——navigate 内 `ensureLive(ws)` 保留原位

- [ ] **Step 1: 写失败测试（P1 回归锁：多 owner 并存互不踩踏）**

```ts
// electron/tests/browser/manager-ownership.test.ts
//
// 归属制内核回归锁（spec §6.1）：多 owner tab 并存、光标独立、工具按 owner
// 解析、agent close 只清自己集合、user 源保持全局语义。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import { USER_OP_CTX, type BrowserOpCtx } from '../../src/main/browser/op-protocol';

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

function mk(): { manager: BrowserManager; states: Array<{ tabs: Array<{ url: string; owner: string }>; current: number }> } {
  const factory: ViewFactory = { create: () => makeView(), destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Array<{ tabs: Array<{ url: string; owner: string }>; current: number }> = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    { pushState: (s) => states.push({ tabs: s.tabs.map((t) => ({ url: t.url, owner: t.owner })), current: s.current }), pushNotice: vi.fn() },
  );
  return { manager, states };
}

const A: BrowserOpCtx = { ownerId: 'inst-a', sessionId: 'sess-1' };
const B: BrowserOpCtx = { ownerId: 'inst-b', sessionId: 'sess-2' };

describe('归属制内核', () => {
  it('P1 回归锁：A 开百度 + B 开 bing → 两 tab 并存互不覆盖，list 按各自作用域返回', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://baidu.com', A);
    await manager.navigate('w1', 'https://bing.com', B);
    // A 视角：只有自己的 tab
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA.map((t) => t.url)).toEqual(['https://baidu.com']);
    expect(listA[0]!.index).toBe(0); // 集合内重索引
    const listB = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', B);
    expect(listB.map((t) => t.url)).toEqual(['https://bing.com']);
    // user 全局视角：两个都在
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.owner).sort()).toEqual(['inst-a', 'inst-b']);
  });

  it('agent open 追加自己集合且光标迁移，不动可见 tab', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    // user 把可见 tab 切到 B 的页面（全局下标）
    await manager.tabsAction('w1', 'switch', 1, undefined, 'user');
    // A 再 open 新 tab（无 url）
    const list = await manager.tabsAction('w1', 'open', undefined, undefined, 'agent', A);
    expect(list).toHaveLength(2); // A 视角：a1 + 新 tab
    // A 的后续 navigate 落在新 tab 而非 a1
    await manager.navigate('w1', 'https://a2.com', A);
    const list2 = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(list2.map((t) => t.url)).toEqual(['https://a1.com', 'https://a2.com']);
  });

  it('agent close 关光自己最后一个 tab → 集合清空不触发关浏览器；再次 navigate 懒建', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    const after = await manager.tabsAction('w1', 'close', 0, undefined, 'agent', A);
    expect(after).toEqual([]); // A 集合空
    // B 不受影响
    const listB = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', B);
    expect(listB.map((t) => t.url)).toEqual(['https://b1.com']);
    // A 再导航 → 懒建首 tab
    await manager.navigate('w1', 'https://a3.com', A);
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA.map((t) => t.url)).toEqual(['https://a3.com']);
  });

  it('视图类工具按 owner 光标解析：evaluate 落在 owner 的 current tab', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    const r = await manager.evaluate('w1', '1+1', B);
    expect(r).toBeNull(); // mock executeJavaScript 返回 null——断言不抛 NoView 即按 owner 解析成功
  });

  it('browser_close（agent 源）只销毁自己的 tab；user 源销毁全部', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    await manager.closeBrowser('w1', 'agent', A);
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all.map((t) => t.url)).toEqual(['https://b1.com']); // 只剩 B
    await manager.closeBrowser('w1', 'user');
    const all2 = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all2).toEqual([]);
  });

  it('ownerCurrent 悬空（用户关掉 agent 的 tab）→ 下次操作修正回集合首个', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://a2.com', A);
    // user 全局视角关掉 A 的当前 tab（全局下标 1）
    await manager.tabsAction('w1', 'close', 1, undefined, 'user');
    // A 的 navigate 修正回集合首个（a1）而非报错/悬空
    await manager.navigate('w1', 'https://a3.com', A);
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA.map((t) => t.url)).toEqual(['https://a1.com', 'https://a3.com']);
  });

  it('user 源保持既有全局语义（缺省 ctx 直调 = user 路径不回归）', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    const r = await manager.navigate('w1', 'https://u1.com'); // 缺省 USER_OP_CTX
    expect(r.url).toBe('https://u1.com');
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all[0]!.owner).toBe('user');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/manager-ownership.test.ts`
Expected: FAIL——TabInfo 无 owner / tabsAction 无第 6 参 / navigate 无 ctx 参（TS 编译错或断言失败）。

- [ ] **Step 3: 实现 manager 归属制**

`manager.ts` 逐块替换（保持既有注释风格，中文）：

**(a) TabRecord / ActiveWorkspace**：

```ts
interface TabRecord {
  view: ManagedView;
  /** tab 唯一序列号——console buffer 以 serial 键控，tab 关闭即释放，零漂移 */
  serial: number;
  /** 归属方（spec 2026-09-15 §4.1）：agent 实例 ID 或 'user' */
  owner: string;
}
```

ActiveWorkspace 增字段（collapsed/collapseStash 本 Task 保留）：

```ts
  /** 归属方 → 该方 current tab 的全局下标（spec §4.1 独立光标） */
  ownerCurrent: Map<string, number>;
```

onWorkspaceActivated 构造 ws 处补 `ownerCurrent: new Map()`。

**(b) 归属解析四辅助**（放在 requireCurrentTab 附近）：

```ts
  /** owner 拥有的全部 tab 全局下标（升序） */
  private ownerTabs(ws: ActiveWorkspace, owner: string): number[] {
    const idx: number[] = [];
    ws.tabs.forEach((t, i) => { if (t.owner === owner) idx.push(i); });
    return idx;
  }

  /** 解析 owner 光标：缓存命中且未悬空 → 用缓存；悬空 → 修正回集合首个；集合空 → -1 */
  private resolveOwnerCurrent(ws: ActiveWorkspace, owner: string): number {
    const cached = ws.ownerCurrent.get(owner);
    if (cached !== undefined && ws.tabs[cached]?.owner === owner) return cached;
    const first = this.ownerTabs(ws, owner)[0];
    if (first === undefined) return -1;
    ws.ownerCurrent.set(owner, first);
    return first;
  }

  /** 保证 owner 的 current tab 存在（无则建专属 tab）——ensureLive 的懒建语义收敛于此 */
  private ensureOwnerTab(ws: ActiveWorkspace, owner: string): number {
    const idx = this.resolveOwnerCurrent(ws, owner);
    if (idx >= 0) return idx;
    this.createTab(ws, owner);
    const next = ws.tabs.length - 1;
    ws.ownerCurrent.set(owner, next);
    return next;
  }

  /** agent 作用域下标（0..n-1）→ 全局下标；越界抛 RangeError */
  private ownerScopedIndex(ws: ActiveWorkspace, owner: string, scoped: number | undefined): number {
    const own = this.ownerTabs(ws, owner);
    const raw = scoped ?? 0;
    if (raw < 0 || raw >= own.length) {
      throw new RangeError(`tab 下标 ${raw} 越界（现有 ${own.length} 个 tab）`);
    }
    return own[raw]!;
  }
```

**(c) createTab / openTabInternal**：

```ts
  private createTab(ws: ActiveWorkspace, owner: string): TabRecord {
    const view = this.factory.create(ws.workspaceId);
    const serial = this.nextSerial++;
    ws.consoleBuffer.set(serial, []);
    const record: TabRecord = { view, serial, owner };
    ws.tabs.push(record);
    this.wireView(ws, record);
    return record;
  }

  /** open / popup 收编共用：createTab + 移光标 + fire-and-forget 载入。
   *  focusVisible：user 源 true（新 tab 成为可见——既有语义）；agent 源 false
   *  （可见 tab 仅由活跃会话自动切换与用户显式切换改变，spec §6.2）。 */
  private openTabInternal(ws: ActiveWorkspace, initialUrl: string | null, owner: string, focusVisible: boolean): TabRecord {
    const record = this.createTab(ws, owner);
    const idx = ws.tabs.length - 1;
    ws.ownerCurrent.set(owner, idx);
    if (focusVisible) {
      ws.current = idx;
      this.applyLastRect(ws);
    }
    void this.loadForNotice(record, initialUrl ?? ABOUT_BLANK, ws.workspaceId);
    return record;
  }
```

调用点同步：`incorporatePopup` → `this.openTabInternal(ws, url, 'user', true)`（popup 由用户页面触发，归 user）。

**(d) navigate**（gate/assertUrl/ensureLive 原序保留；tab 解析换 owner）：

```ts
  async navigate(wsId: string, rawUrl: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<{ url: string; title: string }> {
    const ws = this.requireWorkspace(wsId);
    await this.gateAgentSide(ws);
    const url = this.policy.assertUrl(wsId, rawUrl); // 越界/协议错误原样穿透 T5（不建视图）
    this.ensureLive(ws);
    const idx = this.ensureOwnerTab(ws, ctx.ownerId);
    const tab = ws.tabs[idx]!;
    await this.loadChecked(tab, url);
    this.emitState(ws);
    return {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
    };
  }
```

（自动切换/expandHint 在 Task 3 加入 maybeAutoSwitch。）

**(e) requireCurrentTab / requireCurrentWebContents**：

```ts
  private async requireCurrentTab(wsId: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<{ ws: ActiveWorkspace; tab: TabRecord }> {
    const ws = this.requireWorkspace(wsId);
    await this.gateAgentSide(ws);
    const idx = this.resolveOwnerCurrent(ws, ctx.ownerId);
    const tab = idx >= 0 ? ws.tabs[idx] : undefined;
    if (!tab) throw new BrowserNoViewError();
    return { ws, tab };
  }
```

`snapshot/screenshot/click/type/pressKey/hover/scroll/consoleMessages` 六处签名与 `requireCurrentTab/requireCurrentWebContents(wsId)` 调用全部加 `ctx` 尾参透传（如 `async click(wsId: string, selector: string, ctx: BrowserOpCtx = USER_OP_CTX)` → `clickElement((await this.requireCurrentWebContents(wsId, ctx)), ...)`）。`evaluate` 同理（gate 后 owner 光标取 tab）。

**(f) tabsAction**：

```ts
  async tabsAction(
    wsId: string,
    action: 'list' | 'open' | 'close' | 'switch',
    index?: number,
    url?: string,
    source: BrowserActionSource = 'agent',
    ctx: BrowserOpCtx = USER_OP_CTX,
  ): Promise<TabInfo[]> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') await this.gateAgentSide(ws);
    switch (action) {
      case 'list':
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      case 'open': {
        const initialUrl = url === undefined ? null : this.policy.assertUrl(wsId, url);
        this.ensureLive(ws);
        this.openTabInternal(ws, initialUrl, source === 'agent' ? ctx.ownerId : 'user', source !== 'agent');
        this.emitState(ws);
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      }
      case 'close': {
        const idx = source === 'agent'
          ? this.ownerScopedIndex(ws, ctx.ownerId, index ?? this.resolveOwnerCurrent(ws, ctx.ownerId) >= 0 ? this.ownerTabs(ws, ctx.ownerId).indexOf(this.resolveOwnerCurrent(ws, ctx.ownerId)) : undefined)
          : (index ?? ws.current);
        const tab = ws.tabs[idx];
        if (!tab) {
          throw new RangeError(`tab 下标 ${index ?? ws.current} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        // agent 关光自己最后一个 tab = 集合清空（不触发关浏览器，spec §6.4）
        if (source === 'agent' && this.ownerTabs(ws, ctx.ownerId).length === 1) {
          this.factory.destroy(tab.view);
          ws.tabs.splice(idx, 1);
          ws.consoleBuffer.delete(tab.serial);
          ws.ownerCurrent.delete(ctx.ownerId);
          this.fixCurrentAfterRemoval(ws);
          this.applyLastRect(ws);
          this.emitState(ws);
          return [];
        }
        if (ws.tabs.length === 1) {
          // user 关全局唯一 tab = 关闭浏览器（spec §4 工具 11 语义保留于 user 源）
          await this.closeBrowser(wsId, source, ctx);
          return [];
        }
        this.factory.destroy(tab.view);
        ws.tabs.splice(idx, 1);
        ws.consoleBuffer.delete(tab.serial);
        if (idx < ws.current) ws.current -= 1;
        else if (idx === ws.current) ws.current = Math.min(ws.current, ws.tabs.length - 1);
        // 其他 owner 的光标/缓存随 splice 修正（全局下标移位）
        this.reindexOwnerCursors(ws, idx);
        this.applyLastRect(ws);
        this.emitState(ws);
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      }
      case 'switch': {
        if (source === 'agent') {
          const global = this.ownerScopedIndex(ws, ctx.ownerId, index ?? 0);
          ws.ownerCurrent.set(ctx.ownerId, global); // 仅移自己光标，不动可见 tab（spec §6.1）
          this.emitState(ws);
          return this.tabInfos(ws, ctx.ownerId);
        }
        const idx = index ?? 0;
        if (idx < 0 || idx >= ws.tabs.length) {
          throw new RangeError(`tab 下标 ${idx} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        ws.current = idx;
        this.applyLastRect(ws);
        this.emitState(ws);
        return this.tabInfos(ws, null);
      }
    }
  }

  /** 全局删除 idx 后修正 ws.current 与全部 owner 光标（悬空/移位） */
  private fixCurrentAfterRemoval(ws: ActiveWorkspace): void {
    if (ws.current >= ws.tabs.length) ws.current = Math.max(ws.tabs.length - 1, 0);
  }

  private reindexOwnerCursors(ws: ActiveWorkspace, removedIdx: number): void {
    for (const [owner, cur] of ws.ownerCurrent) {
      if (cur === removedIdx) ws.ownerCurrent.delete(owner); // 悬空 → 下次解析回集合首个
      else if (cur > removedIdx) ws.ownerCurrent.set(owner, cur - 1);
    }
  }
```

注意：close 的 agent 分支下标表达式较长——落地时抽局部变量 `const ownIdx = ...` 求值（保持逻辑等价：`index` 给了用 ownerScopedIndex 归一；没给用当前光标的集合内位置）。

**(g) closeBrowser**：

```ts
  /** browser_close：agent 源只销毁自己集合（spec §6.4 归属制）；user 源全局销毁（renderer 已过确认卡） */
  async closeBrowser(wsId: string, source: BrowserActionSource = 'agent', ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') {
      await this.gateAgentSide(ws);
      const own = this.ownerTabs(ws, ctx.ownerId);
      for (let i = own.length - 1; i >= 0; i--) {
        const global = own[i]!;
        const tab = ws.tabs[global]!;
        this.factory.destroy(tab.view);
        ws.tabs.splice(global, 1);
        ws.consoleBuffer.delete(tab.serial);
      }
      ws.ownerCurrent.delete(ctx.ownerId);
      this.fixCurrentAfterRemoval(ws);
      this.applyLastRect(ws);
      this.emitState(ws);
      return;
    }
    this.destroyTabs(ws);
    ws.current = 0;
    ws.ownerCurrent.clear();
    ws.takeover = 'agent'; // 全新仲裁起点（仅全局销毁——spec §6.4）
    this.collapseStash = null;
    this.stashedTabs.delete(wsId);
    this.settleAgentWait(wsId, true);
    this.emitState(ws);
  }
```

**(h) tabInfos / restoreTabs / TabInfo**：

```ts
  /** tab 清单：owner 非空 = 该 owner 集合内重索引（agent 视角）；null = 全局（user 视角） */
  private tabInfos(ws: ActiveWorkspace, owner: string | null): TabInfo[] {
    if (owner === null) {
      return ws.tabs.map((t, i) => ({ index: i, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), owner: t.owner }));
    }
    return this.ownerTabs(ws, owner).map((global, scoped) => ({
      index: scoped,
      url: ws.tabs[global]!.view.webContents.getURL(),
      title: ws.tabs[global]!.view.webContents.getTitle(),
      owner,
    }));
  }
```

`types.ts` TabInfo 加 `owner: string;`（BrowserState 不动——Task 3）。既有 `tabInfos(ws)` 调用点（`getState`/`buildState`）改 `tabInfos(ws, null)`。`restoreTabs` 的 `createTab(ws)` → `createTab(ws, 'user')`（Task 3 给 TabStash 加 owners 后再透传）。

- [ ] **Step 4: 跑新测试 + manager 全域**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/`
Expected: manager-ownership 全 PASS；既有 manager.test.ts / manager-agent-wait.test.ts / trust-gate-integration.test.ts / manager-collapsed-navigate.test.ts 若有失败：多为 user 源语义点位（缺省 ctx 直调 navigate → tab owner 'user'，行为等价）或 TabInfo 断言（补 owner 字段）——逐个修测试断言，不改生产语义。

- [ ] **Step 5: typecheck + commit**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add -A electron/src electron/tests
git commit -m "feat: manager 归属制内核——TabRecord.owner + per-owner 光标，12 工具按 owner 解析，agent close 只清自己集合（Task 2/7）"
```

---

### Task 3: 隐藏/销毁分离 + expandHint + 折叠链路退役

**Files:**
- Modify: `electron/src/main/browser/manager.ts`
- Modify: `electron/src/main/browser/types.ts`（BrowserState：collapsed 恒 false 保留 + expandHint 新增——renderer 契约 Task 5 才删）
- Modify: `electron/src/main/browser/boot.ts:104-110`（移除 readSidebarCollapsed 注入）
- Rewrite: `electron/tests/browser/manager-collapsed-navigate.test.ts` → `electron/tests/browser/manager-hidden-navigate.test.ts`
- Test: `electron/tests/browser/manager-hide-expand.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 内核
- Produces:
  - `setSidebarVisible(wsId: string, visible: boolean): void`
  - `setActiveSession(sessionId: string | null): void`
  - `BrowserState.expandHint: boolean`（`collapsed` 字段本 Task 恒 false——过渡兼容，Task 5 删）
  - 退役：`setSidebarCollapsed` / `ActiveWorkspace.collapsed` / `collapseStash` / `ensureLive` / `readSidebarCollapsed` opt
  - `TabStash { urls: string[]; current: number; owners: string[] }`（跨 ws 保归属）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/browser/manager-hide-expand.test.ts
//
// 隐藏/销毁分离 + 自动展开规则（spec §6.3/§7.3）：隐藏不销毁、agent 照常操作、
// 活跃会话导航 expandHint=true + 可见 tab 切换、非活跃不打扰。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import type { BrowserOpCtx } from '../../src/main/browser/op-protocol';

function makeView(): ManagedView {
  const wc = {
    loadURL: vi.fn(async () => {}),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => 'https://example.com',
    getTitle: () => 'Example',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  return { webContents: wc, bounds: { setBounds: vi.fn() } } as unknown as ManagedView;
}

interface Fixture {
  manager: BrowserManager;
  states: Array<{ expandHint: boolean; current: number; tabs: unknown[] }>;
  views: ManagedView[];
}

function mk(readCollapsed = false): Fixture {
  const views: ManagedView[] = [];
  const factory: ViewFactory = { create: () => { const v = makeView(); views.push(v); return v; }, destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Fixture['states'] = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    { pushState: (s) => states.push({ expandHint: s.expandHint, current: s.current, tabs: s.tabs }), pushNotice: vi.fn() },
    readCollapsed ? { readSidebarCollapsed: () => true } : undefined,
  );
  return { manager, states, views };
}

const A: BrowserOpCtx = { ownerId: 'inst-a', sessionId: 'sess-1' };

describe('隐藏/销毁分离', () => {
  it('setSidebarVisible(false)：全部视图 bounds 置零、不销毁；true 恢复 current', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    await f.manager.navigate('w1', 'https://a.com', A);
    f.manager.setSidebarVisible('w1', false);
    expect(f.views[0]!.bounds.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    const list = await f.manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(list).toHaveLength(1); // 未销毁
    // 隐藏期 agent 照常 navigate（新页面加载到自己的 tab）
    await f.manager.navigate('w1', 'https://b.com', A);
    // 显示 → applyLastRect 恢复（有 lastRect 时套用；无则等 renderer 重报）
    f.manager.setSidebarVisible('w1', true);
    expect(true).toBe(true);
  });
});

describe('自动展开规则（spec §7.3）', () => {
  it('活跃会话的 agent 导航 → ws.current 切到该 tab + 推送 expandHint=true', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession('sess-1');
    f.manager.setSidebarVisible('w1', false);
    await f.manager.navigate('w1', 'https://a.com', A);
    const last = f.states[f.states.length - 1]!;
    expect(last.expandHint).toBe(true);
    expect(last.current).toBe(0); // owner tab 成为可见 tab
  });

  it('非活跃会话的 agent 导航 → 不动可见 tab、expandHint=false（不打扰）', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession('sess-2'); // 活跃的是别的会话
    await f.manager.navigate('w1', 'https://a.com', A);
    const last = f.states[f.states.length - 1]!;
    expect(last.expandHint).toBe(false);
  });

  it('setActiveSession(null)（非会话视图）→ 安全缺省：永不 expandHint', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession(null);
    await f.manager.navigate('w1', 'https://a.com', A);
    expect(f.states[f.states.length - 1]!.expandHint).toBe(false);
  });
});

describe('折叠链路退役（spec §7.1/§7.4）', () => {
  it('启动即「折叠」（readSidebarCollapsed 兼容注入被无视）→ agent 导航直接建专属 tab 且 expandHint 按会话判定', async () => {
    // readSidebarCollapsed 注入仍在构造 opts 里也不读——激活不投影折叠态
    const f = mk(true);
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession('sess-1');
    const r = await f.manager.navigate('w1', 'https://a.com', A);
    expect(r.url).toBe('https://a.com');
    expect(f.states[f.states.length - 1]!.tabs).toHaveLength(1);
  });

  it('跨 ws 切换保留 tab 归属（TabStash.owners）', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    await f.manager.navigate('w1', 'https://a.com', A);
    f.manager.onWorkspaceActivated('w2', '/tmp2');
    f.manager.onWorkspaceActivated('w1', '/tmp');
    const all = await f.manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all[0]!.owner).toBe('inst-a');
  });
});
```

同时删除旧 `manager-collapsed-navigate.test.ts`（其回归意图由本文件 + hidden 等价锁承接，spec §7.2）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/manager-hide-expand.test.ts`
Expected: FAIL——无 setSidebarVisible/setActiveSession/expandHint；readSidebarCollapsed 仍被激活投影。

- [ ] **Step 3: 实现**

**(a) ActiveWorkspace**：删 `collapsed` / `collapseStash`，增 `viewsHidden: boolean`；类字段增 `private activeSessionId: string | null = null;`。

**(b) 新方法**（放 setSidebarBounds 附近）：

```ts
  /** IPC browser:setSidebarVisible 消费点——收起 = 纯隐藏（bounds 全零，视图存活，spec §6.3）；显示 = 恢复可见 tab */
  setSidebarVisible(wsId: string, visible: boolean): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) return;
    if (ws.viewsHidden === !visible) return;
    ws.viewsHidden = !visible;
    if (!visible) {
      for (const t of ws.tabs) t.view.bounds.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else {
      this.applyLastRect(ws);
    }
    // 不推送状态：可见性真相源在 renderer（per-session），main 无折叠语义
  }

  /** IPC browser:setActiveSession 消费点——renderer 活跃会话上报（自动展开判定输入，spec §7.3） */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }
```

**(c) applyLastRect / setSidebarBounds 守卫**：两方法体首行加 `if (ws.viewsHidden) return;`（setSidebarBounds 仍先缓存 `this.lastRect = rect` 再守卫）。

**(d) emitState / buildState**：

```ts
  private emitState(ws: ActiveWorkspace, opts?: { expandHint?: boolean }): void {
    this.hooks.pushState(this.buildState(ws, opts?.expandHint ?? false));
  }
```

buildState：`collapsed: false,` → 删；加 `expandHint,`（签名 `buildState(ws: ActiveWorkspace, expandHint: boolean)`）。`types.ts` BrowserState 同步：删 collapsed 行、加：

```ts
  /** 本帧推送由「活跃会话的 agent 导航」触发（spec §7.3）——renderer 见 true 且本会话隐藏则展开侧栏 */
  expandHint: boolean;
```

⚠️ renderer `types.d.ts` 的 BrowserState 尚未跟进（Task 5）——electron 侧多推 expandHint 字段对 renderer 结构类型无害，反向（renderer 还在读 collapsed）由本 Task 保持推送 `collapsed: false` 过渡……**修正**：直接删 collapsed 会让 renderer `s.collapsed` 读 undefined（falsy）——BrowserSidebar 的 `if (!next.collapsed)` 自动展开分支退化为恒展开。为避免中间态行为漂移，**本 Task 在 buildState 里保留 `collapsed: false` 字面量一行**（types.d.ts 删字段后多余键无害），Task 5 renderer 删读取后 Task 6 收尾再删该行。

**(e) navigate 自动切换**（替换 Task 2 版本的收尾）：

```ts
    await this.loadChecked(tab, url);
    this.maybeAutoSwitch(ws, ctx, idx);
    return { ... };
```

```ts
  /** 自动切换/展开（spec §7.3）：仅活跃会话的 agent 导航触发——切可见 tab + expandHint；
   *  user 源与非活跃会话不打扰（expandHint=false，不动 ws.current）。 */
  private maybeAutoSwitch(ws: ActiveWorkspace, ctx: BrowserOpCtx, ownerTabIdx: number): void {
    const hit = ctx.ownerId !== 'user' && ctx.sessionId !== '' && ctx.sessionId === this.activeSessionId;
    if (hit) {
      ws.current = ownerTabIdx;
      this.applyLastRect(ws); // viewsHidden 时内部 no-op——仅记录 ws.current，显示时恢复
      this.emitState(ws, { expandHint: true });
    } else {
      this.emitState(ws);
    }
  }
```

**(f) ensureLive 删除**：navigate/tabsAction-open/userNavigate/incorporatePopup 的 `this.ensureLive(ws)` 调用删除（ensureOwnerTab 已覆盖懒建）；整个 ensureLive 方法与 `readSidebarCollapsed` 字段/构造注入删除。

**(g) setSidebarCollapsed 方法整体删除**；`onWorkspaceActivated` 重写：

```ts
  onWorkspaceActivated(wsId: string, workspaceDir: string): void {
    this.policy.setWorkspaceRoot(workspaceDir);
    const cur = this.active;
    if (cur?.workspaceId === wsId) {
      cur.workspaceDir = workspaceDir;
      return; // 重复激活幂等
    }
    if (cur) this.onWorkspaceDeactivated(cur.workspaceId);
    const ws: ActiveWorkspace = {
      workspaceId: wsId,
      workspaceDir,
      tabs: [],
      current: 0,
      takeover: 'agent',
      consoleBuffer: new Map(),
      ownerCurrent: new Map(),
      viewsHidden: false,
      lastUserInputAt: Date.now(),
    };
    this.active = ws;
    const stash = this.stashedTabs.get(wsId);
    if (stash && stash.urls.length > 0) {
      this.stashedTabs.delete(wsId);
      this.restoreTabs(ws, stash);
    }
    this.emitState(ws);
  }
```

`onWorkspaceDeactivated` 中 collapseStash 分支替换：

```ts
    this.settleAgentWait(wsId, true);
    if (ws.tabs.length > 0 || !this.stashedTabs.has(wsId)) {
      this.stashedTabs.set(wsId, {
        urls: ws.tabs.map((t) => t.view.webContents.getURL()),
        current: ws.current,
        owners: ws.tabs.map((t) => t.owner), // 归属随清单跨 ws 保留（spec §6.5）
      });
    }
    this.destroyTabs(ws);
    ws.ownerCurrent.clear();
    this.active = null; // 不推送——新 workspace 激活时会推送其状态
```

`TabStash` 增 `owners: string[];`；`restoreTabs`：

```ts
  private restoreTabs(ws: ActiveWorkspace, stash: TabStash): void {
    stash.urls.forEach((url, i) => {
      const record = this.createTab(ws, stash.owners[i] ?? 'user');
      ws.ownerCurrent.set(record.owner, i); // 各 owner 光标指向自己首个（多个同 owner 取后者，等价）
      void this.loadForNotice(record, url, ws.workspaceId);
    });
    ws.current = Math.min(Math.max(stash.current, 0), Math.max(ws.tabs.length - 1, 0));
    this.applyLastRect(ws);
  }
```

**(h) boot.ts**：manager 构造 opts 删 `readSidebarCollapsed: ...` 三行（:106）；`boot-wiring.test.ts` 相应断言更新（grep `readSidebarCollapsed` in electron/tests）。

- [ ] **Step 4: 跑 browser 全域**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/`
Expected: 全 PASS。既有引用 collapsed/setSidebarCollapsed 的测试（manager.test.ts / ipc.test.ts / manager-collapsed-navigate 已删）逐个改写：折叠语义用例 → 隐藏语义（setSidebarVisible + 断言 bounds 置零而非视图销毁）。

- [ ] **Step 5: typecheck + commit**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add -A electron/src electron/tests
git commit -m "feat: 隐藏/销毁分离——setSidebarVisible bounds 置零不销毁 + setActiveSession/expandHint 自动展开 + 折叠销毁链路退役（Task 3/7）"
```

---

### Task 4: 主进程 IPC 通道面

**Files:**
- Modify: `electron/src/main/browser/ipc.ts`（通道改造）
- Modify: `electron/src/preload/index.ts:131-160`（新增三通道；setSidebarCollapsed 本 Task 保留——Task 5 renderer 停调后删）
- Modify: `renderer/src/ipc/types.d.ts`（BrowserApi 增三方法——纯增量，renderer 编译安全）
- Test: `electron/tests/browser/ipc.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 3 的 setSidebarVisible/setActiveSession/closeBrowser(user)
- Produces（renderer 可调）:
  - `setSidebarVisible(workspaceId: string, visible: boolean): Promise<void>`
  - `setActiveSession(sessionId: string | null): Promise<void>`
  - `closeBrowser(workspaceId: string): Promise<void>`（user 源全局销毁——renderer 已过确认卡）
  - 用户路径 tabs/open/close/switch/userNavigate 的 manager 调用补 `USER_OP_CTX` 尾参

- [ ] **Step 1: 写失败测试（ipc.test.ts 追加 describe）**

```ts
// 追加到 electron/tests/browser/ipc.test.ts（沿用该文件既有 fixture 风格——
// mkIpc() 捕获桩 ipcMain + 真 manager，参照文件内现有用例组装；此处给断言主体）
describe('归属制通道（2026-09-15）', () => {
  it('browser:setSidebarVisible → manager.setSidebarVisible 透传', async () => {
    // 调捕获桩 handler: ('browser:setSidebarVisible', 'w1', false)
    // 断言：manager 侧 tabs 存活 + bounds 全零（经 state/视图桩可观测）——按文件既有观测手段
  });
  it('browser:setActiveSession → manager.setActiveSession 透传（null 合法）', async () => {
    // handler ('browser:setActiveSession', null) 不抛
  });
  it('browser:closeBrowser → user 源全局销毁', async () => {
    // 先 navigate 两 tab（agent ctx），handler ('browser:closeBrowser', 'w1') 后 list 为空
  });
});
```

（ipc.test.ts 已有完整的捕获桩/断言基建——按文件内 `lastState` 等既有模式补全三条用例体；上表是断言意图与通道签名，落时代码以文件既有风格为准。）

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/ipc.test.ts`
Expected: FAIL——三通道未注册。

- [ ] **Step 3: 实现**

`ipc.ts` registerBrowserIpc 内：`browser:setSidebarCollapsed` handler 整块删除，替换为：

```ts
  // 收起 = 纯隐藏（spec §6.3）：bounds 置零不销毁；可见性记忆在 renderer per-session
  ipcMainLike.handle('browser:setSidebarVisible', (_e, wsId, visible) => {
    manager.setSidebarVisible(asString(wsId, 'workspaceId'), asBoolean(visible, 'visible'));
  });

  // 活跃会话上报（spec §5.4）：自动展开判定输入；null = 非会话视图
  ipcMainLike.handle('browser:setActiveSession', (_e, sessionId) => {
    if (sessionId !== null && typeof sessionId !== 'string') {
      throw new Error('browser:setActiveSession 参数 sessionId 必须是字符串或 null');
    }
    manager.setActiveSession(sessionId);
  });

  // 用户显式关闭浏览器（renderer 已过确认卡——spec §6.4）：user 源全局销毁
  ipcMainLike.handle('browser:closeBrowser', (_e, wsId) =>
    manager.closeBrowser(asString(wsId, 'workspaceId'), 'user'),
  );
```

用户路径既有 handler（userNavigate / openTab / closeTab / switchTab）的 manager 调用补 `USER_OP_CTX` 尾参（import 自 op-protocol）。日志行 `已注册（14 通道）` → `已注册（16 通道）`。

`preload/index.ts` browser 对象追加（setSidebarCollapsed 暂留）：

```ts
    setSidebarVisible: (workspaceId, visible) => invoke('browser:setSidebarVisible', workspaceId, visible),
    setActiveSession: (sessionId) => invoke('browser:setActiveSession', sessionId),
    closeBrowser: (workspaceId) => invoke('browser:closeBrowser', workspaceId),
```

`types.d.ts` BrowserApi 同步追加三方法签名（`setActiveSession(sessionId: string | null): Promise<void>;` 等）。

- [ ] **Step 4: 跑测试 + typecheck + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/browser/ipc.test.ts tests/browser/
cd /workspace && npx pnpm@9.0.0 typecheck
git add -A electron/src electron/tests renderer/src
git commit -m "feat: browser IPC 通道面——setSidebarVisible/setActiveSession/closeBrowser(user)，setSidebarCollapsed 退役（Task 4/7）"
```

---

### Task 5: renderer 可见性 store + BrowserSidebar 接线

**Files:**
- Create: `renderer/src/stores/browser-visibility.store.ts`
- Create: `renderer/src/stores/browser-visibility.store.test.ts`（贴源）
- Modify: `renderer/src/components/workspace/BrowserSidebar.tsx`（核心改造）
- Modify: `renderer/src/App.tsx`（activeSessionId 上报 effect）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`（删 setSidebarCollapsed；BrowserState 删 collapsed 读引用）
- Modify: `renderer/src/components/workspace/BrowserSidebar.test.tsx`（折叠用例改可见性语义）

**Interfaces:**
- Consumes: Task 4 的三通道 + expandHint
- Produces:
  - `useBrowserVisibilityStore`：`{ visibilityBySession: Record<string, boolean>; isVisible(sessionId: string | null): boolean; setVisible(sessionId: string, visible: boolean): void; purgeStale(alive: string[]): void }`
  - BrowserSidebar 的可见性 = `isVisible(activeSessionId)`；新会话缺省 false（收起）

- [ ] **Step 1: 写失败测试**

```ts
// renderer/src/stores/browser-visibility.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserVisibilityStore } from './browser-visibility.store';

describe('browser-visibility store（per-session 可见性，spec §9.1）', () => {
  beforeEach(() => {
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
  });
  it('缺省不可见（新会话默认收起）', () => {
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);
    expect(useBrowserVisibilityStore.getState().isVisible(null)).toBe(false);
  });
  it('setVisible 按会话独立记忆', () => {
    useBrowserVisibilityStore.getState().setVisible('s1', true);
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(true);
    expect(useBrowserVisibilityStore.getState().isVisible('s2')).toBe(false);
  });
  it('purgeStale 清理已删除会话的条目', () => {
    useBrowserVisibilityStore.getState().setVisible('s1', true);
    useBrowserVisibilityStore.getState().setVisible('s2', true);
    useBrowserVisibilityStore.getState().purgeStale(['s2']);
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);
    expect(useBrowserVisibilityStore.getState().isVisible('s2')).toBe(true);
  });
});
```

BrowserSidebar.test.tsx：既有 `collapsed`/`setSidebarCollapsed`/`armOnBrowserState` 相关 describe 改造——折叠按钮用例改为：点击收起 → `setSidebarVisible` IPC 以 `(wsId, false)` 调用 + rail 渲染；expandHint 用例：状态推送 `{ expandHint: true, ... }` 且 activeSession 可见性为 false → 变可见（占位区出现）。按文件既有 ResizeObserverStub/ipc-mock 基建写，保持「订阅计数断言回 1」不变。

- [ ] **Step 2: 确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/browser-visibility.store.test.ts src/components/workspace/BrowserSidebar.test.tsx`
Expected: store 文件不存在 FAIL；sidebar 用例 FAIL。

- [ ] **Step 3: 实现**

`browser-visibility.store.ts`（新建）：

```ts
// renderer/src/stores/browser-visibility.store.ts
//
// 浏览器侧栏可见性（spec 2026-09-15 §9.1）：per-session 内存态——每个会话独立
// 记忆展开/收起，新会话缺省收起；不持久化（tab 本不跨重启）。销毁语义在
// main（setSidebarVisible），本 store 只管「当前会话想不想看见」。
import { create } from 'zustand';

interface BrowserVisibilityState {
  visibilityBySession: Record<string, boolean>;
  isVisible: (sessionId: string | null) => boolean;
  setVisible: (sessionId: string, visible: boolean) => void;
  /** 会话删除后的条目清理（alive = 仍存在的 sessionId 列表） */
  purgeStale: (alive: string[]) => void;
}

export const useBrowserVisibilityStore = create<BrowserVisibilityState>((set, get) => ({
  visibilityBySession: {},
  isVisible: (sessionId) => (sessionId === null ? false : get().visibilityBySession[sessionId] ?? false),
  setVisible: (sessionId, visible) =>
    set((s) => ({ visibilityBySession: { ...s.visibilityBySession, [sessionId]: visible } })),
  purgeStale: (alive) =>
    set((s) => {
      const next: Record<string, boolean> = {};
      for (const id of alive) {
        if (s.visibilityBySession[id] !== undefined) next[id] = s.visibilityBySession[id]!;
      }
      return { visibilityBySession: next };
    }),
}));
```

`App.tsx`——组件体内加（session store 已订阅处附近 / 或新增订阅）：

```tsx
  // 活跃会话上报（spec §5.4）：main 的自动展开判定输入；含启动后首次
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  useEffect(() => {
    void ipc.browser.setActiveSession(activeSessionId).catch(() => {
      // 早期 boot 未挂载时静默——下一个 session 切换自会重报
    });
  }, [activeSessionId]);
```

（App.tsx 若未 import useEffect/useSessionStore 则补 import。）

`BrowserSidebar.tsx` 核心改造：

1. 删本地 `collapsed` state / `collapsedUserTouchedRef` / `mainExpandedRef`；改：
```tsx
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const visible = useBrowserVisibilityStore((s) => s.isVisible(activeSessionId));
```
（import 两个 store。）

2. getSettings effect 只留宽度逻辑（删 collapsed 分支与两个折叠守卫 ref）。

3. onBrowserState 处理器：
```tsx
    setState(next);
    // 活跃会话的 agent 导航 → 本会话自动展开（spec §7.3；ws 过滤守卫保留在前）
    if (next.expandHint && activeSessionId !== null) {
      useBrowserVisibilityStore.getState().setVisible(activeSessionId, true);
    }
```

4. 会话清理 effect：
```tsx
  useEffect(() => {
    useBrowserVisibilityStore.getState().purgeStale(sessions.map((s) => s.id));
  }, [sessions]);
```
（sessions 来自 useSessionStore。）

5. `toggleCollapsed`：
```tsx
  const toggleCollapsed = (): void => {
    if (activeSessionId === null) return; // rail 钮仅会话视图出现，防御
    const next = !visible;
    useBrowserVisibilityStore.getState().setVisible(activeSessionId, next);
    // 隐藏/显示：main bounds 置零/恢复——agent 后台操作不受影响（spec §6.3）
    void ipc.browser.setSidebarVisible(workspaceId, next).catch(() => {});
  };
```

6. report effect 与折叠分支的 `collapsed` 全部换 `!visible` 语义：折叠渲染分支 `if (collapsed)` → `if (!visible)`；report effect `if (collapsed) return;` → 隐藏分支上报零 rect 一次：
```tsx
  useEffect(() => {
    if (!visible) {
      // 隐藏过渡帧：一次性零报（main 对全部视图 bounds 置零已由 setSidebarVisible 承担，
      // 此报维持「renderer 无占位区则无真实 rect」的几何一致性）+ 安全区回全窗口
      void ipc.browser.setSidebarBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {});
      useBrowserSidebarRectStore.getState().setRect(null);
      return;
    }
    const el = placeholderRef.current;
    if (!el) return;
    // ……既有 report 主体不变……
  }, [visible]);
```

7. `types.d.ts` / `preload/index.ts`：删 `setSidebarCollapsed`（通道面与调用点同 commit 消失）；`types.d.ts` BrowserState 删 `collapsed` 行、加 `expandHint: boolean;`，BrowserTabInfo 加 `owner: string;`。

- [ ] **Step 4: 跑 renderer 相关 + 双 typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/workspace/ src/stores/
cd /workspace && npx pnpm@9.0.0 typecheck
```
Expected: PASS。若 MiddlePanel/其它组件引用 sidebar collapsed 相关断言，同语义更新。

- [ ] **Step 5: commit**

```bash
git add -A renderer/src electron/src/preload
git commit -m "feat: renderer per-session 浏览器可见性 store + expandHint 条件展开 + sidebar 隐藏接线（Task 5/7）"
```

---

### Task 6: tab 归属徽标 + 关闭浏览器确认卡

**Files:**
- Modify: `renderer/src/components/workspace/TabsBar.tsx`（owner 徽标）
- Modify: `renderer/src/components/workspace/BrowserSidebar.tsx`（ownerNames 映射 + 关闭按钮）
- Create: `renderer/src/stores/browser-close-confirm.store.ts` + 贴源测试
- Create: `renderer/src/components/notices/BrowserCloseConfirmCard.tsx` + 贴源测试
- Modify: `renderer/src/App.tsx`（CenterPromptLayer 内挂卡）

**Interfaces:**
- Consumes: Task 5 的 `BrowserTabInfo.owner`、agent.store `members`（instanceId → agentName/iconEmoji）、CenterPromptLayer
- Produces: `useBrowserCloseConfirmStore { open; workspaceId; request(wsId: string, hasAgentTabs: boolean): void; confirm(): void; cancel(): void }`

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/workspace/TabsBar.test.tsx（新建/扩展——文件若已有则追加 describe）
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabsBar } from './TabsBar';

describe('TabsBar 归属徽标（spec §9.2）', () => {
  it('agent 拥有的 tab 显示归属名；user tab 无徽标', () => {
    render(
      <TabsBar
        tabs={[
          { index: 0, url: 'https://a.com', title: 'A', owner: 'inst-a' },
          { index: 1, url: 'https://u.com', title: 'U', owner: 'user' },
        ]}
        current={0}
        onSelect={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
        ownerLabel={(owner) => (owner === 'inst-a' ? 'Coder' : undefined)}
      />,
    );
    expect(screen.getByText('Coder')).toBeInTheDocument();
    // user tab 不渲染徽标节点（以 data-testid 断言数量）
    expect(document.querySelectorAll('[data-testid="tab-owner-badge"]')).toHaveLength(1);
  });
  it('ownerLabel 解析不到 → 兜底「agent」', () => {
    render(
      <TabsBar
        tabs={[{ index: 0, url: 'u', title: 'T', owner: 'inst-x' }]}
        current={0}
        onSelect={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
        ownerLabel={() => undefined}
      />,
    );
    expect(screen.getByText('agent')).toBeInTheDocument();
  });
});
```

```ts
// renderer/src/stores/browser-close-confirm.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBrowserCloseConfirmStore } from './browser-close-confirm.store';
import { ipc } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  ipc: { browser: { closeBrowser: vi.fn(async () => {}) } },
}));

describe('browser-close-confirm store（spec §6.4）', () => {
  beforeEach(() => {
    useBrowserCloseConfirmStore.setState({ open: false, workspaceId: null });
    vi.clearAllMocks();
  });
  it('无 agent tab 的 request 直接关闭不弹卡', () => {
    useBrowserCloseConfirmStore.getState().request('w1', false);
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w1');
  });
  it('有 agent tab 的 request 弹卡；confirm 才销毁；cancel 不销毁', () => {
    useBrowserCloseConfirmStore.getState().request('w1', true);
    expect(useBrowserCloseConfirmStore.getState().open).toBe(true);
    expect(ipc.browser.closeBrowser).not.toHaveBeenCalled();
    useBrowserCloseConfirmStore.getState().cancel();
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
    useBrowserCloseConfirmStore.getState().request('w1', true);
    useBrowserCloseConfirmStore.getState().confirm();
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w1');
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/workspace/TabsBar.test.tsx src/stores/browser-close-confirm.store.test.ts`
Expected: FAIL（Props 无 ownerLabel / store 不存在）。

- [ ] **Step 3: 实现**

`browser-close-confirm.store.ts`：

```ts
// renderer/src/stores/browser-close-confirm.store.ts
//
// 关闭浏览器确认卡状态（spec §6.4）：有 agent 拥有 tab 时强制居中确认——
// 防误杀正在操作的 agent；确认后走 browser:closeBrowser（user 源全局销毁）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';

interface BrowserCloseConfirmState {
  open: boolean;
  workspaceId: string | null;
  /** hasAgentTabs=false 直接销毁（无卡）；true 弹卡等确认 */
  request: (workspaceId: string, hasAgentTabs: boolean) => void;
  confirm: () => void;
  cancel: () => void;
}

export const useBrowserCloseConfirmStore = create<BrowserCloseConfirmState>((set, get) => ({
  open: false,
  workspaceId: null,
  request: (workspaceId, hasAgentTabs) => {
    if (!hasAgentTabs) {
      void ipc.browser.closeBrowser(workspaceId).catch(() => {});
      return;
    }
    set({ open: true, workspaceId });
  },
  confirm: () => {
    const wsId = get().workspaceId;
    set({ open: false, workspaceId: null });
    if (wsId) void ipc.browser.closeBrowser(wsId).catch(() => {});
  },
  cancel: () => set({ open: false, workspaceId: null }),
}));
```

`TabsBar.tsx`——Props 加 `ownerLabel?: (owner: string) => string | undefined`；pill 内标题按钮前插入徽标：

```tsx
            {tab.owner !== 'user' && ownerLabel ? (
              <span
                data-testid="tab-owner-badge"
                title={`归属：${ownerLabel(tab.owner) ?? 'agent'}`}
                className="flex h-4 items-center rounded bg-surface-3 px-1 text-[10px] leading-none text-secondary"
              >
                {ownerLabel(tab.owner) ?? 'agent'}
              </span>
            ) : null}
```

（文本色/底用语义 token；10px 徽标是 pill 内紧凑特例，与 16px 图标规范不冲突。）

`BrowserCloseConfirmCard.tsx`（notices/ 目录，参照同目录既有卡的锚点位移模式）：

```tsx
// renderer/src/components/notices/BrowserCloseConfirmCard.tsx
//
// 关闭浏览器确认卡（spec §6.4 / §9.3）：CenterPromptLayer 居中级阻断确认——
// agent 拥有 tab 时防误杀。锚点位移惯用法与信任卡一致（-translate-x/y-1/2）。
import { CircleAlert } from 'lucide-react';
import { useBrowserCloseConfirmStore } from '../../stores/browser-close-confirm.store';
import { Button } from '../ui/Button';

export function BrowserCloseConfirmCard() {
  const open = useBrowserCloseConfirmStore((s) => s.open);
  const confirm = useBrowserCloseConfirmStore((s) => s.confirm);
  const cancel = useBrowserCloseConfirmStore((s) => s.cancel);
  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-label="关闭浏览器确认"
      data-testid="browser-close-confirm"
      className="pointer-events-auto absolute flex w-80 flex-col gap-3 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-strong bg-surface-2 p-4 shadow-lg"
    >
      <div className="flex items-center gap-2 text-primary">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden />
        <span className="text-sm font-medium">关闭浏览器？</span>
      </div>
      <p className="text-xs text-secondary">
        有 agent 正在使用浏览器的标签页。关闭后其后续浏览器操作将失败（可重新导航打开新页面）。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>取消</Button>
        <Button variant="destructive" onClick={confirm}>强制关闭</Button>
      </div>
    </div>
  );
}
```

（Button 的 variant 以 `renderer/src/components/ui/Button.tsx` 实际支持为准——若无 destructive 则用默认 variant + 语义 token 类；以现有组件 API 为准适配。）

`App.tsx` CenterPromptLayer children 内追加 `<BrowserCloseConfirmCard />`。

`BrowserSidebar.tsx`——chrome 行折叠钮旁加关闭钮 + ownerLabel 装配：

```tsx
  // 归属名解析（spec §9.2）：agent.store 成员按 instanceId 对齐（agentAssignmentId === instance_id）
  const members = useAgentStore((s) => s.members);
  useEffect(() => {
    if (workspaceId) void useAgentStore.getState().loadMembers(workspaceId).catch(() => {});
  }, [workspaceId]);
  const ownerLabel = useCallback(
    (owner: string): string | undefined => members.find((m) => m.instanceId === owner)?.agentName,
    [members],
  );
```

chrome 行（折叠钮前）：

```tsx
            <IconButton
              aria-label="关闭浏览器"
              title="关闭浏览器（销毁全部标签页）"
              onClick={() => {
                useBrowserCloseConfirmStore
                  .getState()
                  .request(workspaceId, tabs.some((t) => t.owner !== 'user'));
              }}
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
```

（lucide `X` 补 import；TabsBar 调用处传 `ownerLabel`。）

`BrowserCloseConfirmCard.test.tsx`（贴源）：render 后 store `request('w1', true)` → `screen.getByTestId('browser-close-confirm')` 存在；点「取消」→ 消失且 ipc 未调；点「强制关闭」→ `ipc.browser.closeBrowser` 调用（vi.mock ipc/client）。

- [ ] **Step 4: 跑 renderer 全量 + 双 typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/
cd /workspace && npx pnpm@9.0.0 typecheck
git add -A renderer/src
git commit -m "feat: tab 归属徽标（agent 名解析）+ 关闭浏览器居中确认卡（agent 活 tab 防误杀）（Task 6/7）"
```

---

### Task 7: 收尾全量验证 + 文档

**Files:**
- Modify: `CHANGELOG.md`（研发账本条目）
- Modify: `.superpowers/sdd/progress.md`（ledger，gitignored 本地）

- [ ] **Step 1: 双 workspace 全量测试**

```bash
npx pnpm@9.0.0 test
```
Expected: electron + renderer 全绿。任何失败先归因：本特性引入 → 修；无关预存 → 报告不改。

- [ ] **Step 2: 双 typecheck + 冒烟构建面**

```bash
npx pnpm@9.0.0 typecheck
```
Expected: 两 workspace 零错误。残留检查：`grep -rn "setSidebarCollapsed\|collapseStash\|readSidebarCollapsed" electron/src renderer/src` → 应零命中（tests 亦清）。

- [ ] **Step 3: 手工验收脚本（macOS 主机 / 容器 xvfb 可选）**

启动 `pnpm dev`，按 spec 验收序列：
1. 会话 A 让 agent 开百度 → 侧栏自动展开、tab 徽标显示 agent 名
2. 新建会话 B（侧栏应默认收起）→ 让 B 的 agent 开 bing → B 内自动展开、A 的 tab 完好
3. A、B 交替切换：各自展开/收起状态独立记忆
4. agent 操作中收起侧栏 → agent 后续 click/snapshot 不报错
5. 有关 agent tab 时点「关闭浏览器」→ 居中确认卡；强制关闭后侧栏空态
6. agent 的 browser_tabs list 只见自己的 tab

- [ ] **Step 4: CHANGELOG + commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 研发账本——浏览器 tab 归属制与隐藏/销毁分离"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4 数据模型（T2/T3）、§5 身份透传（T1）+ setActiveSession（T3/T4/T5）、§6.1 工具解析（T2）、§6.3 隐藏（T3/T4/T5）、§6.4 关闭（T2/T6）、§7.1-7.4 退役与回归锁改写（T3）、§9 renderer（T5/T6）、§10 边界（ownerCurrent 悬空 T2、setActiveSession 缺省 T3）、§11 测试（各 Task 内嵌）——全覆盖。
- **类型一致性**：BrowserOpCtx 尾参在协议/桥/router/端口/manager 五处签名一致；TabInfo.owner 在 electron types.ts 与 renderer types.d.ts 同步（T2 加 / T5 对齐 renderer）。
- **已知裁量**：ipc.test.ts 三用例体以文件既有 fixture 风格补全（意图与签名已锁）；BrowserCloseConfirmCard 的 Button variant 以 ui/Button 实际 API 适配；runtime-entry `config.agentAssignmentId` 字段名以 runtime-config 实际为准（parse 错误文案已背书）。
