# P0-B 实施计划：三级中断级联（D3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户停止 PM 回合时级联取消该回合派生的全部在途链并抑制后续唤醒；DispatchChip 可单链停止；会话级一键全停；子 agent 流中断失效断点经插桩复现修复。

**Architecture:** registry 补 `cancelByPmStream` / `cancelBySession` / `listInFlight`；RouterService 新增 `abortTurn` / `stopAll` / `cancelChain`（执行序：先 cancel 链再 abort 流——迟到回执落 cancelled 幂等忽略）；4 条新 IPC 通道（renderer ↔ main）；链级取消按 `subStreamSessionId` 反查 registry，零协议透传改动。依赖 P0-A 的 registry 扩展形态。

**Tech Stack:** 同 P0-A。依赖：`docs/plans/2026-10-13-dispatch-receipt-p0a.md` 已合入。

**Spec:** `docs/specs/2026-10-13-dispatch-receipt-and-interrupt-cascade-design.md`（§7 D3）

## Global Constraints

- 同 P0-A（Node 20 / strict TS / 中文注释 / 测试位置 / 双 typecheck / Conventional Commits / 不动版本号）
- IPC 新通道必须 preload + `renderer/src/ipc/types.d.ts` 双端成对（boundary 规则 4）；先写通道形状契约测试
- T0 调查任务**先复现后修复**（momo-debug-rules 规则 1）；三假设命中哪个修哪个，禁止盲改

## Review Focus

1. **车道空闲时点停止**（PM 流已结束/未启动）→ abortTurn 幂等 no-op 不抛错——Task B3 测试
2. **链已终态再取消** → cancel 幂等（registry.cancel 返回 undefined 路径）——Task B1 测试
3. **subStreamSessionId 未注册的链**（旧链/被驱逐）→ cancelChain 查无目标时如实返回 not_found，UI toast 不静默——Task B3/B5 测试
4. **停止后迟到回执** → settle 落 cancelled 链被幂等忽略，不唤醒不投递——Task B3 集成断言
5. **会话级停止清空 pendingDeliveries** → 排队中的回执不再于下一 idle 边沿投递——Task B3 测试

---

### Task B0: T0 插桩复现——子 agent 中断失效断点

**Files:**
- Create: `electron/tests/agent/interrupt-cascade-e2e.test.ts`（L2 复现 harness，后续任务复用为回归锁）
- Create: `docs/plans/2026-10-13-t0-findings.md`（判定记录——三假设裁决 + 证据日志摘录）

**Interfaces:**
- Produces: 回归测试 `中止 PM 后子流 ≤2s aborted`（红）；T0 结论驱动 Task B3/B6 的修复分支选择

- [ ] **Step 1: 写复现测试（先红——spring-mcp 22 分钟病理的实验室版）**

```ts
// electron/tests/agent/interrupt-cascade-e2e.test.ts
//
// T0 复现（spec §7.4）：PM 派发子 agent → 子流 executing → abort PM 流
// → 断言子流 ≤2s 内 aborted。三假设（H1 ssi 断链 / H2 loop 不查 abort / H3 bg 派发）
// 由本测试 + trace 日志裁决。复用 orchestration-e2e 的 seed 基建（真实 runner + 真实桥）。
```

测试体（复用 orchestration-e2e.test.ts 的 runner/bridge 构造方式）：

```ts
it('T0：中止 PM 流后子 agent 流应 ≤2s aborted（spec §11.3-11）', async () => {
  // 1. seed：PM runner + 子 agent runner（ WarmPool 真实子进程或该文件既有 fake child 形态，
  //    若用 fake child 必须仿真 abort 消息处理——test 规则 1：mock 仿真真实运行时语义）
  // 2. PM 流进入 executeDispatch 等待（真实 dispatch-wait）→ 链 in_flight
  // 3. abortStreamBySessionId(pmStreamSessionId)
  // 4. await vi.waitFor(() => expect(子流状态).toBe('aborted'), { timeout: 2000 })
}, 10_000);
```

- [ ] **Step 2: 跑测试，记录命中假设**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/interrupt-cascade-e2e.test.ts`

按观察裁决并写入 `docs/plans/2026-10-13-t0-findings.md`：

- 子进程收到 `{type:'abort'}` 且 abortDispatch 广播到达（加临时 trace 日志验证）但流不停 → **H2**：chat loop 只取消 LLM fetch，工具循环不检查。修法：runtime chat loop 每次工具执行前检查 abort 标志（runtime-entry doExecuteTool 循环处，`if (abortController.signal.aborted) break;`）——落在 Task B3 完成后的本文件 Step 4。
- 广播到达但 runner.activeTasks 键不匹配 subStreamSessionId → **H1**：routeDispatch 侧 ID 回收再生成。修法：核对 routeDispatch 使用 dispatch content 的 `sub_stream_session_id` 原值（禁止 `randomUUID()` 覆写），修 ID 透传断点。
- PM 用 dispatch_bg（无 sync 等待）→ **H3**：PM abort 天然不触达——由 Task B3 的显式级联覆盖（cancelByPmStream + abort_dispatch 广播），无子进程改动。

- [ ] **Step 3: Commit（测试 + 判定记录，此时测试可带 `.fails` 标注或 skip 守卫注明等待修复分支）**

```bash
git add electron/tests/agent/interrupt-cascade-e2e.test.ts docs/plans/2026-10-13-t0-findings.md
git commit -m "test: T0 子流中断失效复现 harness 与三假设判定记录"
```

---

### Task B1: registry 级联原语

**Files:**
- Modify: `electron/src/main/agent/dispatch-registry.ts`
- Modify: `electron/tests/agent/dispatch-registry.test.ts`

**Interfaces:**
- Produces:
  - `cancelByPmStream(pmStreamSessionId: string): string[]`（被取消 taskId 清单）
  - `cancelBySession(sessionId: string): string[]`
  - `listInFlight(sessionId?: string): InFlightChain[]`，`InFlightChain = { taskId: string; round: number; sessionId: string; pmAssignmentId: string; subAssignmentId: string; subStreamSessionId?: string; pmStreamSessionId?: string; startedAt: number }`
  - `findBySubStream(subStreamSessionId: string): DispatchChainHandle | undefined`

- [ ] **Step 1: 失败测试（四个原语 + 幂等/过滤语义）**

```ts
it('cancelByPmStream：取消该 PM 流派生的全部在途链，返回清单；跨流/终态链不动', () => {
  registry.register({ taskId: 't-a', pmAssignmentId: 'pm', subAssignmentId: 'sub1', sessionId: 's1', isFollowupRound: false, pmStreamSessionId: 'pm-ssi-1' });
  registry.register({ taskId: 't-b', pmAssignmentId: 'pm', subAssignmentId: 'sub2', sessionId: 's1', isFollowupRound: false, pmStreamSessionId: 'pm-ssi-2' });
  expect(registry.cancelByPmStream('pm-ssi-1')).toEqual(['t-a']);
  expect(registry.get('t-a')?.status).toBe('cancelled');
  expect(registry.get('t-b')?.status).toBe('in_flight'); // 跨流不动
});
it('cancelBySession / listInFlight 过滤 / findBySubStream 反查', () => { /* 同构断言：session 维度取消；listInFlight 只列 in_flight 可选按 session 过滤；findBySubStream 命中与未命中 */ });
```

- [ ] **Step 2: 实现（cancel 邻近位置，语义照 cancel：cancelled 恒不投递）**

```ts
  /** 回合级级联（spec §7.3）：取消某 PM 流派生的全部在途链，返回 taskId 清单 */
  cancelByPmStream(pmStreamSessionId: string): string[] {
    const out: string[] = [];
    for (const h of this.chains.values()) {
      if (h.pmStreamSessionId !== pmStreamSessionId || h.status !== 'in_flight') continue;
      h.status = 'cancelled';
      h.completedAt = this.nowFn();
      out.push(h.taskId);
    }
    if (out.length > 0) this.enforceSettledCap();
    return out;
  }

  /** 会话级级联（spec §7.5）：取消该会话全部在途链 */
  cancelBySession(sessionId: string): string[] { /* 同构：h.sessionId === sessionId && in_flight */ }

  /** 按 subStreamSessionId 反查链（链级取消入口——renderer 只有该键，spec §7.6） */
  findBySubStream(subStreamSessionId: string): DispatchChainHandle | undefined {
    for (const h of this.chains.values()) {
      if (h.subStreamSessionId === subStreamSessionId) return h;
    }
    return undefined;
  }

  /** 在途链视图（在途面板 / 回合级联预检，spec §9） */
  listInFlight(sessionId?: string): InFlightChain[] {
    const out: InFlightChain[] = [];
    for (const h of this.chains.values()) {
      if (h.status !== 'in_flight') continue;
      if (sessionId !== undefined && h.sessionId !== sessionId) continue;
      out.push({ taskId: h.taskId, round: h.round, sessionId: h.sessionId, pmAssignmentId: h.pmAssignmentId, subAssignmentId: h.subAssignmentId, ...(h.subStreamSessionId !== undefined ? { subStreamSessionId: h.subStreamSessionId } : {}), ...(h.pmStreamSessionId !== undefined ? { pmStreamSessionId: h.pmStreamSessionId } : {}), startedAt: h.startedAt });
    }
    return out;
  }
```

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-registry.test.ts` → PASS

```bash
git add electron/src/main/agent/dispatch-registry.ts electron/tests/agent/dispatch-registry.test.ts
git commit -m "feat: registry 级联原语 cancelByPmStream/cancelBySession/listInFlight/findBySubStream"
```

---

### Task B2: 四条新 IPC 通道（双端契约先行）

**Files:**
- Create: `electron/src/main/agent/interrupt-ipc.ts`
- Modify: `electron/src/main/ipc/index.ts`（注册处，照 registerStreamIpc 挂载模式）
- Modify: `electron/src/preload/index.ts`
- Modify: `renderer/src/ipc/types.d.ts`
- Create: `electron/tests/agent/interrupt-ipc.test.ts`

**Interfaces:**
- Produces（通道面，与 types.d.ts 逐字对齐）:
  - `agent:abortTurn` `{ sessionId: string } → { stoppedStream: boolean }`
  - `session:stopAll` `{ sessionId: string } → { stoppedStreams: number; cancelledChains: number }`
  - `dispatch:cancelChain` `{ taskId?: string; subStreamSessionId?: string } → { status: 'cancelled' | 'not_found' }`
  - `dispatch:listInFlight` `{ sessionId?: string } → InFlightChainView[]`（InFlightChain + `subAgentName: string | null`）
  - renderer 侧 `ipc.agent.abortTurn(sessionId)` / `ipc.session.stopAll(sessionId)` / `ipc.dispatch.cancelChain(arg)` / `ipc.dispatch.listInFlight(arg)`

- [ ] **Step 1: 契约失败测试（通道注册 + 载荷校验 + 双端形状）**

```ts
// electron/tests/agent/interrupt-ipc.test.ts
// ipcMain.handle mock 收窄在 IPC 边界（test 规则 5）；断言：四通道注册名精确；
// abortTurn 载荷缺 sessionId 抛错；cancelChain 双键全缺抛错；listInFlight 非法 sessionId 类型抛错。
```

- [ ] **Step 2: 实现主进程侧**

```ts
// electron/src/main/agent/interrupt-ipc.ts
//
// 三级中断 IPC（spec §7.2）：回合级 / 会话级 / 链级 + 在途查询。
// 通道面与 renderer/src/ipc/types.d.ts 逐字对齐（boundary 规则 4）。
import { ipcMain } from 'electron';
import { logger } from '../logger';

export function registerInterruptIpc(deps: {
  abortTurn: (sessionId: string) => { stoppedStream: boolean };
  stopAll: (sessionId: string) => { stoppedStreams: number; cancelledChains: number };
  cancelChain: (arg: { taskId?: string; subStreamSessionId?: string }) => { status: string };
  listInFlight: (sessionId?: string) => Array<Record<string, unknown>>;
}): void {
  ipcMain.handle('agent:abortTurn', (_e, arg: unknown) => {
    const a = arg as { sessionId?: unknown };
    if (typeof a.sessionId !== 'string' || a.sessionId === '') throw new Error('sessionId 非法');
    return deps.abortTurn(a.sessionId);
  });
  ipcMain.handle('session:stopAll', (_e, arg: unknown) => {
    const a = arg as { sessionId?: unknown };
    if (typeof a.sessionId !== 'string' || a.sessionId === '') throw new Error('sessionId 非法');
    return deps.stopAll(a.sessionId);
  });
  ipcMain.handle('dispatch:cancelChain', (_e, arg: unknown) => {
    const a = arg as { taskId?: unknown; subStreamSessionId?: unknown };
    if (typeof a.taskId !== 'string' && typeof a.subStreamSessionId !== 'string') {
      throw new Error('taskId 与 subStreamSessionId 至少一项');
    }
    return deps.cancelChain({ ...(typeof a.taskId === 'string' ? { taskId: a.taskId } : {}), ...(typeof a.subStreamSessionId === 'string' ? { subStreamSessionId: a.subStreamSessionId } : {}) });
  });
  ipcMain.handle('dispatch:listInFlight', (_e, arg: unknown) => {
    const a = (arg ?? {}) as { sessionId?: unknown };
    if (a.sessionId !== undefined && typeof a.sessionId !== 'string') throw new Error('sessionId 非法');
    return deps.listInFlight(typeof a.sessionId === 'string' ? a.sessionId : undefined);
  });
  logger.info('Interrupt IPC handlers 已注册');
}
```

preload 与 types.d.ts 按 `agent:abortStream` 既有邻居形态逐字补齐（`abortTurn`/`stopAll`/`cancelChain`/`listInFlight` 四面 + `InFlightChainView` 类型）。

- [ ] **Step 3: 通过 + 双 typecheck + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/interrupt-ipc.test.ts`；`npx pnpm@9.0.0 typecheck`

```bash
git add electron/src/main/agent/interrupt-ipc.ts electron/src/main/ipc/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/agent/interrupt-ipc.test.ts
git commit -m "feat: 三级中断四通道 IPC（agent:abortTurn / session:stopAll / dispatch:cancelChain / dispatch:listInFlight）"
```

---

### Task B3: RouterService 级联实现（执行序核心）

**Files:**
- Modify: `electron/src/main/agent/router-service.ts`（abortTurn / stopAll / cancelChain 三个 public 方法）
- Modify: `electron/src/main/agent/session-lane.ts`（如 getLane 未导出所需字段则补导出；先读确认）
- Modify: `electron/tests/agent/interrupt-cascade-e2e.test.ts`（B0 文件升级为回归锁）

**Interfaces:**
- Consumes: Task B1 原语、`routeAbortDispatch`（既有）、`abortStreamBySessionId`（既有）、`abortTasksBySession`（既有 AgentRunner 方法）
- Produces: `abortTurn(sessionId): { stoppedStream: boolean }`、`stopAll(sessionId): { stoppedStreams: number; cancelledChains: number }`、`cancelChain(arg): { status: 'cancelled' | 'not_found' }`（Task B2 deps 注入）

- [ ] **Step 1: 失败测试（三方法 + 幂等 + 迟到回执 + pendingDeliveries 清空）**

interrupt-cascade-e2e.test.ts 追加：

```ts
it('abortTurn：先 cancel 本回合链再 abort PM 流——零补投零新唤醒（spec §7.3 / §11.3-11）', async () => {
  // seed：车道占用 pm-ssi-1，链 t-a(pmStreamSessionId=pm-ssi-1, in_flight)，历史老链 t-old(done,!delivered)
  const r = svc.abortTurn('sess-1');
  expect(r.stoppedStream).toBe(true);
  expect(registry.get('t-a')?.status).toBe('cancelled');
  // PM forcedExit 后：老链不补投（窗口）+ cancelled 链迟到 settle 被忽略 → routeUserChat 零调用
});
it('abortTurn 车道空闲 → 幂等 no-op', () => { expect(svc.abortTurn('sess-empty')).toEqual({ stoppedStream: false }); });
it('stopAll：全部流 aborted + 全链 cancelled + pendingDeliveries 清空', () => { /* 断言三清单 */ });
it('cancelChain(subStreamSessionId) → registry cancelled + abort_dispatch 广播；查无 → not_found', () => { /* 双分支 */ });
```

- [ ] **Step 2: 实现（执行序注释即契约）**

```ts
  /**
   * 回合级中断（spec §7.3，IPC agent:abortTurn）。
   * 执行序关键——先断链再断流：链先转 cancelled，PM 流 abort 后的 forcedExit 补投
   * 与迟到 task_reply（settle 幂等忽略）双路全部落空，杜绝「停止触发新唤醒」。
   */
  abortTurn(sessionId: string): { stoppedStream: boolean } {
    const lane = getLane(sessionId);
    if (!lane) return { stoppedStream: false };
    for (const taskId of dispatchRegistry.cancelByPmStream(lane.streamSessionId)) {
      const h = dispatchRegistry.get(taskId);
      if (h?.subStreamSessionId) this.broadcastAbortDispatch(taskId, h.subStreamSessionId);
    }
    const stopped = abortStreamBySessionId(lane.streamSessionId);
    logger.info('abortTurn 完成', { sessionId, stoppedStream: stopped });
    return { stoppedStream: stopped };
  }

  /** 会话级急停（spec §7.5，IPC session:stopAll）：全部流 + 全链 + 待投递队列 */
  stopAll(sessionId: string): { stoppedStreams: number; cancelledChains: number } {
    const cancelled = dispatchRegistry.cancelBySession(sessionId);
    for (const taskId of cancelled) {
      const h = dispatchRegistry.get(taskId);
      if (h?.subStreamSessionId) this.broadcastAbortDispatch(taskId, h.subStreamSessionId);
    }
    let stoppedStreams = 0;
    for (const runner of this.opts.runners.values()) {
      if (runner.abortTasksBySession(sessionId)) stoppedStreams += 1;
    }
    this.pendingDeliveries.clear(); // 排队回执不再于下一 idle 边沿投递
    logger.info('stopAll 完成', { sessionId, stoppedStreams, cancelledChains: cancelled.length });
    return { stoppedStreams, cancelledChains: cancelled.length };
  }

  /** 链级取消（spec §7.6，IPC dispatch:cancelChain）——renderer 只持 subStreamSessionId */
  cancelChain(arg: { taskId?: string; subStreamSessionId?: string }): { status: 'cancelled' | 'not_found' } {
    const chain = arg.taskId !== undefined
      ? dispatchRegistry.get(arg.taskId)
      : arg.subStreamSessionId !== undefined
        ? dispatchRegistry.findBySubStream(arg.subStreamSessionId)
        : undefined;
    if (!chain || chain.status !== 'in_flight') return { status: 'not_found' };
    dispatchRegistry.cancel(chain.taskId);
    if (chain.subStreamSessionId) this.broadcastAbortDispatch(chain.taskId, chain.subStreamSessionId);
    return { status: 'cancelled' };
  }

  /** abort_dispatch 广播抽取（routeAbortDispatch 的事件无关内核，两处共用） */
  private broadcastAbortDispatch(taskId: string, subStreamSessionId: string): void {
    for (const runner of this.opts.runners.values()) runner.abortStream(subStreamSessionId);
    logger.info('abort_dispatch 已广播（级联）', { taskId, subStreamSessionId });
  }
```

（`routeAbortDispatch` 保留事件路由壳，内部改调 `broadcastAbortDispatch` 消重。）

- [ ] **Step 3: 按 T0 结论补分支修复**

- H1 命中：修 routeDispatch ID 透传（沿用 dispatch content `sub_stream_session_id` 原值，删本地 `randomUUID()` 覆写）。
- H2 命中：runtime-entry chat loop 每轮工具执行前 `if (abortController.signal.aborted) break;`（变量名以现场为准——doExecuteTool 循环处）。
- H3 命中：无子进程改动（级联已覆盖），在 t0-findings.md 记录闭环。

- [ ] **Step 4: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/interrupt-cascade-e2e.test.ts` → PASS

```bash
git add electron/src/main/agent/router-service.ts electron/src/main/agent/session-lane.ts electron/tests/agent/interrupt-cascade-e2e.test.ts docs/plans/2026-10-13-t0-findings.md
git commit -m "feat: 三级中断级联——先断链再断流，停止不再触发新唤醒"
```

---

### Task B4: BubbleToolbar 停止按钮升级

**Files:**
- Modify: `renderer/src/components/im/BubbleToolbar.tsx:33`
- Modify: 同目录测试（若有 BubbleToolbar.test.tsx 则追加）

**Interfaces:**
- Consumes: `ipc.agent.abortTurn(sessionId)`（Task B2）

- [ ] **Step 1: 失败测试**：isStreaming 时点击停止 → 调 `ipc.agent.abortTurn` 且参数为 `message.sessionId`（不再传 streamSessionId）。
- [ ] **Step 2: 实现**

```tsx
            void ipc.agent.abortTurn(message.sessionId); // spec §7.1：回合级级联（含本回合子链）
```

- [ ] **Step 3: 通过 + 双 typecheck + Commit**

```bash
git add renderer/src/components/im/BubbleToolbar.tsx
git commit -m "feat: 气泡停止升级回合级级联 abortTurn"
```

---

### Task B5: DispatchChip 链级停止按钮

**Files:**
- Modify: `renderer/src/components/im/DispatchChip.tsx`
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx`（DispatchSegment 透传取消回调）
- Modify: 对应测试

**Interfaces:**
- Consumes: `ipc.dispatch.cancelChain({ subStreamSessionId })`（Task B2）；segment 既有 `subStreamSessionId` 字段（聚合器已产，无协议改动）

- [ ] **Step 1: 失败测试**：executing 态 chip 渲染停止按钮；点击 → `cancelChain({ subStreamSessionId })` 且 chip 乐观置 aborted；返回 not_found → toast『子任务已结束』。
- [ ] **Step 2: 实现**：DispatchChip 头部按钮区（计时器后）加：

```tsx
        {isBusy && (
          <button
            type="button"
            aria-label={`停止 ${child.subAgentName} 的子任务`}
            className="ml-1 inline-flex cursor-pointer items-center text-tertiary hover:text-status-error"
            onClick={async (e) => {
              e.stopPropagation(); // 不触发 chip 展开
              const r = await ipc.dispatch.cancelChain({ subStreamSessionId: child.subStreamSessionId });
              if (r.status === 'not_found') showToast('子任务已结束');
            }}
          >
            <Square size={11} strokeWidth={1.75} aria-hidden />
          </button>
        )}
```

（DispatchSegment 经 props 传入的取消逻辑不变——子 agent 名 / 状态映射照旧。）

- [ ] **Step 3: 通过 + Commit**

```bash
git add renderer/src/components/im/DispatchChip.tsx renderer/src/components/im/AgentStreamBubble.tsx
git commit -m "feat: DispatchChip 链级停止按钮（cancelChain by subStreamSessionId）"
```

---

### Task B6: 集成回归 + 全量验证

**Files:** 无新增——验收任务

- [ ] **Step 1: spec §11.3 全清单核对**

逐条跑：11 回合级 / 12 链级 / 13 会话级 / 14 T0 复现锁（B0 测试已绿）/ 15 错误路径（车道空 / runner 缺失 / 链终态）。

- [ ] **Step 2: 全量验证**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
```

- [ ] **Step 3: Commit（若全量验证暴露本计划引入的修复）**

```bash
git add -A && git commit -m "test: 三级中断集成回归全绿"
```
