# steer 注入消息滚动实施计划（message roll，v2.3.1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** steer 注入时在流内滚动换行——当前消息行定格（done），新消息行承接后续输出（streaming），补充消息自然位于两气泡之间。

**Architecture:** 子进程 drain 到 steer 且有新文本时发 `message_roll` chunk；主进程 stream-relay 把旧行终态化（聚合回写 + final 事件）并 INSERT 新行（`#roll{n}` 后缀 + `streamMessageIdCache` 换指向），后续 chunk 零改动自动落新行；renderer 零改动（新行按 message.id 自动渲染新流式气泡）。

**Tech Stack:** Electron 主进程（CommonJS）+ better-sqlite3 + vitest。

**Spec:** `docs/specs/2026-09-08-steer-message-roll-design.md`（唯一上游依据）

## Global Constraints

- Node 20 LTS：容器内先 `nvm use 20`；pnpm 用 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`
- 注释与文档全中文；标识符英文
- 测试位置：electron 单测集中 `electron/tests/`（镜像 src 结构）；import 路径 tests/ 下用 `../../src/...`
- 涉及 chunk 线协议（子进程→主进程）：T1 后跑 `npx pnpm@9.0.0 typecheck` 双 workspace
- Conventional Commits
- 测试命令模板：`cd electron && npx pnpm@9.0.0 vitest run tests/<路径>`

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `electron/src/main/agent/stream-chunk.ts` | 修改 | StreamChunk 联合类型新增 `message_roll` 成员 |
| `electron/src/main/agent/runtime-spawner.ts:202` | 修改 | chunk 类型转发白名单加 `'message_roll'`（不加则 chunk 到不了 stream-relay） |
| `electron/src/main/agent/stream-relay.ts` | 修改 | roll 计数 Map + `message_roll` handler（旧行终态化 + 新行插入 + cache 换指向） |
| `electron/src/main/agent/runtime-entry.ts` | 修改 | `hasNewTextSinceLastRoll` 标志 + drain 时 emit roll |
| `electron/tests/agent/stream-relay-roll.test.ts` | **新建** | roll handler 全行为 |
| `electron/tests/agent/runtime-entry-steer.test.ts` | 修改 | roll emit 触发/抑制断言 |

---

### Task 1: message_roll chunk 类型 + stream-relay roll handler

**Files:**
- Modify: `electron/src/main/agent/stream-chunk.ts`（联合类型末尾，segment_boundary 成员后）
- Modify: `electron/src/main/agent/runtime-spawner.ts:202`（白名单数组）
- Modify: `electron/src/main/agent/stream-relay.ts`（roll 计数 + handler）
- Test: `electron/tests/agent/stream-relay-roll.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `resolveMessageId` / `streamMessageIdCache` / `clearStreamSessionCache` / `aggregateTextDeltas` / `updateMessageStatus` / `getMessage` / `pushSessionMessage` / `insertMessage` / `getEventBuffer`（全部 stream-relay.ts 内既有件）
- Produces（T2 依赖）: `StreamChunk` 含 `{ type: 'message_roll'; streamSessionId: string }`；主进程 roll 后 `streamMessageIdCache` 指向新行；`__rollCountsForTest` 清理函数（测试隔离用）

- [ ] **Step 1: 写失败测试**

先读 `electron/tests/agent/stream-relay.test.ts` 开头 60 行，复用其 DB harness（AP_USER_DATA_DIR + runMigrations + seed 消息行的既有模式）。新建 `electron/tests/agent/stream-relay-roll.test.ts`：

```typescript
// message_roll handler（v2.3.1 spec §2.3）：旧行终态化 + 新行承接 + cache 换指向
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// ……harness（tmpRoot / beforeEach / afterEach）照抄 stream-relay.test.ts 既有模式……
import { routeChunkToBuffer } from '../../src/main/agent/stream-relay';
import { __flushEventBufferForTest } from '../../src/main/agent/stream-relay';
import { getMessage, listMessagesBySession } from '../../src/main/storage/messages/repo';

/** 快捷：start 一条流并产 N 个 text delta */
function seedStreamingSession(streamSessionId: string, texts: string[]): void {
  routeChunkToBuffer({ type: 'start', streamSessionId, sessionId: 's1', senderAgentId: 'agent-x' });
  for (const t of texts) {
    routeChunkToBuffer({ type: 'text', streamSessionId, delta: t });
  }
}

describe('routeChunkToBuffer message_roll', () => {
  it('roll：旧行 done + body 聚合回写，新行 streaming 插入且 streamSessionId 带 #roll1 后缀', () => {
    seedStreamingSession('ss-r', ['第一段', '内容']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    const old = rows.find((m) => m.streamSessionId === 'ss-r')!;
    const next = rows.find((m) => m.streamSessionId === 'ss-r#roll1')!;
    expect(old.status).toBe('done');
    expect(old.body).toBe('第一段内容');          // text_delta 聚合回写
    expect(next.status).toBe('streaming');
    expect(next.segmentOf).toBeNull();            // 不是 segment 行——正常渲染
  });

  it('roll 后 text/end 落新行；end 时新行 body 聚合、旧行不动', () => {
    seedStreamingSession('ss-r', ['旧']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: '新行文本' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    const old = rows.find((m) => m.streamSessionId === 'ss-r')!;
    const next = rows.find((m) => m.streamSessionId === 'ss-r#roll1')!;
    expect(old.body).toBe('旧');
    expect(old.status).toBe('done');
    expect(next.body).toBe('新行文本');
    expect(next.status).toBe('done');
  });

  it('多次 roll 计数递增（#roll1 → #roll2），各段互不串', () => {
    seedStreamingSession('ss-r', ['A']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: 'B' });
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: 'C' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    expect(rows.find((m) => m.streamSessionId === 'ss-r')!.body).toBe('A');
    expect(rows.find((m) => m.streamSessionId === 'ss-r#roll1')!.body).toBe('B');
    expect(rows.find((m) => m.streamSessionId === 'ss-r#roll2')!.body).toBe('C');
  });

  it('end 后 roll 计数清理（同 id 再启动新流从 roll1 重新计）', () => {
    seedStreamingSession('ss-r', ['A']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();
    // 同 streamSessionId 再来一轮（理论上新流新 id，防御性验证清理不泄漏）
    seedStreamingSession('ss-r', ['B']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    __flushEventBufferForTest();
    const rows = listMessagesBySession('s1');
    expect(rows.filter((m) => m.streamSessionId === 'ss-r#roll1').length).toBe(2); // 两轮各一个 roll1，无 roll2 泄漏
  });

  it('无旧行时静默跳过（不抛错不插行）', () => {
    expect(() =>
      routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-ghost' }),
    ).not.toThrow();
    expect(listMessagesBySession('s1').length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/stream-relay-roll.test.ts
```
预期：FAIL——TS 编译报 `message_roll` 不在 StreamChunk 联合类型（或运行时 roll 无 handler 静默无效果，断言失败）。

- [ ] **Step 3: 实现**

3a. `stream-chunk.ts` 联合类型末尾（segment_boundary 成员后）新增：

```typescript
  | {
      /**
       * v2.3.1 steer 消息滚动（spec §2.1）：drain 到用户补充且自上次 roll 后有新文本时，
       * runtime-entry 发此 chunk 让主进程「换行」——当前消息行终态化（done + 聚合回写），
       * 新消息行承接后续输出。与 segment_boundary 的区别：真换行（后续 chunk 路由到新行），
       * 非 body 快照。
       */
      type: 'message_roll';
      streamSessionId: string;
    };
```

文件头生命周期注释补一行：` * - message_roll: v2.3.1 steer 注入换行（旧行定格，新行承接）`

3b. `runtime-spawner.ts:202` 白名单数组加 `'message_roll'`：

```typescript
    if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'todo_update', 'end', 'segment_boundary', 'message_roll'].includes(m.type)) {
```

3c. `stream-relay.ts`：

模块级（`streamMessageIdCache` 声明附近）新增：

```typescript
/** v2.3.1 roll 计数：streamSessionId → 已 roll 次数（新行后缀 #roll{n}）。
 * end 的 clearStreamSessionCache 一并清理，防泄漏。 */
const rollCounts = new Map<string, number>();

/** 测试用：清空 roll 计数 */
export function __rollCountsForTest(): void {
  rollCounts.clear();
}
```

`clearStreamSessionCache` 函数体内（既有清理处）追加 `rollCounts.delete(streamSessionId);`。

`routeChunkToBuffer` switch 在 `segment_boundary` 分支后新增：

```typescript
      case 'message_roll': {
        // v2.3.1 消息滚动（spec §2.3）：旧行终态化（聚合回写语义同 end 的 done 路径），
        // 新行承接后续输出；cache 换指向后 thinking/text/tool/end 零改动落新行
        const oldId = resolveMessageId(chunk.streamSessionId);
        if (!oldId) return; // 无行则静默跳过（与 start 前置同防御）
        const buf = getEventBuffer();
        // ① 旧行终态化：先冲刷 pending 让全部 text_delta 落盘，再聚合回写
        buf.flush();
        const oldBody = aggregateTextDeltas(oldId);
        updateMessageStatus(oldId, 'done', oldBody);
        const oldUpdated = getMessage(oldId);
        if (oldUpdated) pushSessionMessage(oldUpdated);
        buf.append({ messageId: oldId, eventType: 'final', payload: { body: oldBody } });
        buf.flush();
        // ② 新行：继承旧行会话身份，streamSessionId 加 roll 后缀（避免双行同值歧义）
        const oldMsg = getMessage(oldId)!;
        const n = (rollCounts.get(chunk.streamSessionId) ?? 0) + 1;
        rollCounts.set(chunk.streamSessionId, n);
        const rollMsg = insertMessage({
          sessionId: oldMsg.sessionId,
          sender: oldMsg.sender,
          eventType: 'm.room.message',
          body: '',
          streamSessionId: `${chunk.streamSessionId}#roll${n}`,
          parentStreamSessionId: oldMsg.parentStreamSessionId,
          workspaceId: oldMsg.workspaceId,
          status: 'streaming',
        });
        streamMessageIdCache.set(chunk.streamSessionId, rollMsg.id);
        pushSessionMessage(rollMsg);
        buf.append({
          messageId: rollMsg.id,
          eventType: 'status_change',
          payload: { status: 'streaming' },
        });
        return;
      }
```

- [ ] **Step 4: 运行确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/stream-relay-roll.test.ts tests/agent/stream-relay.test.ts
```
预期：新文件 5 用例 PASS；既有 stream-relay 19 用例零回归。

- [ ] **Step 5: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/stream-chunk.ts electron/src/main/agent/runtime-spawner.ts electron/src/main/agent/stream-relay.ts electron/tests/agent/stream-relay-roll.test.ts
git commit -m "feat: message_roll chunk 与 stream-relay 换行 handler（steer 注入滚动）"
```

---

### Task 2: runtime-entry drain 扩展（roll emit）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（drain 块 :438-444 + `case 'text'` 分支 :455-460）
- Test: `electron/tests/agent/runtime-entry-steer.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `message_roll` chunk 类型
- Produces: drain 时按 `hasNewTextSinceLastRoll` 决定是否 emit roll；text delta 产出置位标志

- [ ] **Step 1: 写失败测试**

`runtime-entry-steer.test.ts` 追加一个 describe（夹具与既有 4 用例完全一致——`sentChunks` 数组捕获全部 chunk）：

```typescript
describe('runChatLoop steer 消息滚动（message_roll）', () => {
  it('drain 时有新文本 → 先发 message_roll chunk 再注入补充', async () => {
    // 复用既有两轮结构（round1: text+compact+steer emit；round2: 捕获 messages+stop）
    // 断言：sentChunks 中存在 { type: 'message_roll', streamSessionId: 's-steer' }
    //       且其出现在 round2 的 text chunk 之前
  });

  it('drain 时无新文本（round1 未产 text）→ 不发 roll，补充仍注入', async () => {
    // round1 只 yield tool_use(compact)（无 text delta）+ steer emit；
    // round2 捕获 messages + stop
    // 断言：sentChunks 无 message_roll；round2 messages 仍含 [用户中途补充]
  });

  it('两次 drain（两轮各 steer 一次，中间有 text）→ 各发一次 roll', async () => {
    // 三轮结构：r1(text+compact+steer1) → r2(text+compact+steer2) → r3(stop)
    // 断言：sentChunks 中 message_roll 出现 2 次
  });
});
```

（用例体按既有用例的 generator mock 模式补全——`sentChunks` 由既有 `process.send` mock 捕获，参考文件内既有断言写法。）

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-entry-steer.test.ts
```
预期：新 describe 3 用例 FAIL（无 roll chunk 发出）。

- [ ] **Step 3: 实现**

3a. `runChatLoop` 内 `pendingSteers` 声明后新增标志：

```typescript
  // v2.3.1 消息滚动：自上次 roll 后是否产过新文本——drain 时据此决定是否换行
  //（防「连续 steer 在同一等待期」产生空新行，spec §2.2）
  let hasNewTextSinceLastRoll = false;
```

3b. `case 'text'` 分支（accumulatedText 累加处）追加置位：

```typescript
          case 'text':
            accumulatedText += delta.content;
            hasNewTextSinceLastRoll = true;
            sendStreamChunk({ type: 'text', streamSessionId, delta: delta.content });
            break;
```

3c. drain 块（for round 循环顶部）扩展：

```typescript
    // v2.3 steer 注入（spec §5.2）：每轮构建 LLM 请求前 drain——上一轮工具
    // 执行期间到达的用户补充在此进入上下文；最后一轮自然结束后未消费的
    // 补充保留在会话历史（消息已落库），下轮对话可见，不重派发
    if (pendingSteers.length > 0) {
      // v2.3.1 消息滚动（spec §2.2）：有新文本先换行——旧行定格，新行承接本轮
      //（切点安全：drain 在工具循环结束后，无悬空 tool_call 事件对）
      if (hasNewTextSinceLastRoll) {
        sendStreamChunk({ type: 'message_roll', streamSessionId });
        hasNewTextSinceLastRoll = false;
      }
    }
    while (pendingSteers.length > 0) {
      messages.push({ role: 'user', content: `[用户中途补充] ${pendingSteers.shift()!}` });
    }
```

- [ ] **Step 4: 运行确认通过 + 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-entry-steer.test.ts tests/agent/runtime-segment.test.ts tests/agent/dispatch-parallel.test.ts
```
预期：新 3 用例 + 既有 4 用例全 PASS；segment / dispatch-parallel 零回归。

- [ ] **Step 5: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/runtime-entry.ts electron/tests/agent/runtime-entry-steer.test.ts
git commit -m "feat: steer 注入触发消息滚动——drain 时换行出新气泡"
```

---

### Task 3: 全量验收门禁

**Files:** 无代码改动（验证任务）

- [ ] **Step 1: 双 typecheck**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```
预期：双 clean。

- [ ] **Step 2: 全量测试**

```bash
npx pnpm@9.0.0 test
```
预期：electron / renderer 全绿（若容器 SIGSEGV 偶发，重跑一次——预存 flake）。

- [ ] **Step 3: spec §6 验收对照（代码级可验项）**

| # | 验收 | 验证方式 |
|---|---|---|
| 1 | 注入后双气泡：旧行定格、新行续跑 | stream-relay-roll 5 用例 + runtime-entry-steer roll 3 用例 |
| 2 | 导出 4 条消息时序自然 | roll 行 `#roll{n}` 后缀 + createdAt = 注入时刻（结构性保证） |
| 3 | steer/车道/abort/dispatch 零回归 | 全量测试 + 既有特性套件 |
| 4 | typecheck 双 clean | Step 1 |

GUI 冒烟（复现实测会话：ls 任务中途改 pwd → 观察双气泡 + 导出顺序）留 macOS 主机。

- [ ] **Step 4: ledger 收尾**

`.superpowers/sdd/progress.md` 追加执行记录。

---

## 任务依赖

T1 → T2 → T3 串行（T2 消费 T1 的 chunk 类型；T3 收尾）。
