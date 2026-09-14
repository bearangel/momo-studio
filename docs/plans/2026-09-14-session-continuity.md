# 会话连续性修复（A+B）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复会话跨轮上下文的三个断点——窗口取「最早 N 条」（B0）、工具层不进上下文（B1）、中断轮次为空 assistant（B2）——并顺带消除当前消息双拼（B6）。

**Architecture:** 分两段：A 段在 provider 层止血（最近窗口 + 终态空正文合成标记）；B 段在 `turn-reconstructor.ts` 新增 `rebuildSessionContext`，把断点续跑已有的 events 级重建能力接到主会话常规轮次，`runtime-entry` 顶层路径换接线。设计依据：`docs/specs/2026-09-14-session-continuity-design.md`。

**Tech Stack:** Electron 主进程 TypeScript（CommonJS）、better-sqlite3、vitest。

## Global Constraints

- **Node 20**：容器默认 Node 26 会破坏 better-sqlite3 native binding，所有命令前先 `nvm use 20`。
- **测试命令**：`cd electron && npx pnpm@9.0.0 vitest run tests/<路径>`（单文件）。
- **中文注释**：所有新增代码注释、文档使用中文；标识符英文。
- **TypeScript strict**：禁止 `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error` 已启用）。
- **单测位置**：electron 主进程单测集中 `electron/tests/`（`vitest.config.ts` 显式 include，放别处不执行）。
- **Conventional Commits**：`fix:` / `feat:` / `refactor:` / `test:` / `docs:`；**不动版本号**（2026-09-13 版本号纪律）。
- **测试保真度**：涉及写测试 / mock 的任务，执行前加载 skill `momo-test-rules`；涉及契约判定的加载 `momo-boundary-rules`。
- **本计划零 IPC / renderer 改动**：如某步发现必须动 IPC 通道或 renderer，停下来上报，不得自行扩面。

---

### Task 1: repo 层最近窗口查询扩展（A1 前置）

**Files:**
- Modify: `electron/src/main/storage/messages/repo.ts:223-229`（`listRecentMessagesBySession`）
- Test: `electron/tests/storage/messages-repo.test.ts`（追加 describe）

**Interfaces:**
- Produces: `listRecentMessagesBySession(sessionId: string, limit: number, opts?: { afterTs?: number; beforeTs?: number }): MessageRow[]`（Task 2 / Task 4 消费）

- [ ] **Step 1: 写失败测试**

在 `electron/tests/storage/messages-repo.test.ts` 末尾追加（文件顶部已有所需 import：`insertMessage` / `listRecentMessagesBySession` / `getDb`）：

```ts
// === A1（spec 2026-09-14 §3）：最近窗口过滤 ===

/** 显式改写 created_at（窗口语义测试需要确定性时序；生产无此路径） */
function setCreatedAt(id: string, ts: number): void {
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, id);
}

describe('listRecentMessagesBySession opts（A1 最近窗口过滤）', () => {
  /** seed 5 行（m1..m5，created_at = 1000..5000 严格递增） */
  function seed5(): void {
    for (let i = 1; i <= 5; i++) {
      const row = insertMessage({
        sessionId: 'r-window',
        sender: '@a:home',
        eventType: 'm.room.message',
        body: `m${i}`,
      });
      setCreatedAt(row.id, i * 1000);
    }
  }

  it('limit=3 返回最新 3 条且输出 ASC', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 3);
    expect(rows.map((r) => r.body)).toEqual(['m3', 'm4', 'm5']);
  });

  it('afterTs：仅拉 created_at 严格大于游标的最近 N 条', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 10, { afterTs: 3000 });
    expect(rows.map((r) => r.body)).toEqual(['m4', 'm5']);
  });

  it('beforeTs 与 afterTs 组合成区间窗口', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 10, { afterTs: 1000, beforeTs: 4000 });
    expect(rows.map((r) => r.body)).toEqual(['m2', 'm3']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts`（workdir `electron/`）
Expected: FAIL——`opts` 参数不存在导致 afterTs/beforeTs 两个用例失败（TypeScript 编译期即报错也算预期失败形态，此时先看报错确认是参数数量不符）。

- [ ] **Step 3: 实现**

替换 `repo.ts` 中 `listRecentMessagesBySession`（保留原 doc 注释主体，追加一段）：

```ts
/**
 * 取会话「最近 limit 条」消息，输出仍按时间升序（与显示侧时序一致）。
 * 与 listMessagesBySession({ limit }) 的区别：后者是 ASC+LIMIT = 最早 N 条。
 *
 * A1（spec 2026-09-14 §3）：可选 afterTs / beforeTs 过滤，语义与
 * listMessagesBySession 一致（created_at 严格大于 / 小于）。DESC 取数后反转；
 * rowid 作同毫秒并列行的稳定序（后插入者视为更新）。
 */
export function listRecentMessagesBySession(
  sessionId: string,
  limit: number,
  opts?: { afterTs?: number; beforeTs?: number },
): MessageRow[] {
  const db = getDb();
  // 动态拼 WHERE：条件与参数同步追加（与 listMessagesBySession 同款，防分支 SQL 重复）
  const conds = ['session_id = ?'];
  const params: Array<string | number> = [sessionId];
  if (opts?.afterTs !== undefined) {
    conds.push('created_at > ?');
    params.push(opts.afterTs);
  }
  if (opts?.beforeTs !== undefined) {
    conds.push('created_at < ?');
    params.push(opts.beforeTs);
  }
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as SqlRow[];
  return rows.reverse().map(rowToCamel);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts`
Expected: PASS（全部用例，含既有用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/messages/repo.ts electron/tests/storage/messages-repo.test.ts
git commit -m "feat: listRecentMessagesBySession 支持 afterTs/beforeTs 窗口过滤（会话连续性 A1 前置）"
```

---

### Task 2: provider 切换最近窗口 + 终态空正文合成标记（A1+A2）

**Files:**
- Modify: `electron/src/main/memory/sqlite-provider.ts:151-183`（`getConversationContext`）
- Test: `electron/tests/memory/sqlite-provider.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `listRecentMessagesBySession(sessionId, limit, opts)`
- Produces: `getConversationContext` 行为变更——「最新 N 条」+ aborted/failed 空 body 合成标记（对外签名不变）

- [ ] **Step 1: 写失败测试（含 B0 复现锁——momo-debug-rules 规则 6：先红后绿）**

在 `electron/tests/memory/sqlite-provider.test.ts` 末尾追加（顶部已 import `insertMessage` / `getDb` / `provider` 常量在既有 describe 内——新 describe 自建实例或复用文件级 helper；`beforeEach` 已 seed `ws1`）：

```ts
// === A1/A2（spec 2026-09-14 §3）：最近窗口 + 终态空正文标记 ===

describe('getConversationContext A1/A2（会话连续性修复）', () => {
  const providerA = new SQLiteMemoryProvider();

  /** seed n 行（m1..mn，created_at = 1000..n*1000 严格递增；奇数 owner / 偶数 bot） */
  function seedN(n: number, sessionId: string): void {
    for (let i = 1; i <= n; i++) {
      const row = insertMessage({
        sessionId,
        sender: i % 2 === 0 ? '@bot:home' : 'owner',
        eventType: 'm.room.message',
        body: `m${i}`,
      });
      getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(i * 1000, row.id);
    }
  }

  it('B0 回归锁：超过 limit 行数时返回最新 N 条（修复前为最早 N 条）', async () => {
    seedN(25, 'r-b0');
    const ctx = await providerA.getConversationContext('r-b0', { limit: 20 });
    expect(ctx.messages).toHaveLength(20);
    expect(ctx.messages[0]!.content).toBe('m6');
    expect(ctx.messages[19]!.content).toBe('m25');
  });

  it('A2：aborted/failed 空 body 行替换为合成标记；done 空 body 不替换', async () => {
    const cases: Array<{ status: 'aborted' | 'failed' | 'done'; ssi: string }> = [
      { status: 'aborted', ssi: 'sa' },
      { status: 'failed', ssi: 'sf' },
      { status: 'done', ssi: 'sd' },
    ];
    cases.forEach((c, i) => {
      const row = insertMessage({
        sessionId: 'r-a2',
        sender: '@bot:home',
        eventType: 'm.room.message',
        body: '',
        streamSessionId: c.ssi,
        status: c.status,
      });
      getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run((i + 1) * 1000, row.id);
    });
    const ctx = await providerA.getConversationContext('r-a2');
    expect(ctx.messages.map((m) => m.content)).toEqual([
      '[本轮已被用户中断，未产生正文]',
      '[本轮执行失败，未产生正文：见消息流详情]',
      '',
    ]);
  });

  it('compaction 游标：covered_until 之前不再拉取 + 头部注入摘要条', async () => {
    // session_compactions 有 FK → sessions（beforeEach 已 seed ws1）
    getDb().prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES ('r-cc', 'ws1', 't', 'chat', 1000, 1000)`,
    ).run();
    seedN(5, 'r-cc');
    getDb().prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES ('r-cc', '早期对话摘要', 3000, 9000)`,
    ).run();
    const ctx = await providerA.getConversationContext('r-cc', { limit: 20 });
    expect(ctx.messages[0]!.role).toBe('user');
    expect(ctx.messages[0]!.content).toContain('[此前对话压缩摘要]');
    expect(ctx.messages[0]!.content).toContain('早期对话摘要');
    expect(ctx.messages.slice(1).map((m) => m.content)).toEqual(['m4', 'm5']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/memory/sqlite-provider.test.ts`
Expected: FAIL——B0 用例拿到最早 20 条（`m1`..`m20`）；A2 用例拿到空串。

- [ ] **Step 3: 实现**

`sqlite-provider.ts` 修改三处：

① import 区：`listMessagesBySession` 换成 `listRecentMessagesBySession`（本文件唯一消费点就是 `getConversationContext`，替换后无残留引用）：

```ts
import {
  listRecentMessagesBySession,
  type MessageRow,
} from '../storage/messages/repo';
```

② 文件尾部（`pruneOldToolResults` 之前）新增：

```ts
/**
 * A2（spec 2026-09-14 §3）：终态空正文行的合成标记文案。
 * 作用：(a) 给模型可见的中断/失败信号；(b) 防空 assistant 正文——
 * Anthropic 系 provider 对空 content 消息有 400 风险。
 * done 且空正文返回 null（正常终态不该为空，出现也不虚构状态）。
 */
function syntheticTerminalBody(status: MessageRow['status']): string | null {
  if (status === 'aborted') return '[本轮已被用户中断，未产生正文]';
  if (status === 'failed') return '[本轮执行失败，未产生正文：见消息流详情]';
  return null;
}
```

③ `getConversationContext` 内，把 `const rows = listMessagesBySession(...)` 调用替换为：

```ts
    // A1（spec 2026-09-14 §3）：改「最近 N 条」语义——ASC+LIMIT 拿的是最早 N 条
    //（repo.ts listMessagesBySession 注释自证；session-service.ts /compact 早为此换用
    // DESC 直取并留有「勿换」警示，主链路此前未修）。游标语义不变：有 compaction 行时
    // 仅拉 covered_until 之后的最近 N 条。
    const rows = listRecentMessagesBySession(
      sessionId,
      opts?.limit ?? 20,
      {
        ...(compaction ? { afterTs: compaction.coveredUntil } : {}),
        ...(opts?.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
      },
    );
```

紧接着的 `const ctx: ContextMessage[] = rows.map((m) => messageToContext(m));` 替换为：

```ts
    const ctx: ContextMessage[] = rows.map((m) => {
      const c = messageToContext(m);
      const mark = m.body === '' ? syntheticTerminalBody(m.status) : null;
      return mark !== null ? { ...c, content: mark } : c;
    });
```

- [ ] **Step 4: 跑测试确认通过（含既有全量 memory 套件）**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/memory/`
Expected: PASS（既有用例 seed 行数都 < limit，最早/最近语义重合，不应有回归；如有失败逐个核对是否依赖旧语义）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/memory/sqlite-provider.ts electron/tests/memory/sqlite-provider.test.ts
git commit -m "fix: 会话上下文改取最近 N 条并为终态空正文行合成标记（B0/B2 止血）"
```

---

### Task 3: rebuildTurn 抽出共享流重建核心（纯重构，行为不变）

**Files:**
- Modify: `electron/src/main/agent/turn-reconstructor.ts:254-308`（`rebuildTurn` 重构为薄包装）

**Interfaces:**
- Produces（模块私有，Task 4 消费）:
  `rebuildStreamMessages(streamSessionId: string, opts: { includeUser: boolean; undrainedSteersAsUser: boolean }): { messages: LLMMessage[]; toolCallsUsed: number; steers: string[]; degenerate: boolean; endTs: number }`

- [ ] **Step 1: 重构（无行为变更，既有测试即回归锁）**

把 `rebuildTurn` 函数体（254-308 行区域）替换为「共享核心 + 薄包装」：

```ts
/** rebuildTurn / rebuildSessionContext 共享的流重建选项 */
interface StreamRebuildOptions {
  /** 头部是否 prepend 回合起始 user 消息（resume 用 true；会话重建的 walk 已渲染 owner 行，用 false） */
  includeUser: boolean;
  /**
   * 流末未 drain 的 steer 是否也渲染为 [用户中途补充] user 消息。
   * resume 用 false（收集进 steers[] 随载荷重放进 pendingSteers）；
   * 会话重建用 true（不存在 pendingSteers 消费者，行内渲染语义等价）。
   */
  undrainedSteersAsUser: boolean;
}

/** 共享核心返回形状（RebuiltTurn 超集） */
interface StreamRebuildResult {
  messages: LLMMessage[];
  toolCallsUsed: number;
  steers: string[];
  degenerate: boolean;
  /** 流末 DB 时刻 = 全部关联事件 createdAt 最大值（无事件回落流行 createdAt）——会话重建 steer 时间窗右端点 */
  endTs: number;
}

/**
 * 单流 events → LLMMessage 重建共享核心（rebuildTurn 与 rebuildSessionContext
 * 的同一语义实现：text_delta 拼接 / tool 对按 callId 配对 / 孤儿 call 合成
 * INTERRUPTED_TOOL_RESULT / steer 按 drain 语义分支）。
 */
function rebuildStreamMessages(
  streamSessionId: string,
  opts: StreamRebuildOptions,
): StreamRebuildResult {
  // 流行定位失败 = 从未执行（assigned 等）→ 纯重派降级
  const baseRow = getMessageByStreamSessionId(streamSessionId);
  if (!baseRow) {
    return { messages: [], toolCallsUsed: 0, steers: [], degenerate: true, endTs: 0 };
  }

  const agg = createAssistantRoundAggregator();
  const steers: string[] = [];
  let endTs = baseRow.createdAt;

  if (opts.includeUser) {
    const userBody = findTurnUserBody(baseRow);
    if (userBody !== null) {
      agg.appendMessage({ role: 'user', content: userBody });
    }
  }

  const events = collectStreamEvents(streamSessionId);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.createdAt > endTs) endTs = ev.createdAt;
    // eventType 实为 TEXT 列（可含未来类型 / T2 的 'steer' / 未知 kind），
    // repo 联合类型是欠近似——放宽到 string 再分发
    switch (ev.eventType as string) {
      case 'steer': {
        const body = ev.payload.body;
        if (typeof body !== 'string') break;
        // 其后是否仍有输出（drain 判定）；会话重建模式下未 drain 也渲染
        //（其后无任何输出，事件位渲染与流末渲染时序等价）
        const drained = events.slice(i + 1).some(isOutputEvent);
        if (drained || opts.undrainedSteersAsUser) {
          agg.closeRound();
          agg.appendMessage({ role: 'user', content: `[用户中途补充] ${body}` });
        } else {
          steers.push(body);
        }
        break;
      }
      default:
        // text / tool 事件进共享聚合状态机；其余（thinking / todo_update /
        // status_change / final / message_roll / segment_boundary / 未知 kind）跳过
        agg.push(ev);
      }
  }
  // 流末 flush：残留文本收尾 + 未配对 call 合成中断 result
  agg.flush();

  const messages = agg.messages;
  const degenerate = !messages.some((m) => m.role !== 'user');
  return { messages, toolCallsUsed: agg.toolCallsUsed, steers, degenerate, endTs };
}

export function rebuildTurn(streamSessionId: string): RebuiltTurn {
  try {
    const r = rebuildStreamMessages(streamSessionId, {
      includeUser: true,
      undrainedSteersAsUser: false,
    });
    return {
      messages: r.messages,
      toolCallsUsed: r.toolCallsUsed,
      steers: r.steers,
      degenerate: r.degenerate,
    };
  } catch (err) {
    // 降级阶梯（spec §5.3）：重建任何抛错 → catch 降级 degenerate（安全方向）
    logger.warn('rebuildTurn 重建失败，降级为全新回合', {
      streamSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyDegenerate();
  }
}
```

注意：`rebuildTurn` 原函数头部的 doc 注释保留在原位（历史语义说明仍适用）；`RebuiltTurn` 接口与其导出常量不动。

- [ ] **Step 2: 跑既有测试矩阵确认零回归**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/turn-reconstructor.test.ts tests/agent/runtime-resume.test.ts tests/agent/sub-history-reconstructor.test.ts tests/agent/runtime-task-driven.test.ts`
Expected: PASS（全部，这是纯重构的行为锁）。

- [ ] **Step 3: Commit**

```bash
git add electron/src/main/agent/turn-reconstructor.ts
git commit -m "refactor: rebuildTurn 抽出共享流重建核心 rebuildStreamMessages（行为不变）"
```

---

### Task 4: rebuildSessionContext 主会话 events 级重建（B 核心）

**Files:**
- Modify: `electron/src/main/agent/turn-reconstructor.ts`（文件尾部追加）
- Test: `electron/tests/agent/session-context-reconstructor.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `listRecentMessagesBySession`；Task 3 `rebuildStreamMessages`；既有 `createAssistantRoundAggregator`
- Produces（Task 5 消费）:
  `rebuildSessionContext(sessionId: string, opts?: { limitTurns?: number; excludeTrailingOwnerRow?: boolean }): { messages: LLMMessage[]; timestamps: number[] }`

- [ ] **Step 1: 写失败测试（新建文件）**

新建 `electron/tests/agent/session-context-reconstructor.test.ts`。fixture 模式照抄 `tests/agent/turn-reconstructor.test.ts`（真实 DB + 生产落库链 `__routeChunkToBufferForTest`；区别：本文件所有行的 `created_at` 用显式改写保证确定性时序）：

```ts
// electron/tests/agent/session-context-reconstructor.test.ts
//
// rebuildSessionContext 回归矩阵（spec 2026-09-14 §4.5）。
// fixture 保真度：真实 db（tmp + AP_USER_DATA_DIR + runMigrations）+ 生产落库链
// __routeChunkToBufferForTest（start/tool_call/tool_result/end chunk）；行时序用
// 显式 UPDATE created_at 保证确定性（同毫秒插入会使时间窗判定不稳定）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEvent } from '../../src/main/storage/messages/events-repo';
import {
  rebuildSessionContext,
  INTERRUPTED_TOOL_RESULT,
} from '../../src/main/agent/turn-reconstructor';
import { TOOL_RESULT_MAX_LEN, TRUNCATED_MARKER } from '../../src/main/compaction/serialize';

const tmpRoot = path.join(os.tmpdir(), `ap-session-ctx-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetEventBufferForTest();
});

afterEach(() => {
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const SESSION_ID = 'sess-ctx-1';
const AGENT_SENDER = 'agent-coder-a1b2c3';

/** owner 行（字段照抄 session-service.sendUserMessage）+ 显式时序 */
function ownerRow(body: string, ts: number): void {
  const row = insertMessage({ sessionId: SESSION_ID, sender: 'owner', eventType: 'm.room.message', body });
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, row.id);
}

/** start chunk 落库后改写流行 created_at（族首行时序锚点） */
function startStream(ssi: string, ts: number): void {
  __routeChunkToBufferForTest({
    type: 'start', streamSessionId: ssi, sessionId: SESSION_ID, senderAgentId: AGENT_SENDER,
  });
  __flushEventBufferForTest();
  getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(ts, ssi);
}

function toolCall(ssi: string, callId: string, name: string, args: Record<string, unknown>): void {
  __routeChunkToBufferForTest({
    type: 'tool_call', streamSessionId: ssi, callId, toolName: name, args,
  });
  __flushEventBufferForTest();
}

function toolResult(ssi: string, callId: string, name: string, result: string): void {
  __routeChunkToBufferForTest({
    type: 'tool_result', streamSessionId: ssi, callId, toolName: name, result, success: true,
  });
  __flushEventBufferForTest();
}

function endStream(ssi: string, finishReason: 'stop' | 'interrupted' | 'failed'): void {
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: ssi, finishReason });
  __flushEventBufferForTest();
}

/** 事件时刻整体平移（窗口测试需要事件晚于指定行时刻） */
function bumpStreamEventTs(ssi: string, floorTs: number): void {
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE created_at < ? AND message_id IN
       (SELECT id FROM messages WHERE stream_session_id = ? OR stream_session_id LIKE ? || '#%')`,
  ).run(floorTs, floorTs, ssi, ssi);
}
```

测试矩阵（同一文件内继续）：

```ts
describe('rebuildSessionContext（spec 2026-09-14 §4.5 回归矩阵）', () => {
  it('T1 案例回归锁：中断轮的工具对完整进入下一轮上下文，当前指令行被剔除', () => {
    const T0 = Date.now();
    ownerRow('帮我使用bash访问一下bing', T0 + 100);
    startStream('s1', T0 + 200);
    toolCall('s1', 'c1', 'bash', { command: 'curl https://www.bing.com' });
    toolResult('s1', 'c1', 'bash', 'HTTP状态码: 200');
    bumpStreamEventTs('s1', T0 + 250);
    endStream('s1', 'interrupted');
    bumpStreamEventTs('s1', T0 + 280);
    ownerRow('访问百度', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({ role: 'user', content: '帮我使用bash访问一下bing' });
    expect(ctx.messages[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'bash' }],
    });
    expect(ctx.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'HTTP状态码: 200' });
    expect(ctx.timestamps).toEqual([T0 + 100, T0 + 200, T0 + 200]);
  });

  it('T2 孤儿 tool_call：中断无 result 时合成 INTERRUPTED_TOOL_RESULT', () => {
    const T0 = Date.now();
    ownerRow('跑个任务', T0 + 100);
    startStream('s2', T0 + 200);
    toolCall('s2', 'c2', 'bash', { command: 'sleep 100' });
    bumpStreamEventTs('s2', T0 + 250);
    endStream('s2', 'interrupted');
    ownerRow('继续', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    const tool = ctx.messages.find((m) => m.role === 'tool')!;
    expect(tool.content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(tool.toolCallId).toBe('c2');
  });

  it('T3a 已 drain steer：族时间窗内 owner 行去重，事件渲染为 [用户中途补充]', () => {
    const T0 = Date.now();
    ownerRow('查点资料', T0 + 100);
    startStream('s3', T0 + 200);
    // 输出一段文本（事件时刻抬到 T0+220）
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 's3', delta: '正在查询' });
    __flushEventBufferForTest();
    bumpStreamEventTs('s3', T0 + 220);
    // steer：owner 行先落（T0+240），子进程 drain 后 steer 事件（抬到 T0+260）
    ownerRow('顺便也看看百度', T0 + 240);
    const streamRowId = getDb()
      .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
      .get('s3') as { id: string };
    insertEvent({
      messageId: streamRowId.id, seq: 99, eventType: 'steer', payload: { body: '顺便也看看百度' },
    });
    bumpStreamEventTs('s3', T0 + 260);
    endStream('s3', 'stop');

    const ctx = rebuildSessionContext(SESSION_ID);
    const bodies = ctx.messages.map((m) => m.content);
    // owner steer 行被跳过，只有事件渲染的那一条补充消息
    expect(bodies.filter((b) => b === '顺便也看看百度')).toHaveLength(0);
    expect(bodies.filter((b) => b === '[用户中途补充] 顺便也看看百度')).toHaveLength(1);
  });

  it('T3b 未 drain steer（无事件）：owner 行是唯一记录，渲染为 user 消息', () => {
    const T0 = Date.now();
    ownerRow('查点资料', T0 + 100);
    startStream('s3b', T0 + 200);
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 's3b', delta: '正在查询' });
    __flushEventBufferForTest();
    bumpStreamEventTs('s3b', T0 + 220);
    endStream('s3b', 'interrupted');
    // 进程死前未 drain：只有 owner 行（时刻在全部事件之后 → 族窗外）
    ownerRow('怎么不理我了', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID);
    const bodies = ctx.messages.map((m) => m.content);
    expect(bodies).toContain('怎么不理我了');
    expect(bodies.some((b) => b.startsWith('[用户中途补充]'))).toBe(false);
  });

  it('T4 子流行 / #seg 快照 / #roll 换行：前两者跳过，roll 并族', () => {
    const T0 = Date.now();
    ownerRow('多步任务', T0 + 100);
    startStream('s4', T0 + 200);
    toolCall('s4', 'c4', 'bash', { command: 'ls' });
    toolResult('s4', 'c4', 'bash', 'a.ts b.ts');
    bumpStreamEventTs('s4', T0 + 250);
    // 分段快照行（#seg）
    __routeChunkToBufferForTest({
      type: 'segment_boundary', streamSessionId: 's4', segmentStreamSessionId: 's4#seg0',
      segmentBody: '第一段完成', segmentIndex: 0,
    });
    __flushEventBufferForTest();
    // 换行（#roll1）：事件落新行
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 's4' });
    __flushEventBufferForTest();
    toolCall('s4', 'c5', 'read_file', { path: '/tmp/a.ts' });
    toolResult('s4', 'c5', 'read_file', 'file-content');
    bumpStreamEventTs('s4', T0 + 300);
    endStream('s4', 'stop');
    // 子 agent 流行（parent 指向 s4）
    const sub = insertMessage({
      sessionId: SESSION_ID, sender: 'agent-pm-x1', eventType: 'm.room.message', body: '子agent回复',
      streamSessionId: 'sub-1', parentStreamSessionId: 's4', status: 'done',
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 280, sub.id);

    const ctx = rebuildSessionContext(SESSION_ID);
    const toolIds = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(toolIds).toEqual(['c4', 'c5']); // roll 后事件并进同一族
    expect(ctx.messages.some((m) => m.content === '子agent回复')).toBe(false); // 子流行跳过
    expect(ctx.messages.some((m) => m.content === '第一段完成')).toBe(false); // seg 快照跳过
  });

  it('T5 compaction 游标 + 摘要头 + 旧轮超长工具结果截断', () => {
    const T0 = Date.now();
    getDb().prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-ctx', 'WS', '', '/tmp', 0, '@owner:s', 'x')`,
    ).run();
    getDb().prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, 'ws-ctx', 't', 'chat', 1000, 1000)`,
    ).run(SESSION_ID);
    // 旧轮：超长工具结果
    ownerRow('旧任务', T0 + 100);
    startStream('s5', T0 + 200);
    toolCall('s5', 'c6', 'bash', { command: 'cat big.log' });
    toolResult('s5', 'c6', 'bash', 'x'.repeat(TOOL_RESULT_MAX_LEN + 100));
    bumpStreamEventTs('s5', T0 + 250);
    endStream('s5', 'stop');
    // 游标落在旧轮之后
    getDb().prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, '旧对话已压缩', ?, ?)`,
    ).run(SESSION_ID, T0 + 260, T0 + 260);
    // 新轮（游标后）
    ownerRow('新任务', T0 + 300);
    startStream('s6', T0 + 400);
    toolCall('s6', 'c7', 'bash', { command: 'echo hi' });
    toolResult('s6', 'c7', 'bash', 'hi');
    bumpStreamEventTs('s6', T0 + 450);
    endStream('s6', 'stop');
    ownerRow('当前指令', T0 + 500);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    // 摘要头条
    expect(ctx.messages[0]!.role).toBe('user');
    expect(ctx.messages[0]!.content).toContain('旧对话已压缩');
    // 游标前旧轮不出现（c6 不在）
    expect(ctx.messages.some((m) => m.toolCallId === 'c6')).toBe(false);
    // 游标后新轮完整
    expect(ctx.messages.some((m) => m.toolCallId === 'c7')).toBe(true);
    // 旧轮若未被游标覆盖时也应截断——单独验证：无 compaction 时超长结果被截断
    getDb().prepare('DELETE FROM session_compactions WHERE session_id = ?').run(SESSION_ID);
    const ctx2 = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    const big = ctx2.messages.find((m) => m.toolCallId === 'c6')!;
    expect(big.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_LEN + TRUNCATED_MARKER.length + 1);
    expect(big.content).toContain(TRUNCATED_MARKER);
  });

  it('T6 空轮流：零输出事件的族不产生空 assistant 消息', () => {
    const T0 = Date.now();
    ownerRow('指令一', T0 + 100);
    startStream('s7', T0 + 200); // 直接中断，零输出事件
    endStream('s7', 'interrupted');
    ownerRow('指令二', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    expect(ctx.messages).toEqual([{ role: 'user', content: '指令一' }]);
    expect(ctx.messages.some((m) => m.role === 'assistant' && m.content === '')).toBe(false);
  });

  it('T7 默认不剔除末尾 owner 行（excludeTrailingOwnerRow 缺省）', () => {
    const T0 = Date.now();
    ownerRow('指令一', T0 + 100);
    startStream('s8', T0 + 200);
    toolCall('s8', 'c8', 'bash', { command: 'pwd' });
    toolResult('s8', 'c8', 'bash', '/tmp');
    bumpStreamEventTs('s8', T0 + 250);
    endStream('s8', 'stop');
    ownerRow('当前指令', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID);
    expect(ctx.messages[ctx.messages.length - 1]).toEqual({ role: 'user', content: '当前指令' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/session-context-reconstructor.test.ts`
Expected: FAIL——`rebuildSessionContext` 未导出（import 报错）。

- [ ] **Step 3: 实现（turn-reconstructor.ts 文件尾部追加）**

import 区追加（`'../storage/messages/repo'` 既有 import 合并、`compaction/serialize` 新增）：

```ts
import {
  getMessageByStreamSessionId,
  listMessagesByStreamSessionId,
  listRecentMessagesBySession,
  type MessageRow,
} from '../storage/messages/repo';
import { TOOL_RESULT_MAX_LEN, TRUNCATED_MARKER } from '../compaction/serialize';
```

文件尾部追加：

```ts
// ══ 会话连续性（spec 2026-09-14 §4）：主会话跨轮上下文 events 级重建 ══
//
// 与 rebuildTurn（单流断点续跑）/ rebuildSubConversation（子 agent 链续聊）同源的
// 第三条重建路径——主会话「下一轮」的 convCtx。此前该路径走 memory provider 的
// messages.body 启发式拼接（最早 20 行、无工具层、中断轮空正文），本函数对齐
// events 级保真：message_events 是事件溯源单一真相源，UI 与模型可见性拉平。

/** 会话重建选项 */
export interface SessionContextOptions {
  /** 窗口内「回合单位」数上限（owner 单位与流族单位同权计数），默认 20 */
  limitTurns?: number;
  /**
   * 丢弃时序最后的 owner 行（= 当前轮输入，runtime-entry 的 turnMessages 已含，
   * 不剔除则当前指令双拼）。顶层 chat / resume 路径恒传 true。
   */
  excludeTrailingOwnerRow?: boolean;
}

/** 会话重建结果 */
export interface RebuiltSessionContext {
  /** LLM 消息序列（含 tool 角色），可直接拼进 LLM 请求 */
  messages: LLMMessage[];
  /** 与 messages 平行的 DB createdAt（合成条取语义等价值）；供 compaction coveredUntil 精确化 */
  timestamps: number[];
}

/** 行拉取上限：两次 compaction 之间行数超此值的会话，窗口退化为最近 200 行内分组 */
const SESSION_ROW_FETCH_MARGIN = 200;
/** 默认窗口单位数 */
const DEFAULT_LIMIT_TURNS = 20;

/** 回合单位：owner 消息 | agent 流族（base + #roll，#seg 排除） */
type SessionUnit =
  | { kind: 'owner'; row: MessageRow }
  | { kind: 'family'; baseSsi: string; startTs: number; endTs: number; messages: LLMMessage[] };

/**
 * 重建会话跨轮 LLM 上下文（同步；纯读取）。
 *
 * 单位分组（spec §4.2）：ASC 行序遍历——owner 行为 user 单位；agent 流族首行触发
 * rebuildStreamMessages({includeUser:false}) 展开为 assistant/tool 消息族；#seg 快照行、
 * #roll 后续行、子 agent 流行（parent 非空且非 owner——子 agent 回复经父流 dispatch
 * 工具结果事件进入上下文）跳过。
 *
 * steer 行去重：owner 行落在某族时间窗 [族首行 created_at, 族末事件 created_at] 内
 * = steer 消息行（先落库、后由族内 steer 事件渲染 [用户中途补充]），walk 层跳过防
 * 双渲染；未 drain 的 steer（子进程死前未消费，无事件）只剩 owner 行，正常渲染。
 *
 * 降级：单族重建抛错跳过该族（warn）；整体抛错返回空上下文（fresh-session 形态，
 * 安全方向）。
 */
export function rebuildSessionContext(
  sessionId: string,
  opts?: SessionContextOptions,
): RebuiltSessionContext {
  try {
    // 直读 session_compactions（provider 既有先例：避免与 compaction/service 的静态循环依赖）
    const compaction = getDb()
      .prepare(
        'SELECT summary, covered_until AS coveredUntil FROM session_compactions WHERE session_id = ?',
      )
      .get(sessionId) as { summary: string; coveredUntil: number } | undefined;

    const rows = listRecentMessagesBySession(
      sessionId,
      SESSION_ROW_FETCH_MARGIN,
      compaction ? { afterTs: compaction.coveredUntil } : undefined,
    );

    // ① 骨架 + 族展开
    const units: SessionUnit[] = [];
    const seenFamilies = new Set<string>();
    for (const row of rows) {
      if (row.segmentOf !== null) continue; // #seg 快照行：事件在父行，快照无增量信息
      const isOwnerRow = row.sender === 'owner';
      // 子 agent 流行跳过（父流 dispatch 工具结果已携带其回复）；
      // owner 行带 parent（dispatch_followup 追问行）保留为 user 单位
      if (row.parentStreamSessionId !== null && !isOwnerRow) continue;
      if (isOwnerRow && !row.streamSessionId) {
        units.push({ kind: 'owner', row });
        continue;
      }
      const ssi = row.streamSessionId;
      if (!ssi) continue; // 防御：agent 行无流 id（契约外形态）
      const baseSsi = ssi.split('#')[0] ?? ssi;
      if (seenFamilies.has(baseSsi)) continue; // #roll 换行 / 族内重复行
      seenFamilies.add(baseSsi);
      const rebuilt = rebuildStreamMessages(baseSsi, {
        includeUser: false,
        undrainedSteersAsUser: true,
      });
      units.push({
        kind: 'family',
        baseSsi,
        startTs: row.createdAt,
        endTs: rebuilt.endTs,
        messages: rebuilt.messages,
      });
    }

    // ② steer 行去重 + 空轮流剔除
    const families = units.filter(
      (u): u is Extract<SessionUnit, { kind: 'family' }> => u.kind === 'family',
    );
    let rendered = units.filter((u) => {
      if (u.kind === 'owner') {
        return !families.some(
          (f) => u.row.createdAt >= f.startTs && u.row.createdAt <= f.endTs,
        );
      }
      return u.messages.length > 0; // 零输出事件的族（含 aborted 空转）整体跳过
    });

    // ③ 剔除时序最后的 owner 单位（当前轮输入，turnMessages 已含）
    if (opts?.excludeTrailingOwnerRow) {
      for (let i = rendered.length - 1; i >= 0; i--) {
        if (rendered[i]!.kind === 'owner') {
          rendered = rendered.slice(0, i).concat(rendered.slice(i + 1));
          break;
        }
      }
    }

    // ④ 窗口裁剪：最后 limitTurns 个单位
    const limitTurns = opts?.limitTurns ?? DEFAULT_LIMIT_TURNS;
    const windowed = rendered.slice(-limitTurns);

    // ⑤ 展平 + 平行时间戳（族单位消息统一取族首行时刻——回合粒度，
    // runCompaction 的 turnStart-1 兜底语义不受影响）
    const messages: LLMMessage[] = [];
    const timestamps: number[] = [];
    for (const u of windowed) {
      if (u.kind === 'owner') {
        messages.push({ role: 'user', content: u.row.body });
        timestamps.push(u.row.createdAt);
      } else {
        messages.push(...u.messages);
        for (let i = 0; i < u.messages.length; i++) timestamps.push(u.startTs);
      }
    }

    // ⑥ prune：最后一条 user 消息之前的旧轮 tool 结果截断（常量与 compaction 同源，
    // 防 双份漂移；与 provider pruneOldToolResults 同规则）
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const cutoff = lastUserIdx === -1 ? messages.length : lastUserIdx;
    for (let i = 0; i < cutoff; i++) {
      const m = messages[i]!;
      if (m.role === 'tool' && m.content.length > TOOL_RESULT_MAX_LEN) {
        m.content = `${m.content.slice(0, TOOL_RESULT_MAX_LEN)}\n${TRUNCATED_MARKER}`;
      }
    }

    // ⑦ compaction 摘要头注入（合成条不参与 ⑥ 的截断与锚点判定）
    if (compaction) {
      messages.unshift({
        role: 'user',
        content: `[此前对话压缩摘要]\n${compaction.summary}`,
      });
      timestamps.unshift(compaction.coveredUntil);
    }

    return { messages, timestamps };
  } catch (err) {
    logger.warn('rebuildSessionContext 重建失败，降级为空上下文（fresh-session 形态）', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], timestamps: [] };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/session-context-reconstructor.test.ts`
Expected: PASS（T1-T7 全绿；如 T3a 时间窗判定失败，检查 `bumpStreamEventTs` 是否把 steer 事件时刻抬到了 owner 行之后）。

- [ ] **Step 5: 跑 turn-reconstructor 既有矩阵（防重构串扰）**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/turn-reconstructor.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/turn-reconstructor.ts electron/tests/agent/session-context-reconstructor.test.ts
git commit -m "feat: rebuildSessionContext 主会话跨轮上下文 events 级重建（B1/B2/B3/B6）"
```

---

### Task 5: runtime-entry 顶层路径接线（集成回归锁）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts:426-435`（convCtx 拉取）、`:593-606`（convMessages / convTimes 构建）
- Test: `electron/tests/agent/runtime-session-context.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 `rebuildSessionContext` / `RebuiltSessionContext`
- Produces: 顶层 chat 与 resume 路径的 convCtx 来源切换为 events 级重建（无对外接口变更）

- [ ] **Step 1: 写失败测试（新建文件，骨架照抄 runtime-memory-injection.test.ts）**

```ts
// electron/tests/agent/runtime-session-context.test.ts
//
// 会话连续性 B 段集成回归锁（spec 2026-09-14 §4.5-1 集成级）：
// 真实 DB seed「bash 指令 → bash 工具对 → aborted」历史回合 + 当前指令行 →
// runChatLoop 首次 LLM 请求的 messages 必须携带完整工具对、当前指令恰一次。
// 模式对齐 runtime-memory-injection.test.ts（mock llm-provider + stub memory）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import type { PinnedMemoryView } from '../../src/main/memory/injection';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

// mock electron：stream-relay 生产落库链在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';

const ROOM_ID = '!room:ctx';
const tmpRoot = path.join(os.tmpdir(), `ap-rt-ctx-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetEventBufferForTest();
});

afterEach(() => {
  __resetEventBufferForTest();
  __resetMemoryProviderForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** seed 历史回合（用户案例最小仿真）+ 当前指令行（生产时序：先落库后派发） */
function seedHistory(): void {
  const T0 = Date.now();
  const setTs = (id: string, ts: number): void =>
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, id);

  const u1 = insertMessage({ sessionId: ROOM_ID, sender: 'owner', eventType: 'm.room.message', body: '帮我使用bash访问一下bing' });
  setTs(u1.id, T0 + 100);

  __routeChunkToBufferForTest({
    type: 'start', streamSessionId: 'hist-1', sessionId: ROOM_ID, senderAgentId: 'agent-coder-x',
  });
  __flushEventBufferForTest();
  getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(T0 + 200, 'hist-1');

  __routeChunkToBufferForTest({
    type: 'tool_call', streamSessionId: 'hist-1', callId: 'hc1', toolName: 'bash',
    args: { command: 'curl https://www.bing.com' },
  });
  __routeChunkToBufferForTest({
    type: 'tool_result', streamSessionId: 'hist-1', callId: 'hc1', toolName: 'bash',
    result: 'HTTP状态码: 200', success: true,
  });
  __flushEventBufferForTest();
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE created_at < ?`,
  ).run(T0 + 250, T0 + 250);
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'hist-1', finishReason: 'interrupted' });
  __flushEventBufferForTest();

  const cur = insertMessage({ sessionId: ROOM_ID, sender: 'owner', eventType: 'm.room.message', body: '访问百度' });
  setTs(cur.id, T0 + 300);
}

/** stub memory：getConversationContext 显式抛错——顶层路径已切换 rebuildSessionContext，误调用即响亮失败 */
function makeStubProvider(): MemoryProvider {
  return {
    getPinnedContext: async (): Promise<PinnedMemoryView> => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
    getTaskContext: async () => null,
    getConversationContext: async (): Promise<never> => {
      throw new Error('顶层路径不再消费 provider 会话上下文（spec 2026-09-14 B 段）');
    },
    getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
    getUserContext: async () => ({ preferences: [] }),
    getWorkspaceContext: async () => null,
    searchMemories: async () => [],
    saveMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
    deleteMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
  };
}

// makeConfig / makeContext / mockProvider / firstChatStreamMessages 四个 helper
// 逐字照抄 runtime-memory-injection.test.ts:73-155（含 buildToolRegistry 组装），
// 本文件仅 ROOM_ID 传 '!room:ctx'。此处不重复展开——复制时保留原注释。

describe('runChatLoop 顶层上下文 events 级重建（B 段接线）', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    // mockProvider()：chatStream 产出 text + done(stop)
  });

  it('历史工具对完整进入新一轮 LLM 请求，当前指令恰出现一次', async () => {
    seedHistory();
    __setMemoryProviderForTest(makeStubProvider());

    await runChatLoop(ROOM_ID, '访问百度', makeConfig(), makeContext());

    const msgs = firstChatStreamMessages() as Array<{
      role: string; content: string; toolCalls?: Array<{ name: string }>; toolCallId?: string;
    }>;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: '帮我使用bash访问一下bing' });
    expect(msgs[2]).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'bash' }] });
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'hc1' });
    expect(msgs[4]).toEqual({ role: 'user', content: '访问百度' });
    expect(msgs.filter((m) => m.content === '访问百度')).toHaveLength(1);
    // 中断轮不产生空 assistant 消息
    expect(msgs.some((m) => m.role === 'assistant' && m.content === '' && !m.toolCalls?.length)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/runtime-session-context.test.ts`
Expected: FAIL——旧实现下 messages 为 `[system, user(bing), assistant(''), user(百度), user(百度)]`（assistant 空正文、指令双拼），断言不匹配。

- [ ] **Step 3: 实现接线（runtime-entry.ts 两处）**

① import 区追加：

```ts
import { rebuildSessionContext, type RebuiltSessionContext } from './turn-reconstructor';
```

② 426-435 区域（`const [taskCtx, convCtx]` 块）替换为：

```ts
  // v2（B 子系统 Task B11）：MemoryProvider 取代 loadRecentHistory。
  // 会话连续性 B 段（spec 2026-09-14 §4）：顶层/resume 的 convCtx 从 provider
  // body 拼接切换为 events 级重建（工具对跨轮可见 / 中断轮合成结果 / 最近窗口 /
  // 剔除当前指令行防双拼）。子 agent（parentStreamSessionId 非空）走 fresh
  // session 不拉房间历史——fresh 行为由空上下文自然实现。
  const memory = getMemoryProvider();
  const [taskCtx, sessionCtx]: [TaskContext | null, RebuiltSessionContext | null] =
    await Promise.all([
      config.currentTaskId ? memory.getTaskContext(config.currentTaskId) : Promise.resolve(null),
      parentStreamSessionId
        ? Promise.resolve(null)
        : Promise.resolve(rebuildSessionContext(roomId, { limitTurns: 20, excludeTrailingOwnerRow: true })),
    ]);
```

③ 593-606 区域替换为：

```ts
  const convMessages: LLMMessage[] = sessionCtx?.messages ?? [];
```

```ts
  // ─── coveredUntil 精确化支撑（T5 遗留 Important-1，T6 修复） ────────────────
  // 回合开始时刻：回合内生成消息（assistant/tool/steer）的 DB 落库时刻下界——
  // LLM 首轮请求发生在 turnStart 之后，chunk 路径落库只会更晚。
  const turnStart = Date.now();
  // convCtx 来源消息的 DB createdAt（rebuildSessionContext 的平行 timestamps）。
  // WeakMap 按引用跟随：runCompaction 重建 messages 数组后，尾部的 convCtx 条目
  // 仍携带精确时刻；查不到 = 回合内消息 / 重建降级 → 保守取 turnStart - 1（见
  // runCompaction）。
  const convTimes = new WeakMap<LLMMessage, number>();
  convMessages.forEach((m, i) =>
    convTimes.set(m, sessionCtx?.timestamps[i] ?? turnStart - 1),
  );
```

（原 605-606 的 `convCtx.messages.forEach` 版本整段删除；`sessionCtx` 为 null 的子 agent 路径下 `convMessages` 为空数组，WeakMap 为空，行为与旧实现一致。）

- [ ] **Step 4: 跑测试确认通过 + 既有 runtime 套件回归**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run tests/agent/runtime-session-context.test.ts tests/agent/runtime-memory-injection.test.ts tests/agent/runtime-resume.test.ts tests/agent/compact-auto.test.ts tests/agent/compact-wrapup.test.ts`
Expected: PASS。注意 `runtime-memory-injection.test.ts` 的 stub `getConversationContext` 返回 `({ messages: [] })`——B 段后顶层路径不再调用它，stub 静默闲置不致失败；若其断言显式依赖调用次数则按新契约调整断言（不得删除测试）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/runtime-entry.ts electron/tests/agent/runtime-session-context.test.ts
git commit -m "feat: runChatLoop 顶层上下文切换为 events 级重建并消除当前指令双拼"
```

---

### Task 6: 全量验证 + 研发账本

**Files:**
- Modify: `CHANGELOG.md`（研发账本条目；**不动版本号**）

- [ ] **Step 1: 双 workspace typecheck**

Run: `nvm use 20 && npx pnpm@9.0.0 typecheck`（workdir 仓库根）
Expected: 0 error。

- [ ] **Step 2: 全量单测**

Run: `nvm use 20 && npx pnpm@9.0.0 test`
Expected: electron + renderer 全绿；如遇与本改动无关的既有失败，记录并上报，不扩面修。

- [ ] **Step 3: CHANGELOG 研发账本**

在 CHANGELOG 研发账本（v2.x 段）追加条目，格式对齐既有条目：

```markdown
- **会话连续性修复（A+B）** `2026-09-14`
  - fix: 会话上下文窗口「最早 N 条」→「最近 N 条」（getConversationContext；ASC+LIMIT 语义陷阱，/compact 早在 v30 注释警示）
  - fix: aborted/failed 空 body 行合成中断/失败标记（防 Anthropic 空 assistant 400 + 模型可见信号）
  - feat: rebuildSessionContext——主会话跨轮上下文 events 级重建，工具调用/结果跨轮可见、中断轮孤儿 call 自动合成结果、steer 行时间窗去重、当前指令行双拼消除（spec: docs/specs/2026-09-14-session-continuity-design.md）
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 研发账本补记会话连续性修复（A+B）"
```

---

## 计划自查记录

- **Spec 覆盖**：A1→Task1+2；A2→Task2；B0 红测试→Task2 Step1；B 核心重建→Task3+4；runtime 接线→Task5；§4.5 测试矩阵 1-8→Task4(T1-T7)+Task5(集成)+Task6(全量)；M3 账本→Task6。无遗漏。
- **占位符**：Task5 Step1 的 makeConfig/makeContext/mockProvider/firstChatStreamMessages 四个 helper 标注「逐字照抄 runtime-memory-injection.test.ts:73-155」——指向仓库真实存在的代码文件而非计划内任务，执行者可直接读取复制；其余步骤代码完整。
- **类型一致性**：`listRecentMessagesBySession(sessionId, limit, opts?)`（Task1 定义，Task2/4 消费）；`rebuildStreamMessages`（Task3 定义，Task4 消费）；`rebuildSessionContext(sessionId, opts?) → { messages, timestamps }`（Task4 定义，Task5 消费）——三处签名已交叉核对一致。
