# 跨会话引用实施计划（@ 会话 pill + list_sessions / read_session 工具）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能按需读取同 workspace 内另一会话的内容（正文 + 工具调用摘要），用户可在输入框 `@` 引用会话以指针注入 context。

**Architecture:** 双通道收敛于 `read_session`——agent 侧新增 `SessionTools`（`list_sessions` 发现消歧 + `read_session` 范围门读取，runtime 子进程直连 SQLite）；用户侧 `@` 菜单加「会话」组 → session pill → `MessageContext.sessions` 指针 → 主进程 expander 校验降级 → `<user-context>` 注入 `<session>` 块提示 agent 调工具。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React renderer（ESM + zustand）、vitest（双 workspace）。

**Spec:** `docs/specs/2026-09-30-session-reference-design.md`（本计划 argues from spec，executor 须同时读 spec §4–§8）

**计划对 spec 的一处精化（实施裁定）**：`ExpandedContext.sessions` 以**可选字段**落地（`sessions?: ExpandedSessionItem[]`），而非 spec §6 字面写的必填——旧 steer / resume 线上载荷没有该字段，必填会让 TS 类型对存量载荷撒谎；消费方（`renderUserContext`）统一 `context.sessions ?? []`，语义与 spec「消费方按 [] 处理」一致。

## Global Constraints

- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error` 已启用）。
- 所有代码注释中文；标识符英文。
- Node 20（`nvm use 20`）；包管理 `npx pnpm@9.0.0`。
- 测试位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（与被测文件同目录）。
- renderer UI 只用语义 token（`bg-surface-*` / `text-secondary` 等），图标 lucide-react 16px / stroke 1.75，禁标准 Tailwind 色阶、禁 emoji 图标（工具**输出文本**中的 🔧/📤 不属 UI，允许）。
- 版本号不动（研发期版本号纪律）；Conventional Commits（`feat:` / `test:` / `refactor:`）。
- 遵循项目 skills：写测试 → `momo-test-rules`；改协议面 → `momo-boundary-rules`；改 UI → `momo-ui-preview-rules`。
- 单测跑法：`cd electron && npx pnpm@9.0.0 vitest run tests/...` 或 `cd renderer && npx pnpm@9.0.0 vitest run src/...`；每任务结束跑 `npx pnpm@9.0.0 typecheck`（根目录）。

## Review Focus

1. **sanitize 的 spread 透传陷阱**：`sanitizeMessageContext` 现实现 spread 透传未知字段——`sessions` 非数组 / 元素畸形若不显式剔除会原样落 `context_json`（协议漂移入口）。→ Task 5 三态测试锁（非数组剔字段 / 畸形元素剔除 / 合法保留）。
2. **parse 畸形不得 null 化整个 context**：`parseMessageContext` 若因 sessions 畸形返回 null，旧消息的 skills/files chip 全部消失（回归）。→ Task 6 测试：sessions 畸形时 skills/files 照常返回。
3. **范围门三连**：`read_session` 读不存在 / 跨 workspace / 自己所在会话，`list_sessions` 列出当前会话——隐私与冗余边界。→ Task 2 / Task 3 各自门测试。
4. **旧草稿往返**：`PILL_KINDS` 加 `'session'` 后，v1 六类 pill 的旧草稿 JSON 必须照常往返（不降级为纯文本）。→ Task 4 测试：旧草稿往返不变 + session 草稿新往返。
5. **expander 永不抛错**：sessions 项查找抛异常（DB 不可用）不得阻塞消息派发。→ Task 7 测试：sessionLookup 抛错 → 产出 `missing: true` 项，无异常逃逸。

---

### Task 1: messages repo 辅助函数（计数 + 首条用户消息）

**Files:**
- Modify: `electron/src/main/storage/messages/repo.ts`（文件末尾追加）
- Test: `electron/tests/storage/messages-repo.test.ts`（追加 describe 块）

**Interfaces:**
- Produces: `countMessagesBySession(sessionId: string): number`、`getFirstUserMessage(sessionId: string): MessageRow | null`——Task 2 的 `list_sessions` 消费。

- [ ] **Step 1: 写失败测试**（追加到 `messages-repo.test.ts` 末尾；该文件已有 `insertSession` / `insertMessage` import 与 `AP_USER_DATA_DIR` 建库 beforeEach——直接复用）

```typescript
import { countMessagesBySession, getFirstUserMessage } from '../../src/main/storage/messages/repo'; // 并入顶部既有 import

describe('countMessagesBySession / getFirstUserMessage（跨会话引用）', () => {
  it('countMessagesBySession：按会话计数，不含其它会话', () => {
    const s = insertSession({ workspaceId: 'w1', title: 't' });
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: 'a' });
    insertMessage({ sessionId: s.id, sender: 'coder-1', eventType: 'm.room.message', body: 'b' });
    insertMessage({ sessionId: 'other', sender: 'owner', eventType: 'm.room.message', body: 'c' });
    expect(countMessagesBySession(s.id)).toBe(2);
    expect(countMessagesBySession('nonexistent')).toBe(0);
  });

  it('getFirstUserMessage：取首条 sender=owner 消息；无用户消息 / 不存在 → null', () => {
    const s = insertSession({ workspaceId: 'w1', title: 't' });
    insertMessage({ sessionId: s.id, sender: 'coder-1', eventType: 'm.room.message', body: 'agent 先说' });
    const first = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '用户第一条' });
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '用户第二条' });
    expect(getFirstUserMessage(s.id)?.id).toBe(first.id);
    expect(getFirstUserMessage('nonexistent')).toBeNull();
    const s2 = insertSession({ workspaceId: 'w1', title: 't2' });
    insertMessage({ sessionId: s2.id, sender: 'coder-1', eventType: 'm.room.message', body: '只有 agent' });
    expect(getFirstUserMessage(s2.id)).toBeNull();
  });
});
```

注意：`insertMessage` 不支持指定 createdAt 顺序时，「首条」按插入序（`listMessagesBySession` 按 `created_at ASC`，同毫秒并列按 rowid 稳定序）——测试用例的断言顺序已按此设计，如遇同毫秒不稳定，在两次 insert 间 `await new Promise((r) => setTimeout(r, 2))`（该文件是同步风格，优先信任 rowid 稳定序）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts`
Expected: FAIL（`countMessagesBySession is not a function` 或 import 报错）

- [ ] **Step 3: 实现**（`electron/src/main/storage/messages/repo.ts` 文件末尾追加）

```typescript
/** 会话消息总数（跨会话引用 list_sessions 消费；不含其它会话） */
export function countMessagesBySession(sessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number };
  return row?.n ?? 0;
}

/** 会话首条用户（sender='owner'）消息；无用户消息 / 会话不存在 → null（list_sessions 预览消费） */
export function getFirstUserMessage(sessionId: string): MessageRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM messages WHERE session_id = ? AND sender = 'owner'
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(sessionId) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts`
Expected: PASS（全部用例，含既有）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/messages/repo.ts electron/tests/storage/messages-repo.test.ts
git commit -m "feat: messages repo 增加 countMessagesBySession / getFirstUserMessage（跨会话引用辅助）"
```

---

### Task 2: SessionTools 骨架 + `list_sessions` + 注册

**Files:**
- Create: `electron/src/main/agent/tools/session-tools.ts`
- Modify: `electron/src/main/agent/tools/index.ts`（注册）
- Test: `electron/tests/agent/tools/session-tools.test.ts`（新建）

**Interfaces:**
- Consumes: `listSessionsByWorkspace(workspaceId): SessionRow[]`、`listSessionMembers(sessionId)`、Task 1 的 `countMessagesBySession` / `getFirstUserMessage`、`listMembers(workspaceId): WorkspaceAgentMember[]`（`agent/crud`，成员含 `instanceId` / `agentUserId` / `name`）。
- Produces: `class SessionTools implements ToolModule`（Task 3 在同类上扩 `read_session`）；工具名 `list_sessions`。

**测试基建说明（momo-test-rules）**：核心读路径（sessions / messages repo）用真 SQLite（`AP_USER_DATA_DIR` + `runMigrations`，同 `messages-repo.test.ts` 模式）；仅 `../crud` 的 `listMembers`（显示名富化）mock 收窄到边界——它 JOIN 两张 agent 表，不属于本工具的被测逻辑。

- [ ] **Step 1: 写失败测试**（新文件 `electron/tests/agent/tools/session-tools.test.ts`）

```typescript
// electron/tests/agent/tools/session-tools.test.ts
//
// SessionTools.list_sessions 回归锁（spec 2026-09-30 §4.1）：
//   workspace 范围 / 排除当前会话 / 关键词过滤 / 消歧元信息（成员名、消息数、预览）。
// 核心读路径真 SQLite；listMembers（显示名富化）mock 收窄到边界。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { insertSession } from '../../../src/main/storage/sessions/repo';
import { addSessionMember } from '../../../src/main/storage/sessions/repo';
import { insertMessage } from '../../../src/main/storage/messages/repo';
import { SessionTools } from '../../../src/main/agent/tools/session-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

vi.mock('../../../src/main/agent/crud', () => ({
  listMembers: () => [
    { instanceId: 'inst-coder', agentUserId: 'coder-1', name: 'Coder', iconEmoji: null },
    { instanceId: 'inst-writer', agentUserId: 'writer-1', name: 'Writer', iconEmoji: null },
  ],
}));

const tmpRoot = path.join(os.tmpdir(), `momo-sess-tools-${Date.now()}`);

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

const mkCtx = (workspaceId: string, roomId: string): ToolContext => ({
  wsFs: {} as never,
  workspaceId,
  workspaceDir: '/tmp/ws',
  skillRegistry: {} as never,
  streamSessionId: 'ss-1',
  roomId,
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: [], deniedTools: [] },
  creatorUserId: 'owner',
});

describe('list_sessions', () => {
  it('列出本 workspace 会话，排除当前会话，带成员名/消息数/预览', async () => {
    const cur = insertSession({ workspaceId: 'ws-a', title: '当前会话' });
    const ref = insertSession({ workspaceId: 'ws-a', title: '设计讨论' });
    insertSession({ workspaceId: 'ws-b', title: '别家的会话' });
    addSessionMember(ref.id, 'inst-coder', true);
    insertMessage({ sessionId: ref.id, sender: 'owner', eventType: 'm.room.message', body: '我们讨论一下重构方案' });

    const out = await new SessionTools().execute('list_sessions', {}, mkCtx('ws-a', cur.id));

    expect(out).toContain('设计讨论');
    expect(out).toContain('Coder');
    expect(out).toContain('消息数=1');
    expect(out).toContain('我们讨论一下重构方案');
    expect(out).not.toContain('当前会话'); // 排除自身
    expect(out).not.toContain('别家的会话'); // workspace 范围门
    expect(out).toContain(ref.id); // id 必须出现（read_session 直达键）
  });

  it('keyword 标题子串过滤（大小写不敏感）', async () => {
    insertSession({ workspaceId: 'ws-a', title: 'Refactor Plan' });
    insertSession({ workspaceId: 'ws-a', title: '闲聊' });
    const out = await new SessionTools().execute(
      'list_sessions',
      { keyword: 'refactor' },
      mkCtx('ws-a', 'room-x'),
    );
    expect(out).toContain('Refactor Plan');
    expect(out).not.toContain('闲聊');
  });

  it('空会话与零命中', async () => {
    const s = insertSession({ workspaceId: 'ws-a', title: '空会话' });
    const out = await new SessionTools().execute('list_sessions', {}, mkCtx('ws-a', 'room-x'));
    expect(out).toContain('空会话');
    expect(out).toContain('消息数=0');
    expect(out).toContain(s.id);
    const miss = await new SessionTools().execute(
      'list_sessions',
      { keyword: '不存在的关键词' },
      mkCtx('ws-a', 'room-x'),
    );
    expect(miss).toContain('没有匹配的会话');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/session-tools.test.ts`
Expected: FAIL（`Cannot find module '.../session-tools'`）

- [ ] **Step 3: 实现 session-tools.ts**

```typescript
// electron/src/main/agent/tools/session-tools.ts
//
// 跨会话引用工具（spec 2026-09-30 §4）：
//   list_sessions —— 本 workspace 会话发现与消歧（标题关键词 + 元信息冗余）
//   read_session  —— 范围门（不存在/跨 workspace/读自己）+ 最近 N 条 + 工具调用摘要
// 严格只读：只 SELECT sessions / session_members / messages / message_events，
// 不写任何表。数据访问全部走既有 repo（本文件不含 SQL）。
import { listSessionsByWorkspace, listSessionMembers, type SessionRow } from '../../storage/sessions/repo';
import {
  countMessagesBySession,
  getFirstUserMessage,
  listRecentMessagesBySession,
  type MessageRow,
} from '../../storage/messages/repo';
import { listEventsForMessages, type MessageEventRow } from '../../storage/messages/events-repo';
import { exportAggregateEvents } from '../../im/export-aggregator';
import { listMembers } from '../crud';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';

/** list_sessions 默认 / 上限条数 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
/** 首条用户消息预览截断（字符） */
const PREVIEW_CHARS = 80;

/** 时间戳 → MM-DD HH:mm（工具输出行内紧凑格式） */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** workspace 成员显示名映射：agentUserId → name、instanceId → name；'owner' → '用户'（单用户应用 sender 约定） */
function buildNameMaps(ctx: ToolContext): { byUserId: Map<string, string>; byInstanceId: Map<string, string> } {
  const byUserId = new Map<string, string>();
  const byInstanceId = new Map<string, string>();
  try {
    for (const m of listMembers(ctx.workspaceId)) {
      byUserId.set(m.agentUserId, m.name);
      byInstanceId.set(m.instanceId, m.name);
    }
  } catch {
    // DB 不可用 → 空映射，sender 原样显示（降级不阻塞）
  }
  return { byUserId, byInstanceId };
}

const LIST_SESSIONS_DEF: LLMToolDef = {
  name: 'list_sessions',
  description:
    '列出当前 workspace 的会话（可用 read_session 读取内容）。支持按标题关键词过滤；' +
    '返回 id、类型、最近活跃、成员、消息数与首条用户消息预览，供消歧。当前会话不在列表中。',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '标题关键词（不区分大小写子串）；缺省列出全部' },
      limit: { type: 'number', description: `返回条数上限，默认 ${LIST_DEFAULT_LIMIT}，最大 ${LIST_MAX_LIMIT}` },
    },
  },
};

/** list_sessions 主逻辑（导出供单测直调渲染层） */
async function executeListSessions(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : LIST_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), LIST_MAX_LIMIT));

  const rows = listSessionsByWorkspace(ctx.workspaceId).filter((s) => s.id !== ctx.roomId);
  const matched = keyword === '' ? rows : rows.filter((s) => s.title.toLowerCase().includes(keyword));
  if (matched.length === 0) return '没有匹配的会话。可去掉关键词用 list_sessions 浏览全部，或与用户确认会话标题。';

  const { byInstanceId } = buildNameMaps(ctx);
  const lines: string[] = [];
  for (const s of matched.slice(0, limit)) {
    const members = listSessionMembers(s.id)
      .map((m) => byInstanceId.get(m.instanceId) ?? m.instanceId)
      .join('/');
    const preview = getFirstUserMessage(s.id)?.body ?? '';
    const previewText = preview === '' ? '（无用户消息）' : truncateString(preview, PREVIEW_CHARS);
    lines.push(
      `- id=${s.id} 《${s.title}》 [${s.kind}] 活跃=${formatTs(s.lastMessageAt ?? s.createdAt)} 消息数=${countMessagesBySession(s.id)}`,
      `  成员: ${members === '' ? '（无成员）' : members}  预览: ${previewText}`,
    );
  }
  const header = keyword === '' ? `共 ${Math.min(matched.length, limit)} 个会话：` : `关键词「${keyword}」命中 ${Math.min(matched.length, limit)} 个会话：`;
  return `${header}\n${lines.join('\n')}\n读取内容：read_session(sessionId=...)`;
}

/** SessionTools：跨会话引用工具模块（spec 2026-09-30 §4） */
export class SessionTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [LIST_SESSIONS_DEF];
  }

  handles(name: string): boolean {
    return name === 'list_sessions' || name === 'read_session';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'list_sessions') return executeListSessions(args, ctx);
    if (name === 'read_session') return executeReadSession(args, ctx);
    throw new Error(`未知 session 工具: ${name}`);
  }
}

// executeReadSession 在 read_session 任务（Task 3）落地；先以占位实现保证模块完整可注册。
async function executeReadSession(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  void args; void ctx;
  return 'read_session 尚未实现';
}
```

**同时修改** `electron/src/main/agent/tools/index.ts`：

```typescript
// 顶部 import 区追加（沿既有排序）
import { SessionTools } from './session-tools';
// 文件头注释「工具注册中心」清单追加一行：+ SessionTools（跨会话引用：list_sessions / read_session）
// buildToolRegistry 的 modules 数组追加：
    new SessionTools(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/session-tools.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: typecheck + 邻近回归**

Run: `npx pnpm@9.0.0 typecheck`（根目录）
Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts`
Expected: 均通过（copy-neutral 消费 getBuiltinLoopToolDefs / buildRuntimeContext，锁注册中心不回归）

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/tools/session-tools.ts electron/src/main/agent/tools/index.ts electron/tests/agent/tools/session-tools.test.ts
git commit -m "feat: SessionTools list_sessions（workspace 范围 + 排除当前会话 + 消歧元信息）"
```

---

### Task 3: `read_session`（范围门 + 分页 + B 颗粒度渲染）

**Files:**
- Modify: `electron/src/main/agent/tools/session-tools.ts`（替换占位 `executeReadSession`）
- Modify: `electron/src/main/agent/tools/shared/output-truncate.ts`（OUTPUT_LIMITS 加键）
- Test: `electron/tests/agent/tools/session-tools.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `getSession(id): SessionRow | null`（sessions repo）、`listEventsForMessages(ids): Map<string, MessageEventRow[]>`、`exportAggregateEvents(events)`（返回 `{ segments }`，segment 含 `{kind:'tool', callId, toolName, args, result: string|null, success: boolean|null}` 与 `{kind:'dispatch', callId, toolName, subStreamSessionId, subAgentName, task, status}`）。
- Produces: 工具名 `read_session`（后续任务不依赖其内部结构）。

- [ ] **Step 1: 写失败测试**（追加到 `session-tools.test.ts`；顶部 import 区补 `getSession`（sessions repo）、`insertEventBatch`（events-repo））

```typescript
import { getSession } from '../../../src/main/storage/sessions/repo'; // 并入既有 sessions/repo import
import { insertEventBatch } from '../../../src/main/storage/messages/events-repo';

describe('read_session', () => {
  it('范围门：不存在 / 跨 workspace / 读自己 → 明确文案，不做任何读取', async () => {
    const tools = new SessionTools();
    const out1 = await tools.execute('read_session', { sessionId: 'no-such' }, mkCtx('ws-a', 'room-x'));
    expect(out1).toContain('会话不存在');
    const other = insertSession({ workspaceId: 'ws-b', title: '别家' });
    const out2 = await tools.execute('read_session', { sessionId: other.id }, mkCtx('ws-a', 'room-x'));
    expect(out2).toContain('不在当前 workspace');
    const cur = insertSession({ workspaceId: 'ws-a', title: '自己' });
    const out3 = await tools.execute('read_session', { sessionId: cur.id }, mkCtx('ws-a', cur.id));
    expect(out3).toContain('已在你的上下文中');
  });

  it('默认最近 N 条 + 工具调用摘要（正文行 + 🔧 缩进行）+ 翻页提示', async () => {
    const s = insertSession({ workspaceId: 'ws-a', title: '参考会话' });
    const userMsg = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '帮我重构 X' });
    const agentMsg = insertMessage({ sessionId: s.id, sender: 'coder-1', eventType: 'm.room.message', body: '好的，完成重构' });
    insertEventBatch([
      { messageId: agentMsg.id, seq: 0, eventType: 'text_delta', payload: { delta: '好的' } },
      { messageId: agentMsg.id, seq: 1, eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'read_file', args: { path: 'src/x.ts' } } },
      { messageId: agentMsg.id, seq: 2, eventType: 'tool_call_result', payload: { callId: 'c1', toolName: 'read_file', result: 'export const a = 1;', success: true } },
    ]);
    void userMsg;

    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx('ws-a', 'room-x'));

    expect(out).toContain('参考会话');
    expect(out).toContain('用户: 帮我重构 X');       // sender='owner' → 「用户」
    expect(out).toContain('Coder: 好的，完成重构');   // agentUserId → 显示名（mock listMembers）
    expect(out).toContain('🔧 read_file');
    expect(out).toContain('src/x.ts');
    expect(out).toContain('beforeTs=');              // 翻页提示带本页最早时间戳
  });

  it('beforeTs 向前翻页 + dispatch 段渲染', async () => {
    const s = insertSession({ workspaceId: 'ws-a', title: '分页会话' });
    const m1 = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第一条' });
    await new Promise((r) => setTimeout(r, 5)); // 保证 created_at 严格递增
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第二条' });
    await new Promise((r) => setTimeout(r, 5));
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第三条' });
    const boundary = m1.createdAt + 2; // 严格小于第二条、大于第一条的切点

    const out = await new SessionTools().execute(
      'read_session',
      { sessionId: s.id, beforeTs: boundary },
      mkCtx('ws-a', 'room-x'),
    );
    expect(out).toContain('第一条');
    expect(out).not.toContain('第二条');
    expect(out).not.toContain('第三条');

    const d = insertSession({ workspaceId: 'ws-a', title: 'dispatch 会话' });
    const lead = insertMessage({ sessionId: d.id, sender: 'pm-1', eventType: 'm.room.message', body: '派发' });
    insertEventBatch([
      { messageId: lead.id, seq: 0, eventType: 'tool_call_start', payload: { callId: 'c9', toolName: 'dispatch', args: { task: '写文档' }, isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'Writer' } },
      { messageId: lead.id, seq: 1, eventType: 'tool_call_result', payload: { callId: 'c9', toolName: 'dispatch', result: '', success: true, subStatus: 'completed' } },
    ]);
    const out2 = await new SessionTools().execute('read_session', { sessionId: d.id }, mkCtx('ws-a', 'room-x'));
    expect(out2).toContain('📤 dispatch→Writer');
    expect(out2).toContain('写文档');
    expect(out2).toContain('completed');
  });

  it('空会话 → 元信息头 + 「会话无消息」', async () => {
    const s = insertSession({ workspaceId: 'ws-a', title: '空的' });
    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx('ws-a', 'room-x'));
    expect(out).toContain('会话无消息');
  });

  it('输出总量截断（OUTPUT_LIMITS.read_session）', async () => {
    const s = insertSession({ workspaceId: 'ws-a', title: '长会话' });
    for (let i = 0; i < 200; i++) {
      insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: `消息 ${i} `.repeat(50) });
    }
    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx('ws-a', 'room-x'));
    expect(out.length).toBeLessThanOrEqual(OUTPUT_LIMITS.read_session + 100); // 截断标记尾行容差
    expect(out).toContain('输出已截断');
  });
});
```

顶部还需 `import { OUTPUT_LIMITS } from '../../../src/main/agent/tools/shared/output-truncate';`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/session-tools.test.ts`
Expected: FAIL（read_session 用例全部失败——占位实现返回「尚未实现」）

- [ ] **Step 3: 实现**

`output-truncate.ts` 的 `OUTPUT_LIMITS` 追加一行（`office_read_cells` 之后）：

```typescript
  read_session: 30 * 1024,
```

`session-tools.ts`：顶部 import 区补 `getSession`（并入 sessions repo import）与 `READ_SESSION_DEF`；替换占位 `executeReadSession`：

```typescript
/** read_session 默认 / 上限条数 */
const READ_DEFAULT_LIMIT = 50;
const READ_MAX_LIMIT = 200;
/** 工具摘要行内截断（字符）：args / result / dispatch task */
const SUMMARY_ARG_CHARS = 120;
const SUMMARY_RESULT_CHARS = 200;
const SUMMARY_TASK_CHARS = 80;

const READ_SESSION_DEF: LLMToolDef = {
  name: 'read_session',
  description:
    '读取当前 workspace 内另一会话的内容：每条消息一行（时间/发送者/正文），agent 消息附工具调用摘要行。' +
    '默认返回最近 50 条；beforeTs / afterTs（毫秒时间戳，取自输出行时间对应值）可翻页。当前会话不可读。',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: '目标会话 id（list_sessions 获取）' },
      limit: { type: 'number', description: `本页条数，默认 ${READ_DEFAULT_LIMIT}，最大 ${READ_MAX_LIMIT}` },
      beforeTs: { type: 'number', description: '仅取 created_at 严格小于该值的消息（向更早翻页）' },
      afterTs: { type: 'number', description: '仅取 created_at 严格大于该值的消息（向更新翻页）' },
    },
    required: ['sessionId'],
  },
};

/** 单条 assistant 消息的工具摘要行（B 颗粒度；段聚合复用 export-aggregator，不重写配对逻辑） */
function renderToolSummaryLines(events: MessageEventRow[]): string[] {
  const { segments } = exportAggregateEvents(events);
  const lines: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'tool') {
      const argsStr = truncateString(JSON.stringify(seg.args ?? {}), SUMMARY_ARG_CHARS);
      const resultStr = seg.result === null ? '(结果未回传)' : truncateString(seg.result, SUMMARY_RESULT_CHARS);
      lines.push(`    🔧 ${seg.toolName}(${argsStr}) → ${seg.success === false ? '✗' : '✓'} ${resultStr}`);
    } else if (seg.kind === 'dispatch') {
      lines.push(`    📤 dispatch→${seg.subAgentName}: ${truncateString(seg.task, SUMMARY_TASK_CHARS)} (${seg.status})`);
    }
  }
  return lines;
}

async function executeReadSession(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const sessionId = parseStringArg(args.sessionId, 'sessionId');
  // 范围门三连（spec §4.2，先于任何内容读取）
  const session = getSession(sessionId);
  if (session === null) return `会话不存在（可能已解散）：${sessionId}`;
  if (session.workspaceId !== ctx.workspaceId) return `会话不在当前 workspace，拒绝读取：${sessionId}`;
  if (sessionId === ctx.roomId) return '这是当前会话，内容已在你的上下文中，无需读取。';

  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : READ_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), READ_MAX_LIMIT));
  const opts: { beforeTs?: number; afterTs?: number } = {};
  if (typeof args.beforeTs === 'number' && Number.isFinite(args.beforeTs)) opts.beforeTs = args.beforeTs;
  if (typeof args.afterTs === 'number' && Number.isFinite(args.afterTs)) opts.afterTs = args.afterTs;

  const messages = listRecentMessagesBySession(sessionId, limit, opts);
  const header =
    `会话《${session.title}》 [${session.kind}] 活跃=${formatTs(session.lastMessageAt ?? session.createdAt)}`;
  if (messages.length === 0) return `${header}\n会话无消息。`;

  const { byUserId } = buildNameMaps(ctx);
  const eventsByMsg = listEventsForMessages(messages.map((m) => m.id));
  const lines: string[] = [header];
  for (const m of messages) {
    const name = m.sender === 'owner' ? '用户' : (byUserId.get(m.sender) ?? m.sender);
    lines.push(`[${formatTs(m.createdAt)}] ${name}: ${m.body}`);
    const summary = renderToolSummaryLines(eventsByMsg.get(m.id) ?? []);
    lines.push(...summary);
  }
  const earliest = messages[0]!.createdAt;
  const footer = `本页 ${messages.length} 条（时间升序）。更早消息：read_session 工具传 beforeTs=${earliest}`;
  return truncateString(`${lines.join('\n')}\n${footer}\n（输出已截断提示：如需更早内容请用更小 limit 或 beforeTs 分段读取）`, OUTPUT_LIMITS.read_session);
}
```

同时 `getDefs()` 返回 `[LIST_SESSIONS_DEF, READ_SESSION_DEF]`；删除占位注释行。

**实现注意**：最后对截断尾行的处理——上面代码在正文后固定拼了一行「（输出已截断提示…）」说明性文字，与测试断言 `toContain('输出已截断')` 对齐；若最终实现改为仅超限时由 `truncateString` 追加标记，请同步改测试断言为 `toContain('截断')`（`truncateString` 的标记文案是 `…(截断，原 N 字节)`）。二选一，保持断言与实现一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/session-tools.test.ts`
Expected: PASS（list + read 全部用例）

- [ ] **Step 5: typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双 workspace 0 error

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/tools/session-tools.ts electron/src/main/agent/tools/shared/output-truncate.ts electron/tests/agent/tools/session-tools.test.ts
git commit -m "feat: SessionTools read_session（范围门三连 + 最近 N 条翻页 + 正文/工具摘要 B 颗粒度）"
```

---

### Task 4: `MessageContext.sessions` 契约 + session pill 序列化

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（`ImageContextItem` 之后、`MessageContext` 之前插入）
- Modify: `renderer/src/components/im/composer-segments.ts`
- Test: `renderer/src/components/im/composer-segments.test.ts`（追加）

**Interfaces:**
- Produces: `SessionContextItem { sessionId: string; title: string }`、`MessageContext.sessions?: SessionContextItem[]`、`PillKind` 含 `'session'`——Task 5/6/7/9/10 全部依赖这三个名字。
- 序列化规则（与 agent/file pill 一致，**不同于 skill 的正文透明**）：body 追加 `@<label>`，`context.sessions` 按 sessionId 去重保序。

- [ ] **Step 1: 写失败测试**（追加到 `composer-segments.test.ts`）

```typescript
describe('session pill 序列化（跨会话引用）', () => {
  const sessPill = { type: 'pill' as const, kind: 'session' as const, id: 'sess-9', label: '设计讨论' };

  it('body 锚点 @标题 + context.sessions', () => {
    const out = serializeSegments([{ type: 'text', text: '参考' }, sessPill, { type: 'text', text: '写计划' }]);
    expect(out.body).toBe('参考 @设计讨论 写计划');
    expect(out.context?.sessions).toEqual([{ sessionId: 'sess-9', title: '设计讨论' }]);
  });

  it('重复 session pill：body 保留两处，结构化数组去重', () => {
    const out = serializeSegments([sessPill, { type: 'text', text: '和' }, sessPill]);
    expect(out.body).toBe('@设计讨论 和 @设计讨论 ');
    expect(out.context?.sessions).toEqual([{ sessionId: 'sess-9', title: '设计讨论' }]);
  });

  it('仅 session pill：context 携带 sessions（合法空 body 消息）', () => {
    const out = serializeSegments([sessPill]);
    expect(out.body).toBe('@设计讨论 ');
    expect(out.context).toBeDefined();
  });

  it('草稿往返：session pill 不丢；旧版六类 pill 草稿不受影响', () => {
    const round = draftToSegments(segmentsToDraft([sessPill, { type: 'text', text: 'hi' }]));
    expect(round).toEqual([sessPill, { type: 'text', text: 'hi' }]);
    const legacy = JSON.stringify([
      { type: 'pill', kind: 'agent', id: 'a1', label: 'Coder' },
      { type: 'text', text: '旧草稿' },
    ]);
    expect(draftToSegments(legacy)).toEqual([
      { type: 'pill', kind: 'agent', id: 'a1', label: 'Coder' },
      { type: 'text', text: '旧草稿' },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/composer-segments.test.ts`
Expected: FAIL（`kind: 'session'` 类型错误 / body 断言不符——现 switch 无该 case，body 只有标记分隔空格）

- [ ] **Step 3: 实现**

`types.d.ts`（`ImageContextItem` 接口之后插入）：

```typescript
/** 输入框上下文项——会话引用（指针级；完整内容由 agent 用 read_session 工具按需读取，spec 2026-09-30 §6） */
export interface SessionContextItem {
  sessionId: string;
  /** 展示名（选择时从会话列表快照，chip 渲染不反查） */
  title: string;
}
```

`MessageContext` 接口追加（`images` 之后）：

```typescript
  /** 会话引用（可选：旧消息 / 无引用缺省 = 无；指针级，内容由 read_session 按需读） */
  sessions?: SessionContextItem[];
```

`composer-segments.ts`：

1. `PillKind` 类型改为七类并更新头注释：

```typescript
/** pill 七类：agent / 文件 / 任务 / 技能 / 命令 / 图片 / 会话（spec §3 表 + 2026-09-26 多模态 §10 + 2026-09-30 跨会话引用 §5） */
export type PillKind = 'agent' | 'file' | 'task' | 'skill' | 'command' | 'image' | 'session';
```

2. `serializeSegments` 内：与 `skills` / `files` / `images` 声明并列加 `const sessions: Array<{ sessionId: string; title: string }> = [];`；switch 加 case（`image` case 之后）：

```typescript
      case 'session':
        body += `@${seg.label}`;
        if (!sessions.some((s) => s.sessionId === seg.id)) sessions.push({ sessionId: seg.id, title: seg.label });
        break;
```

3. 返回值 context 组装改为：

```typescript
    context:
      skills.length > 0 || files.length > 0 || images.length > 0 || sessions.length > 0
        ? {
            skills,
            files,
            ...(images.length > 0 ? { images } : {}),
            ...(sessions.length > 0 ? { sessions } : {}),
          }
        : undefined,
```

4. `PILL_KINDS` 常量追加 `'session'`；序列化规则头注释补一行：`session → body @label + context.sessions（按 sessionId 去重——指针注入，正文锚点无双重曝光，spec 2026-09-30 §5）`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/composer-segments.test.ts`
Run: `npx pnpm@9.0.0 typecheck`
Expected: 测试全 PASS；typecheck 双 workspace 0 error（`RichComposer` 的 `PILL_CLASS: Record<PillKind, string>` 会报缺 `session` 键——**本任务一并补**：`PILL_CLASS` 追加 `session: 'bg-surface-active text-secondary',`（临时值，Task 10 预览门禁定稿；`pillDisplayText` 的 switch 因有穷尽性检查也需加 `case 'session': return `@${pill.label}`;`——这两处提前到这里做，避免留编译红）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/ipc/types.d.ts renderer/src/components/im/composer-segments.ts renderer/src/components/im/RichComposer.tsx renderer/src/components/im/composer-segments.test.ts
git commit -m "feat: MessageContext.sessions 契约 + session pill 序列化（指针注入 + 正文锚点）"
```

---

### Task 5: IPC 入口 `sanitizeMessageContext` sessions 校验

**Files:**
- Modify: `electron/src/main/im/session.ipc.handlers.ts`
- Test: `electron/tests/im/session.ipc.handlers.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 的 `SessionContextItem`。
- Produces: sanitize 后的 `context.sessions` 只含 `{sessionId: 非空 string, title: string}` 元素；非数组 sessions 字段被剔除（不透传）。

- [ ] **Step 1: 写失败测试**（追加到既有 sanitize describe 块）

```typescript
describe('sanitizeMessageContext sessions（跨会话引用）', () => {
  it('合法 sessions 保留；畸形元素剔除；sessionId 空串剔除', () => {
    const out = sanitizeMessageContext({
      skills: [],
      files: [],
      sessions: [
        { sessionId: 's1', title: '会话一' },
        { sessionId: '', title: '空 id' },
        { sessionId: 42, title: '坏 id' },
        { title: '缺 id' },
        null,
      ],
    });
    expect(out?.sessions).toEqual([{ sessionId: 's1', title: '会话一' }]);
  });

  it('sessions 非数组 → 字段剔除（spread 透传陷阱回归锁）', () => {
    const out = sanitizeMessageContext({ skills: [], files: [], sessions: 'garbage' });
    expect(out?.sessions).toBeUndefined();
    expect(out).toEqual({ skills: [], files: [] });
  });

  it('缺省 sessions → 不产生字段（旧载荷形状不变）', () => {
    const out = sanitizeMessageContext({ skills: [], files: [] });
    expect(out).toEqual({ skills: [], files: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/session.ipc.handlers.test.ts`
Expected: FAIL（现状 spread 透传：`sessions: 'garbage'` 会原样出现在返回值）

- [ ] **Step 3: 实现**（`sanitizeMessageContext` 内，images 处理之后）

import 区补 `SessionContextItem`（并入 types import）；解构与组装改为：

```typescript
  const sessions = Array.isArray(c.sessions)
    ? c.sessions.filter(
        (s): s is SessionContextItem =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as SessionContextItem).sessionId === 'string' &&
          (s as SessionContextItem).sessionId !== '' &&
          typeof (s as SessionContextItem).title === 'string',
      )
    : undefined;
  // spread 保留外层未知字段（透传宽容）；images / sessions 单独处理——
  // 非数组时剔除字段（spread 会把垃圾形状原样透传）
  const { images: _rawImages, sessions: _rawSessions, ...rest } = c;
  return {
    ...rest,
    skills,
    files,
    ...(images !== undefined ? { images } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
  };
```

（原 return 的 images 三分支展开合并为上式；既有 images 用例必须全数通过——跑全文件回归。）

- [ ] **Step 4: 跑测试确认通过（全文件）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/session.ipc.handlers.test.ts`
Expected: PASS（含既有 images / skills / files 全部用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/session.ipc.handlers.ts electron/tests/im/session.ipc.handlers.test.ts
git commit -m "feat: sanitizeMessageContext sessions 元素级校验（堵 spread 透传）"
```

---

### Task 6: renderer `parseMessageContext` sessions 校验

**Files:**
- Modify: `renderer/src/lib/message-context.ts`
- Test: `renderer/src/lib/message-context.test.ts`（追加）

**Interfaces:**
- Produces: `parseMessageContext` 返回值携带合法 `sessions`；sessions 畸形 → 视为无引用但 **skills/files 照常返回**（不 null 化整体）。

- [ ] **Step 1: 写失败测试**

```typescript
describe('parseMessageContext sessions（跨会话引用）', () => {
  it('合法 sessions 解析', () => {
    const out = parseMessageContext(
      JSON.stringify({ skills: [], files: [], sessions: [{ sessionId: 's1', title: '会话一' }] }),
    );
    expect(out?.sessions).toEqual([{ sessionId: 's1', title: '会话一' }]);
  });

  it('sessions 畸形（含坏元素）→ 剔除字段，skills/files 不受牵连（回归锁）', () => {
    const out = parseMessageContext(
      JSON.stringify({
        skills: [{ slug: 'x', name: 'X' }],
        files: [{ path: 'a.ts' }],
        sessions: [{ sessionId: 'ok', title: '好' }, { sessionId: 1 }],
      }),
    );
    expect(out).toEqual({ skills: [{ slug: 'x', name: 'X' }], files: [{ path: 'a.ts' }] });
  });

  it('sessions 非数组 → 视为无引用', () => {
    const out = parseMessageContext(JSON.stringify({ skills: [], files: [], sessions: 'bad' }));
    expect(out?.sessions).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/message-context.test.ts`
Expected: FAIL（现实现无 sessions 处理：`out?.sessions` 为 undefined 会让第一例失败）

- [ ] **Step 3: 实现**（`message-context.ts`，镜像 images 模式）

```typescript
/** sessions 字段形状校验：合法数组原样返回；缺省 / 非数组 / 含畸形元素 → null（视为无会话引用） */
function shapeValidSessions(v: unknown): MessageContext['sessions'] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { sessionId: unknown }).sessionId === 'string' &&
      typeof (s as { title: unknown }).title === 'string',
  );
  return ok ? (v as MessageContext['sessions']) : null;
}
```

`parseMessageContext` 内 images 处理后并列追加 sessions，组装返回值（三态都不得丢 skills/files）：

```typescript
    const images = shapeValidImages(v.images);
    const sessions = shapeValidSessions(v.sessions);
    const base = { skills: v.skills, files: v.files };
    if (images !== null && sessions !== null) return { ...base, images, sessions };
    if (images !== null) return { ...base, images, ...(sessions === null ? {} : {}) };
    // 逐字段独立：images / sessions 各自合法才携带，互不牵连
```

实现时把上述三分支写成清晰的逐字段组装（`...（images !== null ? { images } : {}）`、`...（sessions !== null ? { sessions } : {}）`），并更新文件头注释（形状合法条件加 sessions 可选说明）。**注意**：既有用例「skills/files 非法 → null」语义不变——顶层 skills/files 仍必为数组。

- [ ] **Step 4: 跑测试确认通过（全文件）**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/message-context.test.ts`
Expected: PASS（含既有 images / 旧行为全部用例）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/message-context.ts renderer/src/lib/message-context.test.ts
git commit -m "feat: parseMessageContext sessions 形状校验（畸形不牵连整体）"
```

---

### Task 7: `ExpandedSessionItem` + expander session 展开

**Files:**
- Modify: `electron/src/main/agent/runtime-config.ts`（`ExpandedImageItem` 后插入新接口；`ExpandedContext` 加字段）
- Modify: `electron/src/main/im/context-expander.ts`
- Test: `electron/tests/im/context-expander.test.ts`（追加 describe）

**Interfaces:**
- Produces: `interface ExpandedSessionItem { sessionId: string; title: string; kind: 'chat' | 'task_execution'; memberNames: string[]; messageCount: number; lastMessageAt: number | null; missing: boolean }`；`ExpandedContext.sessions?: ExpandedSessionItem[]`；`ExpanderDeps.sessionMeta?: (sessionId: string) => SessionMetaInput | null`。
- Consumes: Task 4 的 `MessageContext.sessions`；sessions repo `getSession` / `listSessionMembers`、crud `listMembers`、Task 1 `countMessagesBySession`（生产路径构建 meta 用）。
- Task 8 消费：`renderUserContext(context)` 读 `context.sessions ?? []`。

- [ ] **Step 1: 写失败测试**（追加到 `context-expander.test.ts`；该文件 `beforeAll` 已 `setExpanderDeps`——新 describe 用独立 `beforeEach` 覆写注入再还原）

```typescript
describe('expandMessageContext sessions（跨会话引用）', () => {
  const baseCtx: MessageContext = { skills: [], files: [] };
  const metaOk = {
    workspaceId: 'ws1', title: '设计讨论', kind: 'chat' as const,
    lastMessageAt: 1_700_000_000_000, memberNames: ['用户', 'Coder'], messageCount: 12,
  };

  // 还原文件级 beforeAll 注入的 deps（不能置空——同文件其它 describe 依赖它）
  afterEach(() =>
    setExpanderDeps({
      skillRoots: [path.join(tmpRoot, 'skills')],
      workspaceDir: () => path.join(tmpRoot, 'ws1'),
    }),
  );

  it('存在且同 workspace → 完整 ExpandedSessionItem', async () => {
    setExpanderDeps({ sessionMeta: (id) => (id === 's1' ? { ...metaOk } : null) });
    const out = await expandMessageContext('ws1', {
      ...baseCtx,
      sessions: [{ sessionId: 's1', title: '快照标题' }],
    });
    expect(out.sessions).toEqual([
      { sessionId: 's1', title: '快照标题', kind: 'chat', memberNames: ['用户', 'Coder'], messageCount: 12, lastMessageAt: 1_700_000_000_000, missing: false },
    ]);
  });

  it('不存在 / 跨 workspace → missing 降级（title 保留快照）', async () => {
    setExpanderDeps({
      sessionMeta: (id) => (id === 'gone' ? null : { ...metaOk, workspaceId: '别的' }),
    });
    const out = await expandMessageContext('ws1', {
      ...baseCtx,
      sessions: [
        { sessionId: 'gone', title: '已删会话' },
        { sessionId: 's2', title: '外来会话' },
      ],
    });
    expect(out.sessions?.every((s) => s.missing === true)).toBe(true);
    expect(out.sessions?.[0]?.title).toBe('已删会话');
  });

  it('sessionMeta 抛错 → missing 降级，永不抛错（expander 契约）', async () => {
    setExpanderDeps({
      sessionMeta: () => {
        throw new Error('DB 炸了');
      },
    });
    const out = await expandMessageContext('ws1', {
      ...baseCtx,
      sessions: [{ sessionId: 's3', title: '任意' }],
    });
    expect(out.sessions?.[0]?.missing).toBe(true);
  });

  it('sessions 缺省 / 元素畸形 → 空数组，不影响其余展开', async () => {
    const out = await expandMessageContext('ws1', baseCtx);
    expect(out.sessions).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/context-expander.test.ts`
Expected: FAIL（`out.sessions` undefined）

- [ ] **Step 3: 实现**

`runtime-config.ts`（`ExpandedImageItem` 之后）：

```typescript
/** 主进程展开后的会话引用项——指针级（spec 2026-09-30 §6）；missing=true 为已删 / 跨 workspace 降级 */
export interface ExpandedSessionItem {
  sessionId: string;
  /** @ 选择时快照标题（missing 时保留原值供回溯） */
  title: string;
  kind: 'chat' | 'task_execution';
  memberNames: string[];
  messageCount: number;
  lastMessageAt: number | null;
  missing: boolean;
}
```

`ExpandedContext` 追加（`droppedImages` 之后）：

```typescript
  /** 会话引用展开项（跨会话引用；旧载荷 / 无引用 → 缺省视为 []，消费方 `?? []`） */
  sessions?: ExpandedSessionItem[];
```

`context-expander.ts`：

1. import 区补 sessions repo / crud / messages repo 与 `ExpandedSessionItem` 类型：

```typescript
import { getSession, listSessionMembers } from '../storage/sessions/repo';
import { countMessagesBySession } from '../storage/messages/repo';
import { listMembers } from '../agent/crud';
import type { ExpandedSessionItem } from '../agent/runtime-config';
```

（`ExpandedContext` 类型 import 列表一并补 `ExpandedSessionItem`。）

2. `ExpanderDeps` 追加：

```typescript
/** 会话元信息生产（测试注入即绕开 DB；生产由本模块从 repos 构建） */
export interface SessionMetaInput {
  workspaceId: string;
  title: string;
  kind: 'chat' | 'task_execution';
  lastMessageAt: number | null;
  memberNames: string[];
  messageCount: number;
}
```

（`SessionMetaInput` 定义在 `ExpanderDeps` 旁）`ExpanderDeps` 加字段 `sessionMeta?: (sessionId: string) => SessionMetaInput | null;`

3. 生产 meta 构建函数（放 `workspaceDirOf` 附近）：

```typescript
/** 生产路径：从 repos 构建会话元信息；DB 不可用 / 查无 → null（调用方降级 missing） */
function buildSessionMeta(sessionId: string): SessionMetaInput | null {
  try {
    const s = getSession(sessionId);
    if (s === null) return null;
    const instIds = new Set(listSessionMembers(sessionId).map((m) => m.instanceId));
    const names = listMembers(s.workspaceId)
      .filter((m) => instIds.has(m.instanceId))
      .map((m) => m.name);
    return {
      workspaceId: s.workspaceId,
      title: s.title,
      kind: s.kind,
      lastMessageAt: s.lastMessageAt,
      memberNames: names,
      messageCount: countMessagesBySession(sessionId),
    };
  } catch {
    return null;
  }
}
```

4. `expandMessageContext` 在 images 段之后追加 sessions 段并改返回值：

```typescript
  // 4. sessions（跨会话引用 spec 2026-09-30 §6）：指针级展开——存在性 + workspace
  //    归属校验 → 元信息；失败降级 missing（永不抛错契约，元素级防御同 skills I5）
  const sessions: ExpandedSessionItem[] = [];
  if (Array.isArray(context.sessions)) {
    for (const s of context.sessions) {
      if (typeof s?.sessionId !== 'string' || s.sessionId === '' || typeof s?.title !== 'string') continue;
      const meta = (() => {
        try {
          return deps.sessionMeta ? deps.sessionMeta(s.sessionId) : buildSessionMeta(s.sessionId);
        } catch (err) {
          logger.warn('context-expander：会话元信息查找失败，降级 missing', {
            sessionId: s.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })();
      sessions.push(
        meta !== null && meta.workspaceId === workspaceId
          ? {
              sessionId: s.sessionId,
              title: s.title,
              kind: meta.kind,
              memberNames: meta.memberNames,
              messageCount: meta.messageCount,
              lastMessageAt: meta.lastMessageAt,
              missing: false,
            }
          : { sessionId: s.sessionId, title: s.title, kind: 'chat', memberNames: [], messageCount: 0, lastMessageAt: null, missing: true },
      );
    }
  }

  return { skills, files, images, droppedImages, sessions };
```

注意：`workspaceId` 参数为 `string | null`——`meta.workspaceId === workspaceId` 在 null 时恒 false → 全部 missing（无 workspace 上下文时不注入会话指针，符合范围门语义）。更新文件头注释（第 3 段 images 之后补 sessions 一句）。

- [ ] **Step 4: 跑测试确认通过（全文件 + typecheck）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/context-expander.test.ts`
Run: `npx pnpm@9.0.0 typecheck`
Expected: 测试全 PASS（含既有 skills/files/images 全部）；typecheck 0 error（若 steer / resume 构造点因 ExpandedContext 新可选字段报错——可选字段不应产生错误，出现即检查是否误改必填）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/runtime-config.ts electron/src/main/im/context-expander.ts electron/tests/im/context-expander.test.ts
git commit -m "feat: ExpandedSessionItem + expander session 指针展开（missing 降级，永不抛错）"
```

---

### Task 8: `renderUserContext` session 指针块

**Files:**
- Modify: `electron/src/main/agent/turn-context.ts`
- Test: `electron/tests/agent/turn-context.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 7 的 `ExpandedContext.sessions?: ExpandedSessionItem[]`。
- Produces: `<user-context>` 内 `<session id="..." title="...">` 块；`renderTurnBody` 无需改动（块自动随 parts 拼接）。

- [ ] **Step 1: 写失败测试**

```typescript
describe('renderUserContext sessions 块（跨会话引用）', () => {
  const sess = (over: Partial<ExpandedSessionItem> = {}): ExpandedSessionItem => ({
    sessionId: 's1',
    title: '设计讨论',
    kind: 'chat',
    memberNames: ['用户', 'Coder'],
    messageCount: 12,
    lastMessageAt: 1_700_000_000_000,
    missing: false,
    ...over,
  });

  it('正常态：元信息 + read_session 提示（含 sessionId）', () => {
    const out = renderUserContext({ skills: [], files: [], sessions: [sess()] });
    expect(out).toContain('<session id="s1" title="设计讨论">');
    expect(out).toContain('成员=用户/Coder');
    expect(out).toContain('消息数=12');
    expect(out).toContain('read_session');
    expect(out).toContain('sessionId="s1"');
  });

  it('missing 态：降级文案，不出现 read_session 提示', () => {
    const out = renderUserContext({ skills: [], files: [], sessions: [sess({ missing: true })] });
    expect(out).toContain('该会话已删除或不可访问');
    expect(out).not.toContain('read_session');
  });

  it('sessions 缺省（旧载荷）→ 无 session 块，skills/files 照常', () => {
    const out = renderUserContext({ skills: [], files: [{ path: 'a.ts', content: 'x' }] });
    expect(out).not.toContain('<session');
    expect(out).toContain('<file path="a.ts">');
  });
});
```

（测试文件顶部 import 补 `ExpandedSessionItem` 类型。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/turn-context.test.ts`
Expected: FAIL（session 块不存在）

- [ ] **Step 3: 实现**（`renderUserContext` 的 files 循环之后追加）

```typescript
  for (const s of context.sessions ?? []) {
    if (s.missing) {
      parts.push(
        `<session id="${escapeAttr(s.sessionId)}" title="${escapeAttr(s.title)}">\n该会话已删除或不可访问。\n</session>`,
      );
      continue;
    }
    const active = s.lastMessageAt === null ? '未知' : new Date(s.lastMessageAt).toISOString().slice(5, 16).replace('T', ' ');
    parts.push(
      `<session id="${escapeAttr(s.sessionId)}" title="${escapeAttr(s.title)}">\n` +
        `类型=${s.kind} 成员=${s.memberNames.join('/')} 消息数=${s.messageCount} 最近活跃=${active}\n` +
        `用户引用此会话作为参考。完整内容请调用 read_session 工具读取（sessionId="${escapeAttr(s.sessionId)}"）。\n` +
        `</session>`,
    );
  }
```

（`parts.length === 0` 的空判据不变——session 块参与非空判定，无需改动。文件头注释补 session 块一句。）

- [ ] **Step 4: 跑测试确认通过（全文件）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/turn-context.test.ts`
Expected: PASS（含既有 skill/file 块全部用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/turn-context.ts electron/tests/agent/turn-context.test.ts
git commit -m "feat: renderUserContext session 指针块（元信息 + read_session 使用提示）"
```

---

### Task 9: MentionInput `@` 菜单「会话」组

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx`
- Test: `renderer/src/components/im/MentionInput.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 4 的 `PillSeg kind:'session'`；`useSessionStore` 的 `sessions: SessionSummary[]`（已加载）与 `activeSessionId`。
- Produces: `@` 菜单第三组「引用会话」；选中插 `selectWithPill({ kind:'session', id, label })`。

- [ ] **Step 1: 写失败测试**（追加到 `MentionInput.test.tsx`；先在 `vi.hoisted` 的 `sessionState` 补字段 `sessions: [] as SessionSummary[]`，并 import `SessionSummary` 类型；测试内通过 `sessionState.sessions = [...]` 注入）

```typescript
describe('@ 菜单会话组（跨会话引用）', () => {
  beforeEach(() => {
    sessionState.sessions = [
      { id: 'sess-1', title: '设计讨论', kind: 'chat', members: [], lastMessageAt: 1, titleAuto: false, createdAt: 1 } as unknown as SessionSummary,
      { id: 'sess-2', title: '当前会话标题', kind: 'chat', members: [], lastMessageAt: 2, titleAuto: false, createdAt: 2 } as unknown as SessionSummary,
    ];
    sessionState.activeSessionId = 'sess-2';
  });

  it('打 @ 出现「引用会话」组；当前会话不在列表；按关键词过滤', async () => {
    renderMentionInput(); // 复用文件内既有渲染 helper（若无则按既有用例同款 render + workspace mock）
    await typeInEditor('@'); // 复用既有输入模拟 helper
    expect(await screen.findByText('引用会话', { selector: '.text-tertiary' })).toBeInTheDocument();
    expect(screen.getByText('设计讨论')).toBeInTheDocument();
    expect(screen.queryByText('当前会话标题')).not.toBeInTheDocument(); // 排除当前会话

    await typeInEditor('@设计');
    expect(screen.getByText('设计讨论')).toBeInTheDocument();
  });

  it('选中会话 → session pill + 发送载荷 context.sessions', async () => {
    renderMentionInput();
    await typeInEditor('参考');
    await typeInEditor('@设计');
    fireEvent.click(screen.getByText('设计讨论'));
    fireEvent.keyDown(editorRoot(), { key: 'Enter' });
    await waitFor(() => {
      expect(sessionState.sendMessage).toHaveBeenCalledWith(
        '参考 @设计讨论 ',
        undefined,
        expect.objectContaining({
          sessions: [{ sessionId: 'sess-1', title: '设计讨论' }],
        }),
      );
    });
  });
});
```

（`renderMentionInput` / `typeInEditor` / `editorRoot` 沿用该测试文件既有的 helper 名——实现时以文件内实际 helper 为准对齐调用形态；mock store 是同一 `sessionState` 引用，`sessions` 字段加入后 selector 自动可见。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`
Expected: FAIL（无「引用会话」组文本）

- [ ] **Step 3: 实现**（`MentionInput.tsx` 五处小改）

1. 类型与常量：

```typescript
type MenuGroup = 'agent' | 'file' | 'task' | 'command' | 'skill' | 'session';
// GROUP_LABEL 追加：
  session: '引用会话',
// GroupIcon switch 追加 case（import 区补 MessagesSquare）：
    case 'session':
      return <MessagesSquare size={12} strokeWidth={1.75} aria-hidden />;
// 常量区追加：
/** @ 菜单会话组最多展示条目数（会话列表通常较长，与文件组限额同量级） */
const SESSION_MENU_LIMIT = 8;
```

（lucide-react import 追加 `MessagesSquare`。）

2. store 选择器（`activeSessionId` 行旁）：

```typescript
  const sessions = useSessionStore((s) => s.sessions);
```

3. 过滤（`filteredSkills` 之后，同款形态）：

```typescript
  // @ 菜单会话组（跨会话引用 spec 2026-09-30 §5）：排除当前会话（读自己无意义），
  // 标题子串过滤；数据源为已加载会话列表，零新 IPC
  const filteredSessions =
    menuType === 'agent'
      ? sessions
          .filter((s) => s.id !== activeSessionId)
          .filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()))
          .slice(0, SESSION_MENU_LIMIT)
      : [];
```

4. 菜单条目（`menuType === 'agent'` 分支内 fileHits 循环之后追加）：

```typescript
    for (const s of filteredSessions) {
      menuEntries.push({
        key: `session:${s.id}`,
        group: 'session',
        primary: s.title,
        select: () => selectWithPill({ kind: 'session', id: s.id, label: s.title }),
      });
    }
```

5. `SessionSummary` 类型 import（ipc/types）。

- [ ] **Step 4: 跑测试确认通过（全文件）**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`
Expected: PASS（含既有 @ 双源 / # / / 菜单与发送载荷全部用例——session 组追加在 file 组之后，不改变既有组顺序与键盘导航语义）

- [ ] **Step 5: typecheck + Commit**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: @ 菜单「引用会话」组（排除当前会话 + 标题过滤 + session pill）"
```

---

### Task 10: pill 视觉定稿（预览门禁）+ MessageBubble session chip

**Files:**
- Modify: `renderer/src/components/im/RichComposer.tsx`（`PILL_CLASS.session` 定稿——Task 4 已落临时值）
- Modify: `renderer/src/components/im/MessageBubble.tsx`
- Test: `renderer/src/components/im/MessageBubble.test.tsx`（若不存在则新建 colocated；沿用 `MessageList.test.tsx` 的 store mock 模式）

**Interfaces:**
- Consumes: Task 6 的 `parseMessageContext().sessions`、Task 4 的 `SessionContextItem`。

- [ ] **Step 1: 静态预览门禁（momo-ui-preview-rules，P1 变更）**

session pill 属新组件视觉形态：在 dev 环境截图确认后再定稿 `PILL_CLASS.session` 与 chip 图标。操作：`npx pnpm@9.0.0 dev` 启动，任一会话输入框打 `@` 选中一个会话，截屏（macOS 主机直接截图；容器内 `xvfb-run` + scrot 或 Playwright 截图）核对：① pill 底色与 file/skill 可区分；② `@标题` 前缀清晰；③ 消息气泡 chip 行图标为 MessagesSquare 16px。默认提案 `session: 'bg-surface-active text-secondary'`（与 file 同底色、靠 `@` 前缀区分）——如预览区分度不足，改用 `bg-status-violet-tint text-status-violet` 并同步 `PILL_CLASS` 注释。**预览确认是本步骤的完成条件**（规则：P1 须预览确认后实现；本任务其余步骤在确认后进行）。

- [ ] **Step 2: 写失败测试**（MessageBubble chip 断言）

```typescript
describe('session context chip（跨会话引用）', () => {
  it('owner 消息带 sessions → 渲染「引用会话」chip（标题）', () => {
    const msg = makeMessage({
      sender: 'owner',
      contextJson: JSON.stringify({ skills: [], files: [], sessions: [{ sessionId: 's1', title: '设计讨论' }] }),
    });
    renderMessageBubble(msg);
    expect(screen.getByTestId('message-context-chips')).toHaveTextContent('设计讨论');
  });

  it('sessions 畸形（parse 剔除）→ 无 chip 行，正文照常', () => {
    const msg = makeMessage({
      sender: 'owner',
      contextJson: JSON.stringify({ skills: [], files: [], sessions: [{ sessionId: 1 }] }),
    });
    renderMessageBubble(msg);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
  });
});
```

（`MessageBubble.test.tsx` 已存在——`makeMessage` / `renderMessageBubble` 按该文件既有的消息构造与渲染 helper 形态落地，沿用其 stream store mock。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MessageBubble.test.tsx`
Expected: FAIL（chip 区不渲染 sessions）

- [ ] **Step 4: 实现**（`MessageBubble.tsx`）

1. import 补 `SessionContextItem` 类型与 `MessagesSquare`（lucide-react）。
2. 渲染守卫（`isRenderableImage` 旁）：

```typescript
function isRenderableSession(s: SessionContextItem): boolean {
  return typeof s.sessionId === 'string' && s.sessionId !== '' && typeof s.title === 'string';
}
```

3. 解析行（`ctxImages` 之后）：

```typescript
  const ctxSessions = ctx?.sessions?.filter(isRenderableSession) ?? [];
```

`hasContextChips` 改为 `ctxSkills.length > 0 || ctxFiles.length > 0 || ctxSessions.length > 0;`
4. chip 行内（files 按钮之后追加；会话 chip 是纯展示，不可点）：

```tsx
          {ctxSessions.map((s) => (
            <span
              key={`session-${s.sessionId}`}
              className="inline-flex items-center gap-1 rounded bg-surface-active px-2 py-0.5 text-xs text-secondary"
            >
              <MessagesSquare size={11} strokeWidth={1.75} aria-hidden />
              {s.title}
            </span>
          ))}
```

5. `RichComposer.tsx`：按 Step 1 预览结论定稿 `PILL_CLASS.session`（无改动则跳过）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MessageBubble.test.tsx`
Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RichComposer.test.tsx`
Expected: PASS

- [ ] **Step 6: 收尾全量验证**

Run: `npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 双 workspace 全绿（若有既有失败，确认非本分支引入——比对 main 基线）

- [ ] **Step 7: Commit**

```bash
git add renderer/src/components/im/RichComposer.tsx renderer/src/components/im/MessageBubble.tsx renderer/src/components/im/MessageBubble.test.tsx
git commit -m "feat: session pill 视觉定稿 + MessageBubble 会话引用 chip"
```

---

## 任务依赖图

```
Task 1 (repo 辅助) ─→ Task 2 (list_sessions) ─→ Task 3 (read_session)
Task 4 (契约+序列化) ─→ Task 5 (sanitize)   ┐
Task 4 ─→ Task 6 (parse)                     ├─→ Task 7 (expander) ─→ Task 8 (renderUserContext)
Task 4 ─→ Task 9 (MentionInput)              ┘
Task 4 ─→ Task 10 (pill 定稿 + chip)
```

可并行：Task 1–3（electron 工具线）与 Task 4–8（契约线）互不依赖；Task 9 / Task 10 依赖 Task 4。合并顺序建议：工具线与契约线各自序列推进，Task 10 收尾（含 UI 预览门禁）。
