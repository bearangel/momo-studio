# P1-C 实施计划：工具调用计数聚合（D4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 气泡的工具调用计数 = 本流全族（含 `#roll` 换行族）+ 子链求和 + 在途子任务数，流式与终态均可见；roll 后不再归零。

**Architecture:** 纯 renderer——新 lib helper 按 base ssi 分族求和（数据全在 `messagesBySession` + streams Map），AgentStreamBubble 状态行消费；无 IPC、无 DB 变更。可与 P0-B 并行。

**Tech Stack:** React + zustand（既有 stores）+ vitest。

**Spec:** `docs/specs/2026-10-13-dispatch-receipt-and-interrupt-cascade-design.md`（§8 D4）

## Global Constraints

- 同 P0-A（strict TS / 中文注释 / renderer 单测贴源 colocated / 语义 token / Conventional Commits / 不动版本号）
- 历史行事件被裁剪时计数**如实降级**（显示可见值，不伪造合计——test 规则 3）

## Review Focus

1. **roll 族归零回归**（spring-mcp 实测 bb683fbe 回合 95+6+70 三行各数各的）→ 族合计不归零——Task C1/C2 测试
2. **子链行事件未聚合**（streams 无条目，如重启裁剪后）→ 子链计数按 0 计并照常显示，不抛错——Task C1 测试
3. **`#seg` 分段行双计**（segmentOf 非空行是 body 快照，事件挂父行）→ 分段行排除在求和面外——Task C1 测试
4. **孙代子链**（子 agent 再 dispatch 孙 agent，parent 指向子流而非 PM 流）→ 不计入 PM 气泡子链数（口径=直接子链；孙代在子 chip 内自见）——Task C1 测试
5. **终态计数消失回归**（现状完成后计数直接不显示）→ 终态保留摘要——Task C2 测试

---

### Task C1: 流族聚合 helper

**Files:**
- Create: `renderer/src/lib/stream-family.ts` + `.test.ts`

**Interfaces:**
- Consumes: `ImMessage`（`streamSessionId` / `parentStreamSessionId` / `segmentOf`）、`streams: Map<string, { toolCalls: unknown[] }>`（StreamState 子集）
- Produces:

```ts
export function baseSsi(streamSessionId: string): string;
export function countFamilyToolCalls(
  messages: ImMessage[],
  streams: Map<string, { toolCalls: unknown[] }>,
  ownStreamSessionId: string,
): { own: number; sub: number };
```

- [ ] **Step 1: 失败测试（五个 Review Focus 全覆盖）**

```ts
// renderer/src/lib/stream-family.test.ts
import { describe, expect, it } from 'vitest';
import { baseSsi, countFamilyToolCalls } from './stream-family';
import type { ImMessage } from '../ipc/types';

const mk = (id: string, ssi: string | null, parent: string | null, seg: string | null = null): ImMessage =>
  ({ id, sessionId: 's', sender: 'agent-a', eventType: 'm.room.message', body: '', streamSessionId: ssi, parentStreamSessionId: parent, segmentOf: seg, status: 'done', taskId: null, createdAt: 0, workspaceId: null }) as unknown as ImMessage;
const streams = (entries: Array<[string, number]>) => new Map(entries.map(([id, n]) => [id, { toolCalls: new Array(n) }]));

describe('countFamilyToolCalls（spec §8.1 口径）', () => {
  it('own = base ssi 全族（含 roll 行）toolCalls 之和——roll 不归零', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('a2', 'ssi-1#roll1', null)];
    expect(countFamilyToolCalls(msgs, streams([['a1', 95], ['a2', 76]]), 'ssi-1').own).toBe(171);
  });
  it('sub = 直接子链行之和；子链无 streams 条目按 0 计不抛错', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('c1', 'ssi-sub', 'ssi-1'), mk('c2', 'ssi-sub2', 'ssi-1#roll1')];
    const r = countFamilyToolCalls(msgs, streams([['a1', 10], ['c1', 32]]), 'ssi-1');
    expect(r.sub).toBe(32); // c2 无条目 → 0
  });
  it('#seg 分段行排除（事件挂父行，防双计）', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('seg1', 'ssi-1#seg1', null, 'a1')];
    expect(countFamilyToolCalls(msgs, streams([['a1', 8], ['seg1', 99]]), 'ssi-1').own).toBe(8);
  });
  it('孙代（parent=子流）不计入 PM 子链', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('c1', 'ssi-sub', 'ssi-1'), mk('g1', 'ssi-gc', 'ssi-sub')];
    expect(countFamilyToolCalls(msgs, streams([['a1', 4], ['c1', 5], ['g1', 6]]), 'ssi-1').sub).toBe(5);
  });
});
describe('baseSsi', () => { it('剥 # 后缀', () => { expect(baseSsi('ssi-1#roll2')).toBe('ssi-1'); }); });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/stream-family.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// renderer/src/lib/stream-family.ts
//
// 流族工具调用计数（spec 2026-10-13 §8.1）：own = base ssi 全族（含 #roll 换行行）
// 的 toolCalls 之和；sub = 直接子链（parentStreamSessionId ∈ 本族）之和。
// #seg 分段行是 body 快照（事件挂父行）——排除防双计。streams 无条目的行按 0 计
// （历史裁剪降级，不伪造合计）。
import type { ImMessage } from '../ipc/types';

export function baseSsi(streamSessionId: string): string {
  return streamSessionId.split('#')[0]!;
}

export function countFamilyToolCalls(
  messages: ImMessage[],
  streams: Map<string, { toolCalls: unknown[] }>,
  ownStreamSessionId: string,
): { own: number; sub: number } {
  const ownBase = baseSsi(ownStreamSessionId);
  const ownBases = new Set([ownBase]);
  // roll 族成员先收集（族 = base 相同的流行），子链归属也按族判定
  for (const m of messages) {
    if (m.segmentOf !== null) continue;
    if (m.parentStreamSessionId !== null) continue;
    if (m.streamSessionId !== null && baseSsi(m.streamSessionId) === ownBase) ownBases.add(baseSsi(m.streamSessionId));
  }
  const inFamily = (ssi: string | null): boolean => ssi !== null && ownBases.has(baseSsi(ssi));
  const countOf = (id: string): number => streams.get(id)?.toolCalls.length ?? 0;

  let own = 0;
  let sub = 0;
  for (const m of messages) {
    if (m.segmentOf !== null) continue; // 分段行快照，防双计
    if (m.parentStreamSessionId === null) {
      if (inFamily(m.streamSessionId)) own += countOf(m.id);
    } else if (inFamily(m.parentStreamSessionId)) {
      sub += countOf(m.id); // 直接子链（孙代 parent=子流，不属本族）
    }
  }
  return { own, sub };
}
```

- [ ] **Step 4: 通过 + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/stream-family.test.ts` → PASS

```bash
git add renderer/src/lib/stream-family.ts renderer/src/lib/stream-family.test.ts
git commit -m "feat: 流族工具调用计数聚合 helper（roll 族合并 + 子链求和）"
```

---

### Task C2: AgentStreamBubble 计数接线

**Files:**
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx:137-138, 231-235, 241-256`
- Modify: `renderer/src/components/im/AgentStreamBubble.test.tsx`

**Interfaces:**
- Consumes: `countFamilyToolCalls`（Task C1）、既有 `streamIdToMessageId` 反查表与 `dispatchTotal/dispatchCompleted`

- [ ] **Step 1: 失败测试**

AgentStreamBubble.test.tsx 追加（沿既有 renderWith 测试基建）：

```tsx
it('流式态计数含子链与在途数（spec §8.2）：own 95 + sub 116 + 3 在途', () => {
  // 构造：PM 流行（toolCalls 95）+ 3 条子行（32/30/54，其中 1 条终态）
  // 断言状态行文案：/处理中 · 已调用工具 95 次（含子链 116）· 2 个子任务在途/
});
it('终态保留计数摘要：完成后仍显示 工具 N 次（含子链 M）', () => {
  // 终态流（status:'done'）断言状态行区域出现 /工具 \d+ 次（含子链 \d+）/
});
```

- [ ] **Step 2: 实现**

组件内（`streamIdToMessageId` 构建之后）：

```tsx
  // spec §8：族计数——own 含 roll 族，sub 为直接子链求和（裁剪行如实降级 0）
  const familyCount = useMemo(
    () => (message.streamSessionId
      ? countFamilyToolCalls(sessionMessages ?? [], rawStreams, message.streamSessionId)
      : { own: 0, sub: 0 }),
    [sessionMessages, message.streamSessionId],
  );
  const inFlightSubs = dispatchTotal - dispatchCompleted;
  const streamingLabel =
    familyCount.own + familyCount.sub > 0
      ? `处理中 · 已调用工具 ${familyCount.own} 次（含子链 ${familyCount.sub}）`
        + (inFlightSubs > 0 ? ` · ${inFlightSubs} 个子任务在途` : '')
      : '处理中';
```

（`rawStreams` 取本组件已有的 streams Map 访问面——`useStreamStore.getState().streams` 或既有 selector；终态摘要行加在状态徽标后：`{!isStreaming && (familyCount.own + familyCount.sub > 0) && <span className="text-tertiary">工具 {familyCount.own} 次（含子链 {familyCount.sub}）</span>}`。）

- [ ] **Step 3: 通过 + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/AgentStreamBubble.test.tsx` → PASS

```bash
git add renderer/src/components/im/AgentStreamBubble.tsx renderer/src/components/im/AgentStreamBubble.test.tsx
git commit -m "feat: 气泡计数聚合本流族+子链，终态保留摘要"
```

---

### Task C3: 全量验证

- [ ] **Step 1**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 --filter momo-studio-renderer test
```

Expected: 全绿

- [ ] **Step 2: Commit（如有测试修缮）**

```bash
git add -A && git commit -m "test: 计数聚合全量验证"
```
