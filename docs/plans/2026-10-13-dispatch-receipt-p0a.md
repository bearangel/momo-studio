# P0-A 实施计划：system 角色 + 回执投递幂等（D1+D2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dispatch 回执行与 followup 追问行改用 `sender='system'` 一等公民角色渲染为系统事件卡，且 PM 已内联消费的链永不重投、每链至多一条回执行。

**Architecture:** 双端解耦「UI sender」与「LLM role」（electron 单点映射函数）；子进程在消费 task_reply 后发 `task_reply_ack` 内部事件，主进程 registry 置 `delivered=true`；`markPmIdle` 补投加 `roundStartedAt` 窗口兜底；投递前 DB 查重兜底；回执行落库后实时推送。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM）+ better-sqlite3 + vitest。

**Spec:** `docs/specs/2026-10-13-dispatch-receipt-and-interrupt-cascade-design.md`（§5 D1、§6 D2）

## Global Constraints

- Node 20（`nvm use 20`）；TypeScript strict，禁 `any` / `@ts-ignore` / `as any`（ESLint error 级）
- 所有代码注释中文；标识符英文
- 单测位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 同目录）
- IPC / preload 改动后双 workspace typecheck：`npx pnpm@9.0.0 typecheck`
- renderer UI：语义 token（`bg-surface-*` / `text-secondary`…）、lucide-react 图标 16px / stroke 1.75、禁 emoji、原子组件优先
- Conventional Commits（`feat:` / `test:` / `refactor:` / `fix:`）；**不动版本号**
- 实现§6.1 简化说明：`task_reply_ack` 的「acked 缓存」分支在既有顺序（settle 先于子进程转发，ack 必然晚于 settle 到达）下不可达，`markConsumed` 实现为幂等直置 `delivered=true`，行为契约与 spec 等价

## Review Focus

1. **畸形回执 body**（无首行结构）→ SystemEventCard 降级 80 字符纯文本摘要——Task A10 测试
2. **ack 丢失**（子进程 resolve 后瞬崩）→ roundStartedAt 窗口兜底仍可补投恰一次——Task A8 测试
3. **被驱逐链的迟到 ack**（enforceSettledCap 已删句柄）→ markConsumed no-op 不抛错——Task A6 测试
4. **`remote:` 前缀行不被误判 system** → isSystemSender 严格等值 + mapsToUserRole 保守降级——Task A1 契约测试
5. **真实用户行带 task_id 不被 migration 误翻**（用户行无回执前缀/无 parent_ssi 双特征）→ Task A3 迁移守卫测试

---

### Task A1: sender 语义守卫 + LLM role 单点映射

**Files:**
- Create: `renderer/src/lib/sender.ts`
- Create: `renderer/src/lib/sender.test.ts`
- Create: `electron/src/main/agent/sender-role.ts`
- Create: `electron/tests/agent/sender-role.test.ts`

**Interfaces:**
- Produces (renderer): `isSystemSender(sender: string): boolean`、`isTurnAnchor(sender: string): boolean`（Task A10/A11 消费）
- Produces (electron): `mapsToUserRole(sender: string): boolean`（Task A5 消费）

- [ ] **Step 1: 写 renderer 失败测试**

```ts
// renderer/src/lib/sender.test.ts
import { describe, expect, it } from 'vitest';
import { isSystemSender, isTurnAnchor } from './sender';

describe('sender 语义守卫', () => {
  it('system 行命中 isSystemSender；owner/agent/remote 前缀不命中', () => {
    expect(isSystemSender('system')).toBe(true);
    expect(isSystemSender('owner')).toBe(false);
    expect(isSystemSender('agent-pm-agent-1')).toBe(false);
    expect(isSystemSender('remote:node1:system')).toBe(false); // 远端行只读镜像，不判 system
    expect(isSystemSender('')).toBe(false);
  });
  it('回合锚点 = owner 或 system', () => {
    expect(isTurnAnchor('owner')).toBe(true);
    expect(isTurnAnchor('system')).toBe(true);
    expect(isTurnAnchor('agent-coder-1')).toBe(false);
    expect(isTurnAnchor('remote:node1:owner')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/sender.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// renderer/src/lib/sender.ts
//
// 本地 sender 语义（spec 2026-10-13 §5.1）：'owner'=本机用户 / 'system'=系统生成行
// （dispatch 回执、followup 追问）/ 'agent-*'=agent 实例；p2p 远端行为
// 'remote:<node>[:<s>]'（开放集合，ImMessage.sender 类型保持 string）。
export type LocalSender = 'owner' | 'system' | `agent-${string}`;

/** 是否系统生成行（渲染为系统事件卡，非用户/agent 气泡） */
export function isSystemSender(sender: string): boolean {
  return sender === 'system';
}

/** 是否回合锚点（owner 用户消息或 system 系统行——turn-segment 撤回组锚点口径） */
export function isTurnAnchor(sender: string): boolean {
  return sender === 'owner' || sender === 'system';
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/sender.test.ts`
Expected: PASS

- [ ] **Step 5: electron 侧映射——先写失败测试**

```ts
// electron/tests/agent/sender-role.test.ts
import { describe, expect, it } from 'vitest';
import { mapsToUserRole } from '../../src/main/agent/sender-role';

describe('UI sender → LLM role 单点映射（spec §5.4）', () => {
  it('owner / system / remote / 未知 → user；agent-* → assistant', () => {
    expect(mapsToUserRole('owner')).toBe(true);
    expect(mapsToUserRole('system')).toBe(true);
    expect(mapsToUserRole('remote:node1:owner')).toBe(true);
    expect(mapsToUserRole('')).toBe(true); // 保守降级 user
    expect(mapsToUserRole('weird-unknown')).toBe(true);
    expect(mapsToUserRole('agent-pm-agent-f_ZufQ')).toBe(false);
  });
});
```

- [ ] **Step 6: 运行确认失败后实现**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/sender-role.test.ts` → FAIL，然后：

```ts
// electron/src/main/agent/sender-role.ts
//
// UI sender → LLM role 单点映射（spec 2026-10-13 §5.4）：
// 'owner' / 'system' / 'remote:*' / 未知 → user（保守降级）；
// 'agent-*' → assistant。会话重建（turn-reconstructor）与链历史重建
// （sub-history-reconstructor）共用——模型视角与 UI 视角解耦的单一真相源。
export function mapsToUserRole(sender: string): boolean {
  return !sender.startsWith('agent-');
}
```

再跑 → PASS。

- [ ] **Step 7: Commit**

```bash
git add renderer/src/lib/sender.ts renderer/src/lib/sender.test.ts electron/src/main/agent/sender-role.ts electron/tests/agent/sender-role.test.ts
git commit -m "feat: sender system 语义守卫与 LLM role 单点映射"
```

---

### Task A2: 写入方收敛（回执行 / followup 行 / agent 身份校验）

**Files:**
- Modify: `electron/src/main/agent/router-service.ts:834-841`（deliverChainResult insertMessage）
- Modify: `electron/src/main/agent/router-service.ts:92`（sender 校验）
- Modify: `electron/src/main/agent/chain-writer.ts:33`
- Modify: `electron/tests/agent/dispatch-auto-delivery.test.ts`（断言更新）

**Interfaces:**
- Consumes: 无
- Produces: 回执行 / followup 行落库 `sender: 'system'`（Task A3 迁移、A9 推送、A10 渲染的前提）

- [ ] **Step 1: 更新既有测试断言（先红）**

`electron/tests/agent/dispatch-auto-delivery.test.ts` 中捕获 insertMessage 调用的断言处（现断言 body 含『【dispatch 回执自动送达】』），把 sender 断言改为：

```ts
expect(task.sender).toBe('system'); // spec §5.2：回执行系统角色落库
```

若该测试经 vi.mock 拦截 insertMessage，保持拦截方式不变，仅增断言字段。（chain-writer 若有专项测试文件则同步加 `sender==='system'` 断言；无则在 `electron/tests/agent/` 下新建 `chain-writer.test.ts`，用临时库（`AP_USER_DATA_DIR` 指向 tmp 目录后 import storage/db）断言 appendFollowupQuestionRow 落库 sender。）

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-auto-delivery.test.ts`
Expected: FAIL（sender 仍为 'owner'）

- [ ] **Step 3: 三处修改**

`router-service.ts` deliverChainResult 内：

```ts
      insertMessage({
        sessionId: h.sessionId,
        sender: 'system', // spec §5.2：系统生成行——PM 重建时经 sender-role 映射仍为 user 轮
        eventType: 'm.room.message',
        body,
        taskId: h.taskId,
        streamSessionId,
      });
```

`router-service.ts:92` 校验（agent 身份反查入口）追加 system 拒绝：

```ts
  if (typeof sender !== 'string' || sender.length === 0 || sender === 'owner' || sender === 'system') {
```

`chain-writer.ts` 追问行 + 头部注释「sender='system'（PM 代发追问，非用户手输；重建器经 sender-role 映射为 user 轮）」：

```ts
    sender: 'system',
```

- [ ] **Step 4: 运行确认通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-auto-delivery.test.ts` → PASS

```bash
git add electron/src/main/agent/router-service.ts electron/src/main/agent/chain-writer.ts electron/tests/agent/dispatch-auto-delivery.test.ts
git commit -m "feat: 回执行与 followup 追问行改 sender=system 落库"
```

---

### Task A3: migration 056 存量翻新

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（照 migration055 同构新增 migration056）
- Create: `electron/tests/storage/migration-056-system-sender.test.ts`

**Interfaces:**
- Produces: 存量回执行 / followup 行 `sender='system'`（Task A10 重启渲染前提）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/migration-056-system-sender.test.ts
//
// migration 056 守卫测试：回执行 / followup 行翻 system；真实用户行零误伤。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 临时 userData（paths.ts 的 AP_USER_DATA_DIR 注入点）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig056-'));
process.env.AP_USER_DATA_DIR = tmpDir;

const { getDb } = await import('../../src/main/storage/db');
const { insertMessage } = await import('../../src/main/storage/messages/repo');
const { migration056 } = await import('../../src/main/storage/migrations/index');

function countBySender(tag: string): number {
  return (getDb().prepare('SELECT count(*) n FROM messages WHERE body LIKE ?').get(`%${tag}%`) as { n: number }).n;
}

describe('migration 056：存量 system 行翻新', () => {
  it('回执行与 followup 行翻 system，真实用户行不动', () => {
    const db = getDb();
    // 种子：回执行（owner 伪装）／followup 行／真实用户行（带 task_id 但无回执前缀）
    insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
      body: '【dispatch 回执自动送达】任务链 t-1（第 1 轮）已完成（工具调用 3 次）。', taskId: 't-1' });
    insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
      body: '请继续调研 X', taskId: 't-2', parentStreamSessionId: 's-pm-1' });
    insertMessage({ sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
      body: '帮我看下这个任务 #T-task-9', taskId: null });
    // 直接执行 056 的 SQL（迁移 runner 在 getDb 首开已跑过 056 之前的版本；
    // 056 未列入前的库由本测试先行构造，故此处手动执行同一 SQL 验证语义）
    db.exec(migration056.sql);
    const rows = db.prepare('SELECT body, sender FROM messages ORDER BY created_at').all() as Array<{ body: string; sender: string }>;
    expect(rows.find(r => r.body.startsWith('【dispatch'))?.sender).toBe('system');
    expect(rows.find(r => r.body === '请继续调研 X')?.sender).toBe('system');
    expect(rows.find(r => r.body.includes('#T-task-9'))?.sender).toBe('owner'); // 零误伤
  });
});

afterAll(() => { delete process.env.AP_USER_DATA_DIR; fs.rmSync(tmpDir, { recursive: true, force: true }); });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-056-system-sender.test.ts`
Expected: FAIL（migration056 未导出）

- [ ] **Step 3: 新增 migration056（照 migration055 的导出形态同构）**

```ts
// —— SQL 为 TS 字符串常量（AGENTS.md：禁 .sql 文件，防打包丢文件）——
export const migration056 = {
  version: 56,
  name: 'system-sender-flip',
  // 回执行（task_id + 前缀双特征）与 followup 追问行（task_id + parent 双特征）
  // → sender='system'（spec 2026-10-13 §5.7）。真实用户行不带 task_id，不命中。
  sql: `
    UPDATE messages SET sender='system'
    WHERE sender='owner' AND task_id IS NOT NULL
      AND (body LIKE '【dispatch 回执自动送达】%' OR parent_stream_session_id IS NOT NULL);
  `,
} as const;
```

并按文件内既有注册方式加入 MIGRATIONS 数组（version 排序处照抄邻居行形态）。

- [ ] **Step 4: 运行确认通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-056-system-sender.test.ts` → PASS

```bash
git add electron/src/main/storage/migrations/index.ts electron/tests/storage/migration-056-system-sender.test.ts
git commit -m "feat: migration 056 存量回执行/followup 行翻 sender=system"
```

---

### Task A4: getLatestMessageByStreamSessionId 加固

**Files:**
- Modify: `electron/src/main/storage/messages/repo.ts:197-210`
- Modify: `electron/tests/storage/messages-repo.test.ts`（追加用例）

**Interfaces:**
- Produces: 唤醒流「当前行」解析恒返 agent 行（消除双行同 ssi 顺序依赖，spec §5.5）

- [ ] **Step 1: 追加失败测试**

```ts
it('同 ssi 双行（system 回执行 + agent 流行）恒返 agent 行（spec §5.6 契约）', () => {
  insertMessage({ sessionId: 's-x', sender: 'system', eventType: 'm.room.message', body: '【dispatch 回执自动送达】…', taskId: 't-9', streamSessionId: 'ssi-dual-1' });
  insertMessage({ sessionId: 's-x', sender: 'agent-pm-1', eventType: 'm.room.message', body: '', streamSessionId: 'ssi-dual-1' });
  const row = getLatestMessageByStreamSessionId('ssi-dual-1');
  expect(row?.sender).toBe('agent-pm-1');
});
```

- [ ] **Step 2: 确认失败后加固查询**

WHERE 两分支（`stream_session_id = ?` 与 `LIKE ? || '#%'`）外层各加：

```sql
AND sender LIKE 'agent-%'
```

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts` → PASS

```bash
git add electron/src/main/storage/messages/repo.ts electron/tests/storage/messages-repo.test.ts
git commit -m "fix: 流当前行查询限定 agent 行，消除双行同 ssi 顺序依赖"
```

---

### Task A5: LLM 重建接线 mapsToUserRole

**Files:**
- Modify: `electron/src/main/agent/turn-reconstructor.ts:597`
- Modify: `electron/src/main/agent/sub-history-reconstructor.ts:94`
- Modify: 对应既有测试文件（`electron/tests/agent/` 下 turn-reconstructor / sub-history 相关）

**Interfaces:**
- Consumes: `mapsToUserRole`（Task A1）

- [ ] **Step 1: 追加失败测试（两个重建器各一）**

turn-reconstructor 测试：构造含 `sender:'system'` 回执行的会话行，断言重建产物的 LLMMessage 序列中该行 `role:'user'` 且正文原样。sub-history-reconstructor 测试：链历史含 `sender:'system'` followup 行 → 重建为 user 轮。（测试写在各自既有测试文件内，mock 收窄到 DB 边界，用真实行数据构造。）

- [ ] **Step 2: 确认失败后替换判定**

`turn-reconstructor.ts:597`：

```ts
      const isOwnerRow = mapsToUserRole(row.sender); // spec §5.4：owner/system/remote → user 轮
```

`sub-history-reconstructor.ts:94`：

```ts
      if (mapsToUserRole(row.sender)) { // spec §5.4：system followup 行同为 user 轮
```

（两处 import `./sender-role`；变量名 isOwnerRow 若语义失准则局部更名 `mapsToUser`，一义一名。）

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/` → PASS

```bash
git add electron/src/main/agent/turn-reconstructor.ts electron/src/main/agent/sub-history-reconstructor.ts electron/tests/agent/
git commit -m "refactor: 会话/链历史重建接入 sender→role 单点映射（system 行入 user 轮）"
```

---

### Task A6: registry markConsumed（消费即已投递）

**Files:**
- Modify: `electron/src/main/agent/dispatch-registry.ts`（新增 markConsumed）
- Modify: `electron/tests/agent/dispatch-registry.test.ts`

**Interfaces:**
- Produces: `markConsumed(taskId: string): void`（Task A7 applyRegistryAck 消费；幂等）

- [ ] **Step 1: 失败测试**

```ts
it('markConsumed：在途/已结算链置 delivered=true；不存在 no-op 不抛错（spec §6.1）', () => {
  registry.register({ taskId: 't-c1', pmAssignmentId: 'pm', subAssignmentId: 'sub', sessionId: 's1', isFollowupRound: false });
  registry.markConsumed('t-c1');                       // 在途即可置（settle 不覆盖 delivered）
  registry.settle('t-c1', 'completed', 'done', 5);
  expect(registry.get('t-c1')?.delivered).toBe(true);  // takeNextDeliverable 不再取走
  expect(registry.takeNextDeliverable('pm')).toBeUndefined();
  expect(() => registry.markConsumed('t-evicted')).not.toThrow(); // 迟到/被驱逐 no-op
});
```

- [ ] **Step 2: 实现（dispatch-registry.ts，settle 邻近位置）**

```ts
  /**
   * 消费确认（task_reply_ack 消费，spec §6.1）：PM 子进程已内联消费该链结果
   * （waitForTaskReply resolve / gather 收割）——等同已投递，永不自动送达。
   * 幂等；句柄不存在（被容量驱逐 / 迟到）no-op。
   * 顺序保证：settle 先于子进程转发（routeTaskReply 内 applyRegistryReply 先于
   * notifyTaskReply），ack 必然到达于 settle 之后，无需预缓存分支。
   */
  markConsumed(taskId: string): void {
    const h = this.chains.get(taskId);
    if (h) h.delivered = true;
  }
```

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-registry.test.ts` → PASS

```bash
git add electron/src/main/agent/dispatch-registry.ts electron/tests/agent/dispatch-registry.test.ts
git commit -m "feat: dispatch registry markConsumed——内联消费等同已投递"
```

---

### Task A7: task_reply_ack 内部事件全链

**Files:**
- Modify: `electron/src/main/agent/dispatch.ts`（新事件类型常量）
- Modify: `electron/src/main/agent/internal-event.ts`（便捷构造器）
- Modify: `electron/src/main/agent/dispatch-wait.ts`（handleTaskReply 两个消费分支发 ack）
- Modify: `electron/src/main/agent/internal-event-bridge.ts`（如白名单分流则登记；先读该文件确认）
- Modify: `electron/src/main/agent/router-service.ts`（routeEvent 新 case + applyRegistryAck）
- Create: `electron/tests/agent/task-reply-ack.test.ts`

**Interfaces:**
- Consumes: `markConsumed`（Task A6）
- Produces: 事件类型 `'io.momo-studio.task_reply_ack'`，content `{ task_id: string }`；`applyRegistryAck(content: Record<string, unknown>): void`

- [ ] **Step 1: 失败测试（契约 + 路由两侧）**

```ts
// electron/tests/agent/task-reply-ack.test.ts
//
// task_reply_ack 契约（boundary 规则 4：生产者真实产出 → 消费者直接消费）。
// process.send mock 遵循 test-rules 规则 1：真实 Node 内部读 this，以绑定对象方法形态提供。
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('task_reply_ack 全链', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sendTaskReplyAckEvent 产出正确信封（eventType + content.task_id）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = function (this: { connected: boolean }, msg: Record<string, unknown>) {
      if (!this.connected) throw new Error('channel closed');
      calls.push(msg);
    };
    vi.stubGlobal('process', { ...process, send: send.bind({ connected: true }), connected: true });
    const { sendTaskReplyAckEvent } = await import('../../src/main/agent/internal-event');
    sendTaskReplyAckEvent('sess-1', 'agent-pm-1', { task_id: 't-ack-1' });
    expect(calls[0]).toMatchObject({
      type: 'momo-internal-event',
      eventType: 'io.momo-studio.task_reply_ack',
      sessionId: 'sess-1',
      sender: 'agent-pm-1',
      content: { task_id: 't-ack-1' },
    });
  });

  it('RouterService.applyRegistryAck → registry.markConsumed（delivered=true）', async () => {
    const { dispatchRegistry, __resetDispatchRegistryForTest } = await import('../../src/main/agent/dispatch-registry');
    __resetDispatchRegistryForTest();
    dispatchRegistry.register({ taskId: 't-ack-2', pmAssignmentId: 'pm', subAssignmentId: 'sub', sessionId: 's', isFollowupRound: false });
    dispatchRegistry.settle('t-ack-2', 'completed', 'ok');
    const { RouterService } = await import('../../src/main/agent/router-service');
    const svc = new RouterService({ runners: new Map() });
    svc.applyRegistryAck({ task_id: 't-ack-2' });
    expect(dispatchRegistry.get('t-ack-2')?.delivered).toBe(true);
    // 非法载荷 no-op
    expect(() => svc.applyRegistryAck({})).not.toThrow();
  });
});
```

- [ ] **Step 2: 确认失败后实现四端**

`dispatch.ts` 常量区：

```ts
/** v2.x 消费确认（spec 2026-10-13 §6.1）：PM 子进程内联消费 task_reply 后回执主进程 */
export const TASK_REPLY_ACK_EVENT_TYPE = 'io.momo-studio.task_reply_ack';
```

`internal-event.ts`：

```ts
export function sendTaskReplyAckEvent(sessionId: string, from: string, content: Record<string, unknown>): void {
  sendInternalEvent({ eventType: TASK_REPLY_ACK_EVENT_TYPE, sessionId, sender: from, content });
}
```

`dispatch-wait.ts` handleTaskReply 内两个消费分支末尾（pending entry resolve 处、bg 句柄翻转并 wakeGatherWaiters 之后）各追加（sessionId / config 取该函数作用域既有字段，与同文件 sendAbortDispatchEvent 调用同源）：

```ts
    // spec §6.1：内联消费确认——主进程据此置 delivered，杜绝 forcedExit 补投重投
    sendTaskReplyAckEvent(sessionId, config.agentUserId, { task_id: taskId });
```

`internal-event-bridge.ts`：核对分流逻辑——若按 eventType 白名单转发则登记新类型（有 internal-event-bridge.test.ts 锁形态，按其模式补断言）。

`router-service.ts` routeEvent switch 追加：

```ts
        case 'io.momo-studio.task_reply_ack':
          this.applyRegistryAck(event.getContent());
          break;
```

同类新增 public 方法：

```ts
  /** task_reply_ack 消费（spec §6.1）：PM 已内联消费 → 等同已投递，幂等 */
  applyRegistryAck(content: Record<string, unknown>): void {
    const taskId = content.task_id;
    if (typeof taskId !== 'string') return;
    dispatchRegistry.markConsumed(taskId);
  }
```

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/task-reply-ack.test.ts tests/agent/internal-event-bridge.test.ts` → PASS

```bash
git add electron/src/main/agent/dispatch.ts electron/src/main/agent/internal-event.ts electron/src/main/agent/dispatch-wait.ts electron/src/main/agent/internal-event-bridge.ts electron/src/main/agent/router-service.ts electron/tests/agent/task-reply-ack.test.ts
git commit -m "feat: task_reply_ack 消费确认事件——内联消费的链永不自动送达"
```

---

### Task A8: roundStartedAt 透传 + markPmIdle 窗口收紧

**Files:**
- Modify: `electron/src/main/agent/agent-runner.ts`（记录回合起点 + onIdle 三参）
- Modify: `electron/src/main/agent/router-service.ts`（notifyRunnerIdle / setRunnerIdleHandler 签名 + onPmIdle）
- Modify: `electron/src/main/agent/router-bootstrap.ts:66`（透传）
- Modify: `electron/src/main/agent/dispatch-registry.ts`（markPmIdle 窗口参数）
- Modify: `electron/tests/agent/dispatch-registry.test.ts`、`electron/tests/agent/agent-runner.test.ts`（追加）

**Interfaces:**
- Produces: `onIdle: (assignmentId: string, forcedExit: boolean, roundStartedAt: number) => void`；`markPmIdle(pmAssignmentId, opts?: { deliverSettledUndelivered?: boolean; roundStartedAt?: number })`

- [ ] **Step 1: 失败测试（registry 窗口语义）**

```ts
it('markPmIdle 补投窗口：只翻本回合内 settle 的链（spec §6.2，ack 丢失兜底）', () => {
  registry.register({ taskId: 't-old', pmAssignmentId: 'pm', subAssignmentId: 'sub', sessionId: 's', isFollowupRound: false });
  registry.settle('t-old', 'completed', 'old');              // 老回合链（completedAt 早于窗口）
  const now = Date.now();
  vi.useFakeTimers(); vi.setSystemTime(now + 60_000);
  registry.register({ taskId: 't-new', pmAssignmentId: 'pm', subAssignmentId: 'sub', sessionId: 's', isFollowupRound: false });
  registry.settle('t-new', 'completed', 'new');              // 本回合链
  registry.markPmIdle('pm', { deliverSettledUndelivered: true, roundStartedAt: now + 30_000 });
  expect(registry.get('t-old')?.awaitWake).toBe(false);      // 老链零补投——修复 spring-mcp 重复轰炸
  expect(registry.get('t-new')?.awaitWake).toBe(true);
  vi.useRealTimers();
});
```

- [ ] **Step 2: 实现四层透传**

`dispatch-registry.ts` markPmIdle else-if 分支加窗口条件：

```ts
      } else if (
        opts?.deliverSettledUndelivered &&
        h.status === 'done' &&
        !h.delivered &&
        !h.isFollowupRound &&
        h.completedAt >= (opts.roundStartedAt ?? 0) // spec §6.2：仅本回合窗口内翻转的链
      ) {
```

`agent-runner.ts`：字段 `private lastRoundStartedAt = 0;`；`executeTask` 入口记 `this.lastRoundStartedAt = Date.now();`；`maybeFireIdle` 回调改传三参 `this.opts.onIdle(id, forcedExit, this.lastRoundStartedAt)`；`AgentRunnerOpts.onIdle` 签名扩为 `(assignmentId: string, forcedExit: boolean, roundStartedAt: number) => void`。

`router-service.ts`：`notifyRunnerIdle(assignmentId, forcedExit = false, roundStartedAt = 0)` + `runnerIdleHandler` 类型同步扩参；`onPmIdle` 改：

```ts
  onPmIdle(assignmentId: string, forcedExit = false, roundStartedAt = 0): void {
    dispatchRegistry.markPmIdle(
      assignmentId,
      forcedExit ? { deliverSettledUndelivered: true, roundStartedAt } : undefined,
    );
    this.tryDeliver(assignmentId);
  }
```

`router-bootstrap.ts:66` 透传第三参。既有 mock onIdle 的旧测试按新签名兼容（第三参可选消费）。

- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-registry.test.ts tests/agent/agent-runner.test.ts` → PASS

```bash
git add electron/src/main/agent/agent-runner.ts electron/src/main/agent/router-service.ts electron/src/main/agent/router-bootstrap.ts electron/src/main/agent/dispatch-registry.ts electron/tests/agent/
git commit -m "feat: PM 空闲补投加 roundStartedAt 窗口——只补投本回合链"
```

---

### Task A9: deliverChainResult 三改（查重 / sender / 实时推送）

**Files:**
- Modify: `electron/src/main/storage/messages/repo.ts`（hasReceiptRow）
- Modify: `electron/src/main/agent/stream-relay.ts:121`（export pushSessionMessage）
- Modify: `electron/src/main/agent/router-service.ts`（deliverChainResult）
- Modify: `electron/tests/agent/dispatch-auto-delivery.test.ts`

**Interfaces:**
- Produces: `hasReceiptRow(sessionId: string, taskId: string): boolean`；回执行实时可见（session:message 推送）

- [ ] **Step 1: 失败测试（查重跳过）**

dispatch-auto-delivery.test.ts 追加：

```ts
it('同链已有回执行 → 整条跳过（不落行不唤醒，spec §6.3 终极兜底）', async () => {
  // 预置同 taskId system 回执行后触发投递，断言：insertMessage 零新增、routeUserChat 零调用
});
```

（按该文件既有 mock 拦截风格补全种子与断言；断言对象为既有 spy。）

- [ ] **Step 2: 实现**

repo.ts（listMessagesByStreamSessionId 邻近）：

```ts
/** 是否已存在该链回执行（投递前查重兜底，spec §6.3）——system 行 + 同 taskId */
export function hasReceiptRow(sessionId: string, taskId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE session_id = ? AND task_id = ? AND sender = 'system' AND segment_of IS NULL
       LIMIT 1`,
    )
    .get(sessionId, taskId);
  return row !== undefined;
}
```

stream-relay.ts：`function pushSessionMessage` → `export function pushSessionMessage`（注释补「router-service 回执投递共用——回执行实时可见」）。

router-service.ts deliverChainResult 首行：

```ts
    if (hasReceiptRow(h.sessionId, h.taskId)) {
      logger.warn('dispatch 回执查重命中——跳过投递（防上游状态机缺陷重复污染会话）', { taskId: h.taskId });
      return;
    }
```

insertMessage 改接收返回值并推送：

```ts
      const row = insertMessage({ sessionId: h.sessionId, sender: 'system', eventType: 'm.room.message', body, taskId: h.taskId, streamSessionId });
      // spec §5.6：本行 streamSessionId 与唤醒流共享 = 回合标识（input 行 + output 行同属一回合），
      // 契约：同 ssi 至多一条 system 行 + 一条 agent 流行，getLatest 恒返 agent 行（Task A4 锁）。
      pushSessionMessage(row); // spec §6.4：实时可见——回执行随落库推送 renderer
```

- [ ] **Step 3: 通过 + 双 typecheck + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-auto-delivery.test.ts` → PASS；`npx pnpm@9.0.0 typecheck`

```bash
git add electron/src/main/storage/messages/repo.ts electron/src/main/agent/stream-relay.ts electron/src/main/agent/router-service.ts electron/tests/agent/dispatch-auto-delivery.test.ts
git commit -m "feat: 回执投递查重兜底 + system 行实时推送"
```

---

### Task A10: SystemEventCard + 渲染层接线

**Files:**
- Create: `renderer/src/components/im/SystemEventCard.tsx` + `.test.tsx`
- Modify: `renderer/src/components/im/MessageBubble.tsx`（顶部分支）
- Modify: `renderer/src/components/im/MessageList.tsx:82`（贴底判定）
- Modify: `renderer/src/components/im/TaskProgressButton.tsx:41`（跳过 system）
- Modify: 对应测试文件

**Interfaces:**
- Consumes: `isSystemSender` / `isTurnAnchor`（Task A1）

- [ ] **Step 1: SystemEventCard 失败测试**

```tsx
// renderer/src/components/im/SystemEventCard.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SystemEventCard } from './SystemEventCard';
import type { ImMessage } from '../../ipc/types';

const base: ImMessage = { /* 按类型最小构造：id/sessionId/sender:'system'/eventType:'m.room.message'/body/streamSessionId:null/parentStreamSessionId:null/segmentOf:null/status:'done'/taskId:'t-1'/createdAt:0/workspaceId:null */ } as unknown as ImMessage;

describe('SystemEventCard', () => {
  it('标准回执 body → 结构化摘要行', () => {
    render(<SystemEventCard message={{ ...base, body: '【dispatch 回执自动送达】任务链 t-abc-1（第 2 轮）已完成（工具调用 15 次）。\n--- 回执正文 ---\nok' }} />);
    expect(screen.getByText(/子任务回执 · 已完成 · 第 2 轮 · 工具调用 15 次/)).toBeInTheDocument();
  });
  it('畸形 body → 80 字符纯文本降级（错误路径专项，test 规则 3）', () => {
    render(<SystemEventCard message={{ ...base, body: '随便一段没有结构的长文本'.repeat(20) }} />);
    expect(screen.getByText(/^随便一段没有结构的长文本.{0,}$/)).toBeInTheDocument();
  });
  it('点击摘要展开/收起全文', () => {
    render(<SystemEventCard message={{ ...base, body: '【dispatch 回执自动送达】任务链 t-1（第 1 轮）已完成（工具调用 1 次）。' }} />);
    fireEvent.click(screen.getByRole('button', { name: /子任务回执/ }));
    expect(screen.getByText(/【dispatch 回执自动送达】/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 实现组件**

```tsx
// renderer/src/components/im/SystemEventCard.tsx
//
// 系统事件卡（spec §5.3）：sender='system' 行专属渲染——居中窄卡（非气泡）。
// 现承载 dispatch 回执；首行结构化解析失败降级 80 字符纯文本摘要。
import { useState } from 'react';
import { BellRing, ChevronDown, ChevronRight } from 'lucide-react';
import type { ImMessage } from '../../ipc/types';

const RECEIPT_HEAD_RE = /^【dispatch 回执自动送达】任务链 \S+（第 (\d+) 轮）已(完成|失败)（工具调用 (\d+) 次）。\n?/;

export function SystemEventCard({ message }: { message: ImMessage }) {
  const [expanded, setExpanded] = useState(false);
  const m = RECEIPT_HEAD_RE.exec(message.body);
  const summary = m ? `子任务回执 · 已${m[2]} · 第 ${m[1]} 轮 · 工具调用 ${m[3]} 次` : message.body.slice(0, 80);
  return (
    <div className="my-1 flex justify-center">
      <div className="w-full max-w-[80%] rounded border border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-secondary">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-1.5"
        >
          <BellRing size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
          <span className="truncate">{summary}</span>
          {expanded
            ? <ChevronDown size={11} strokeWidth={1.75} aria-hidden />
            : <ChevronRight size={11} strokeWidth={1.75} aria-hidden />}
        </button>
        {expanded && (
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-tertiary">
            {message.body}
          </pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 三处接线**

`MessageBubble.tsx` 组件体首行（stream 查询之前）：

```tsx
  if (isSystemSender(message.sender)) return <SystemEventCard message={message} />; // spec §5.3
```

`MessageList.tsx:82`：`lastMsg.sender === 'owner'` → `isTurnAnchor(lastMsg.sender)`（回执唤醒回合出现即贴底）。

`TaskProgressButton.tsx:41`：`if (msg.sender === 'owner') continue;` → `if (isTurnAnchor(msg.sender)) continue;`。

补 `isTopLevelMessage` 契约用例（spec §5.3-1，写入 `renderer/src/lib/locate-message.test.ts`，若无需新建）：

```ts
it('system 行放行顶层渲染（spec §5.3 契约锁）', () => {
  expect(isTopLevelMessage({ ...baseMsg, sender: 'system', parentStreamSessionId: null, segmentOf: null, eventType: 'm.room.message' })).toBe(true);
});
```

- [ ] **Step 4: 通过 + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/SystemEventCard.test.tsx src/components/im/MessageBubble.test.tsx` → PASS（MessageBubble 测试补 system 行渲染卡不渲染气泡的用例）

```bash
git add renderer/src/components/im/SystemEventCard.tsx renderer/src/components/im/SystemEventCard.test.tsx renderer/src/components/im/MessageBubble.tsx renderer/src/components/im/MessageList.tsx renderer/src/components/im/TaskProgressButton.tsx renderer/src/components/im/MessageBubble.test.tsx
git commit -m "feat: SystemEventCard 系统事件卡与渲染层 system 行接线"
```

---

### Task A11: turn-segment 回合锚点扩展

**Files:**
- Modify: `renderer/src/lib/turn-segment.ts`
- Modify: `renderer/src/components/im/TurnUndoDialog.tsx`（anchorMessageId 更名适配）
- Modify: `renderer/src/lib/turn-segment.test.ts`（若无则 Create）

**Interfaces:**
- Consumes: `isTurnAnchor`（Task A1）
- Produces: `TurnSegment { anchorMessageId: string; messageIds: string[]; streamIds: string[] }`

- [ ] **Step 1: 失败测试**

```ts
it('system 回执行作为锚点自成撤回组（spec §5.3）', () => {
  const msgs = [
    msg('m1', 'owner', '用户问'), msg('m2', 'agent-a', '答'),
    msg('m3', 'system', '【dispatch 回执自动送达】…'), msg('m4', 'agent-a', '唤醒回复'),
  ];
  const seg = latestTurn(msgs)!;
  expect(seg.anchorMessageId).toBe('m3');
  expect(seg.messageIds).toEqual(['m3', 'm4']);
});
```

- [ ] **Step 2: 实现（判定换 isTurnAnchor + 字段更名，TurnUndoDialog 引用同步）**

- [ ] **Step 3: 通过 + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/turn-segment.test.ts` → PASS

```bash
git add renderer/src/lib/turn-segment.ts renderer/src/components/im/TurnUndoDialog.tsx renderer/src/lib/turn-segment.test.ts
git commit -m "feat: 撤回组锚点扩展 system 行（回执唤醒回合自成一组）"
```

---

### Task A12: 其余消费方处置（记忆 / 命名 / 展示名）

**Files:**
- Modify: `electron/src/main/memory/context-map.ts`（提取跳过 system 行）
- Modify: `electron/src/main/agent/tools/session-tools.ts:160`（system → '系统'）
- Modify: `electron/src/main/im/session-naming.ts`（现状 `find(sender==='owner')` 已天然跳过 system——仅补回归用例锁死）
- 对应测试文件追加用例

**Interfaces:** 无新接口；行为契约变更（system 行不入记忆提取、展示名『系统』）

- [ ] **Step 1: 失败测试（三处各一）**：context-map：含 system 行的提取输入 → 产出记忆条目不含该行；session-tools：`sender='system'` 行渲染名『系统』；session-naming：首条 owner 之前有 system 行 → 标题仍取 owner 行。
- [ ] **Step 2: 实现**：context-map 行循环处 `if (row.sender === 'system') continue; // spec §5.5：系统管道噪声不入记忆`；session-tools 三元链前插 `m.sender === 'system' ? '系统' :`。
- [ ] **Step 3: 通过 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/memory tests/agent tests/im` → PASS

```bash
git add electron/src/main/memory/context-map.ts electron/src/main/agent/tools/session-tools.ts electron/tests/
git commit -m "feat: system 行不入记忆提取，展示名系统"
```

---

### Task A13: L2 集成回归 + 全量验证

**Files:**
- Modify: `electron/tests/integration/orchestration-e2e.test.ts`（spring-mcp 场景仿真，spec §11.2-10）

**Interfaces:** 无——验收任务

- [ ] **Step 1: 追加场景测试（先红）**

场景：seed 两条链——链 A 同步消费（executeDispatch resolve → ack 到达）、链 B 后台终态；随后 PM forcedExit。断言：链 A 零回执行零唤醒（routeUserChat 调用计数不增）；链 B 恰一条 `sender='system'` 回执行 + 恰一次唤醒；重复触发 forcedExit 无增量。（复用该文件既有 seed/断言基建。）

- [ ] **Step 2: 全量验证**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
```

Expected: 全绿（无关预存失败如实记录，不扩scope修）

- [ ] **Step 3: Commit**

```bash
git add electron/tests/integration/orchestration-e2e.test.ts
git commit -m "test: 同步消费零重投与后台链恰一次送达的 L2 回归锁"
```
