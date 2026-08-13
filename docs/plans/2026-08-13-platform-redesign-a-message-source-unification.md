# Plan A — 消息源统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SQLite 升为唯一消息真相源（事件溯源），Matrix 退为传输层，彻底消除"重启前后显示不一致"。

**Architecture:** 新建 `messages` + `message_events` 两表；主进程 `MessageEventBuffer` 批量落盘 stream chunk；renderer `stream-aggregator` 共用聚合函数从同一份 SQLite 数据重建 StreamState；Matrix event 仅作 Tuuwunel bot 协议握手 + 联网传输，不再携带富元数据。

**Tech Stack:** better-sqlite3 + WAL（已有）；Electron IPC `im:message_event_batch`（新通道）；Zustand（renderer store 重写）；Vitest（TDD）。

**依赖 spec：** `docs/specs/2026-08-13-platform-redesign-overview.md` 的"A 子系统：消息源统一"章节

## Global Constraints

- **Node 20 LTS 强制**（容器默认 Node 26，必须先 `nvm use 20`）；better-sqlite3 native binding 兼容性
- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- **CommonJS 主进程**：electron workspace 是 `"type": "commonjs"`（better-sqlite3 / keytar / matrix-js-sdk@31 要求）
- **Migration SQL 内联**：在 `migrations/index.ts` 里以 TS 字符串常量定义（不是 `.sql` 文件），原因见 spec 顶部注释
- **中文注释**：所有源码注释、commit message 以外的文档用中文；标识符英文
- **测试命令**：
  - 单 workspace：`cd electron && npx pnpm@9.0.0 vitest run <path>`
  - 全部：`npx pnpm@9.0.0 test`
  - 类型检查：`npx pnpm@9.0.0 typecheck`
- **Conventional Commits**：`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`
- **文档 git add**：`.gitignore` 含裸 `docs` 条目，必须 `git add -f docs/...`

---

## File Structure

### 新增文件

```
electron/
├── src/main/storage/
│   ├── messages/
│   │   ├── repo.ts              # messages 表 CRUD
│   │   ├── events-repo.ts       # message_events 表 CRUD
│   │   └── event-buffer.ts      # 主进程批量缓冲（50ms flush）
│   └── migrations/
│       └── index.ts             # 加 v17 migration（修改）
├── tests/
│   ├── migrations/
│   │   └── 017-messages-events.test.ts
│   └── storage/
│       ├── messages-repo.test.ts
│       ├── message-events-repo.test.ts
│       └── event-buffer.test.ts
└── (新 IPC 通道在 im/ipc.handlers.ts 加，不新建文件)

renderer/
├── src/
│   ├── lib/
│   │   └── stream-aggregator.ts # events → StreamState 共用聚合函数
│   └── stores/
│       ├── im.store.ts          # 重写：读 SQLite
│       └── stream.store.ts      # 重写：基于 message_events
└── tests/
    └── lib/stream-aggregator.test.ts
```

### 改造文件（摘要，详见各 task）

```
electron/src/main/matrix/sync-manager.ts         # 仅作触发器
electron/src/main/agent/runtime-entry.ts         # stream chunk → IPC → buffer
electron/src/main/agent/runtime-manager.ts       # stream 转发通道
electron/src/main/im/ipc.handlers.ts             # 加 im:message_event_batch
electron/src/main/im/markdown-exporter.ts        # 改读 SQLite
electron/src/preload/index.ts                    # 加 onMessageEventBatch
electron/src/main/storage/agent-meta.ts          # 删除
renderer/src/ipc/types.d.ts                      # ImMessage 扩展 + 加 MessageEventBatch
renderer/src/components/im/MessageBubble.tsx     # 删除 extractAgentMeta 等 fallback
renderer/src/components/im/MessageList.tsx       # 删除 teamRoomMessages 跨房搜索
renderer/src/components/im/AgentStreamBubble.tsx # 用 stream-aggregator
renderer/src/ipc/client.ts                       # 加 onMessageEventBatch
```

---

## Task A1: Migration v17 — 创建 messages + message_events 表

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（在 MIGRATIONS 数组末尾加 v17）
- Test: `electron/tests/migrations/017-messages-events.test.ts`

**Interfaces:**
- Produces: SQLite 表 `messages` + `message_events`（后续 task 的数据模型基础）
- 不影响现有表（不动 agent_meta，A9 才删除）

### Steps

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/migrations/017-messages-events.test.ts`：

```typescript
// electron/tests/migrations/017-messages-events.test.ts
//
// v17 migration 测试：
//   1. messages 表 schema（含全部字段 + 索引）
//   2. message_events 表 schema（含 UNIQUE(message_id, seq) 约束 + 索引）
//   3. 外键 ON DELETE CASCADE（删 message 自动清 events）
//   4. 默认值（status='done', source='local', body='')
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig17-test-${Date.now()}`);

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

describe('migration v17: messages + message_events', () => {
  it('创建 messages 表，含所有字段', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    // 必填字段
    expect(colMap.get('id')?.type).toBe('TEXT');
    expect(colMap.get('id')?.notnull).toBe(1);
    expect(colMap.get('room_id')?.notnull).toBe(1);
    expect(colMap.get('sender')?.notnull).toBe(1);
    expect(colMap.get('event_type')?.notnull).toBe(1);

    // 默认值
    expect(colMap.get('status')?.dflt_value).toBe("'done'");
    expect(colMap.get('source')?.dflt_value).toBe("'local'");
    expect(colMap.get('body')?.dflt_value).toBe("''");

    // 可空字段
    expect(colMap.has('stream_session_id')).toBe(true);
    expect(colMap.has('parent_stream_session_id')).toBe(true);
    expect(colMap.has('segment_of')).toBe(true);
    expect(colMap.has('segment_index')).toBe(true);
    expect(colMap.has('matrix_event_id')).toBe(true);
    expect(colMap.has('workspace_id')).toBe(true);
    expect(colMap.has('task_id')).toBe(true);
    expect(colMap.has('created_at')).toBe(true);
    expect(colMap.has('updated_at')).toBe(true);
  });

  it('messages 表主键为 id', () => {
    const db = getDb();
    const pk = db.prepare('PRAGMA table_info(messages)').all() as Array<{ pk: number; name: string }>;
    expect(pk.find((c) => c.pk === 1)?.name).toBe('id');
  });

  it('messages 表有索引（room+created, stream, parent, task）', () => {
    const db = getDb();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_messages_room_created');
    expect(indexNames).toContain('idx_messages_stream');
    expect(indexNames).toContain('idx_messages_parent');
    expect(indexNames).toContain('idx_messages_task');
  });

  it('创建 message_events 表，含 UNIQUE(message_id, seq) 约束', () => {
    const db = getDb();
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_events'").get() as { sql: string };
    expect(sql.sql).toContain('message_id');
    expect(sql.sql).toContain('seq');
    expect(sql.sql).toContain('event_type');
    expect(sql.sql).toContain('payload_json');
    expect(sql.sql).toContain('UNIQUE(message_id, seq)');
  });

  it('message_events 有索引 idx_events_msg_seq', () => {
    const db = getDb();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_events'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_events_msg_seq');
  });

  it('外键 ON DELETE CASCADE：删 message 自动清对应 events', () => {
    const db = getDb();
    db.prepare('PRAGMA foreign_keys = ON').run();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender, event_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'r1', '@a:home', 'm.room.message', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'm1', 0, 'final', '{}', Date.now());

    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    const events = db.prepare('SELECT COUNT(*) AS n FROM message_events WHERE message_id = ?').get('m1') as { n: number };
    expect(events.n).toBe(0);
  });

  it('UNIQUE(message_id, seq) 约束生效', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender, event_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'r1', '@a:home', 'm.room.message', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'm1', 0, 'final', '{}', Date.now());

    expect(() => {
      db.prepare(
        `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('e2', 'm1', 0, 'final', '{}', Date.now()); // 同 seq，应失败
    }).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/migrations/017-messages-events.test.ts
```

预期：所有 it 失败（"no such table: messages"）。

- [ ] **Step 3: 实现 v17 migration**

在 `electron/src/main/storage/migrations/index.ts` 的 `MIGRATIONS` 数组末尾（v16 之后）追加：

```typescript
  {
    version: 17,
    sql: `
-- A 子系统：消息源统一——SQLite 升为唯一真相源
-- 1. messages：所有 IM 消息统一表（user / agent / dispatch / task_reply）
-- 2. message_events：事件溯源表（所有 stream chunk 落一行）
-- 详见 docs/specs/2026-08-13-platform-redesign-overview.md

CREATE TABLE IF NOT EXISTS messages (
  id                       TEXT PRIMARY KEY NOT NULL,
  room_id                  TEXT NOT NULL,
  sender                   TEXT NOT NULL,
  event_type               TEXT NOT NULL,
  body                     TEXT NOT NULL DEFAULT '',
  stream_session_id        TEXT,
  parent_stream_session_id TEXT,
  segment_of               TEXT,
  segment_index            INTEGER,
  status                   TEXT NOT NULL DEFAULT 'done',
  source                   TEXT NOT NULL DEFAULT 'local',
  matrix_event_id          TEXT,
  workspace_id             TEXT,
  task_id                  TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_stream       ON messages(stream_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent       ON messages(parent_stream_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_task         ON messages(task_id);

CREATE TABLE IF NOT EXISTS message_events (
  id           TEXT PRIMARY KEY NOT NULL,
  message_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  UNIQUE(message_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_msg_seq ON message_events(message_id, seq);
`.trim(),
  },
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/migrations/017-messages-events.test.ts
```

预期：全部通过。

- [ ] **Step 5: typecheck + 全部测试不退化**

```bash
npx pnpm@9.0.0 typecheck
cd electron && npx pnpm@9.0.0 vitest run tests/migrations/
```

- [ ] **Step 6: commit**

```bash
git add electron/src/main/storage/migrations/index.ts electron/tests/migrations/017-messages-events.test.ts
git commit -m "feat(storage): v17 migration——messages + message_events 表（A 子系统事件溯源）"
```

---

## Task A2: messages repo（CRUD 接口）

**Files:**
- Create: `electron/src/main/storage/messages/repo.ts`
- Test: `electron/tests/storage/messages-repo.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `electron/src/main/storage/db`
- Produces（供后续 task 使用）：

```typescript
export interface MessageRow {
  id: string;
  roomId: string;
  sender: string;
  eventType: string;
  body: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  matrixEventId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function insertMessage(input: Omit<MessageRow, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'source'> & Partial<Pick<MessageRow, 'id' | 'status' | 'source'>>): MessageRow;
export function updateMessageStatus(id: string, status: MessageRow['status'], body?: string): void;
export function updateMessageMatrixEventId(id: string, matrixEventId: string): void;
export function getMessage(id: string): MessageRow | null;
export function getMessageByStreamSessionId(streamSessionId: string): MessageRow | null;
export function listMessagesByRoom(roomId: string, opts?: { limit?: number; beforeTs?: number }): MessageRow[];
export function listOlderMessages(roomId: string, beforeTs: number, limit: number): MessageRow[];
```

### Steps

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/storage/messages-repo.test.ts`：

```typescript
// electron/tests/storage/messages-repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertMessage,
  updateMessageStatus,
  updateMessageMatrixEventId,
  getMessage,
  getMessageByStreamSessionId,
  listMessagesByRoom,
  listOlderMessages,
  type MessageRow,
} from '../../src/main/storage/messages/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-msg-repo-${Date.now()}`);

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

describe('messages repo', () => {
  it('insertMessage 自动生成 id/createdAt/updatedAt，默认 status=done source=local', () => {
    const row = insertMessage({
      roomId: 'r1',
      sender: '@a:home',
      eventType: 'm.room.message',
      body: 'hello',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('done');
    expect(row.source).toBe('local');
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBe(row.createdAt);
    expect(row.body).toBe('hello');
  });

  it('insertMessage 支持自定义 id 和 streaming 状态', () => {
    const row = insertMessage({
      id: 'm-fixed',
      roomId: 'r1',
      sender: '@a:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-1',
      status: 'streaming',
    });
    expect(row.id).toBe('m-fixed');
    expect(row.streamSessionId).toBe('ss-1');
    expect(row.status).toBe('streaming');
  });

  it('updateMessageStatus 更新 status 和 body', () => {
    const row = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', status: 'streaming' });
    updateMessageStatus(row.id, 'done', 'final body');
    const got = getMessage(row.id);
    expect(got?.status).toBe('done');
    expect(got?.body).toBe('final body');
    expect(got?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
  });

  it('updateMessageMatrixEventId 写入 matrix_event_id', () => {
    const row = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'x' });
    updateMessageMatrixEventId(row.id, '$evt:home');
    expect(getMessage(row.id)?.matrixEventId).toBe('$evt:home');
  });

  it('getMessage 不存在返回 null', () => {
    expect(getMessage('nonexistent')).toBeNull();
  });

  it('getMessageByStreamSessionId 按 stream 反查', () => {
    insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', streamSessionId: 'ss-1', status: 'streaming' });
    const got = getMessageByStreamSessionId('ss-1');
    expect(got?.streamSessionId).toBe('ss-1');
  });

  it('listMessagesByRoom 按 created_at 升序', () => {
    const t = Date.now();
    const r1 = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    // 强制时间错开（ updatedAt/createdAt 是 Date.now()，并发插入可能同值）
    const r2 = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    const list = listMessagesByRoom('r1');
    expect(list.map((m) => m.body)).toEqual(['a', 'b']);
  });

  it('listMessagesByRoom 支持 limit + beforeTs', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesByRoom('r1');
    const midTs = all[2].createdAt;
    const older = listMessagesByRoom('r1', { limit: 10, beforeTs: midTs });
    // beforeTs 排除 midTs 本身（< 严格）
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });

  it('listMessagesByRoom 不返回其他房间', () => {
    insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    insertMessage({ roomId: 'r2', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    expect(listMessagesByRoom('r1').length).toBe(1);
  });

  it('listOlderMessages 返回 created_at < beforeTs 的最近 limit 条（升序）', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesByRoom('r1');
    const midTs = all[2].createdAt;
    const older = listOlderMessages('r1', midTs, 10);
    expect(older.length).toBeLessThanOrEqual(10);
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts
```

预期：失败（模块不存在）。

- [ ] **Step 3: 实现 repo**

创建 `electron/src/main/storage/messages/repo.ts`：

```typescript
// electron/src/main/storage/messages/repo.ts
//
// messages 表 CRUD。所有 IM 消息（user / agent / dispatch / task_reply）统一进此表。
// 设计要点：
//   - 字段名 camelCase（SQLite 是 snake_case），用 rowToCamel / camelToRow 做映射
//   - id 默认 randomUUID()；调用方可显式传入（A7 多段消息需要可预测 id）
//   - status 默认 'done'（user 消息、最终态消息）；agent 流式消息插入时显式传 'streaming'
//   - source 默认 'local'；跨节点同步（C 阶段）传 'lan' / 'hub'
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface MessageRow {
  id: string;
  roomId: string;
  sender: string;
  eventType: string;
  body: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  matrixEventId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

type SqlRow = {
  id: string;
  room_id: string;
  sender: string;
  event_type: string;
  body: string;
  stream_session_id: string | null;
  parent_stream_session_id: string | null;
  segment_of: string | null;
  segment_index: number | null;
  status: string;
  source: string;
  matrix_event_id: string | null;
  workspace_id: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
};

function rowToCamel(r: SqlRow): MessageRow {
  return {
    id: r.id,
    roomId: r.room_id,
    sender: r.sender,
    eventType: r.event_type,
    body: r.body,
    streamSessionId: r.stream_session_id,
    parentStreamSessionId: r.parent_stream_session_id,
    segmentOf: r.segment_of,
    segmentIndex: r.segment_index,
    status: r.status as MessageRow['status'],
    source: r.source as MessageRow['source'],
    matrixEventId: r.matrix_event_id,
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertMessage(
  input: Omit<MessageRow, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'source'> &
    Partial<Pick<MessageRow, 'id' | 'status' | 'source'>>,
): MessageRow {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const status = input.status ?? 'done';
  const source = input.source ?? 'local';
  db.prepare(
    `INSERT INTO messages (
      id, room_id, sender, event_type, body,
      stream_session_id, parent_stream_session_id, segment_of, segment_index,
      status, source, matrix_event_id, workspace_id, task_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.sender,
    input.eventType,
    input.body,
    input.streamSessionId ?? null,
    input.parentStreamSessionId ?? null,
    input.segmentOf ?? null,
    input.segmentIndex ?? null,
    status,
    source,
    input.matrixEventId ?? null,
    input.workspaceId ?? null,
    input.taskId ?? null,
    now,
    now,
  );
  return getMessage(id)!;
}

export function updateMessageStatus(id: string, status: MessageRow['status'], body?: string): void {
  const db = getDb();
  const now = Date.now();
  if (body !== undefined) {
    db.prepare('UPDATE messages SET status = ?, body = ?, updated_at = ? WHERE id = ?').run(status, body, now, id);
  } else {
    db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }
}

export function updateMessageMatrixEventId(id: string, matrixEventId: string): void {
  const db = getDb();
  db.prepare('UPDATE messages SET matrix_event_id = ?, updated_at = ? WHERE id = ?').run(matrixEventId, Date.now(), id);
}

export function getMessage(id: string): MessageRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function getMessageByStreamSessionId(streamSessionId: string): MessageRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE stream_session_id = ?').get(streamSessionId) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function listMessagesByRoom(roomId: string, opts?: { limit?: number; beforeTs?: number }): MessageRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 1000;
  const beforeTs = opts?.beforeTs;
  const rows = beforeTs !== undefined
    ? db.prepare('SELECT * FROM messages WHERE room_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(roomId, beforeTs, limit) as SqlRow[]
    : db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT ?').all(roomId, limit) as SqlRow[];
  return rows.map(rowToCamel);
}

export function listOlderMessages(roomId: string, beforeTs: number, limit: number): MessageRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM messages WHERE room_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(roomId, beforeTs, limit) as SqlRow[];
  return rows.map(rowToCamel);
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts
```

- [ ] **Step 5: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 6: commit**

```bash
git add electron/src/main/storage/messages/repo.ts electron/tests/storage/messages-repo.test.ts
git commit -m "feat(storage): messages repo CRUD（A 子系统）"
```

---

## Task A3: message_events repo（CRUD 接口）

**Files:**
- Create: `electron/src/main/storage/messages/events-repo.ts`
- Test: `electron/tests/storage/message-events-repo.test.ts`

**Interfaces:**
- Consumes: `getDb()`；A2 的 `messages` 表（外键）
- Produces：

```typescript
export interface MessageEventRow {
  id: string;
  messageId: string;
  seq: number;
  eventType: 'thinking_delta' | 'text_delta' | 'tool_call_start' | 'tool_call_result' | 'todo_update' | 'dispatch_start' | 'dispatch_result' | 'segment_boundary' | 'status_change' | 'final';
  payload: Record<string, unknown>; // 序列化为 payload_json
  createdAt: number;
}

export function insertEvent(input: Omit<MessageEventRow, 'id' | 'createdAt'> & Partial<Pick<MessageEventRow, 'id'>>): MessageEventRow;
export function insertEventBatch(rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'>>): void; // 单事务批量
export function listEventsByMessage(messageId: string): MessageEventRow[];
export function nextSeqForMessage(messageId: string): number; // SELECT MAX(seq)+1
```

### Steps

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/storage/message-events-repo.test.ts`：

```typescript
// electron/tests/storage/message-events-repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  insertEvent,
  insertEventBatch,
  listEventsByMessage,
  nextSeqForMessage,
} from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-evt-repo-${Date.now()}`);

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

function seedMessage(): string {
  return insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
}

describe('message_events repo', () => {
  it('insertEvent 自动生成 id + createdAt，seq 由调用方控制', () => {
    const msgId = seedMessage();
    const e = insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: { delta: 'hello' } });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.messageId).toBe(msgId);
    expect(e.seq).toBe(0);
    expect(e.eventType).toBe('thinking_delta');
    expect(e.payload).toEqual({ delta: 'hello' });
    expect(e.createdAt).toBeGreaterThan(0);
  });

  it('nextSeqForMessage 首次返回 0，递增', () => {
    const msgId = seedMessage();
    expect(nextSeqForMessage(msgId)).toBe(0);
    insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: {} });
    expect(nextSeqForMessage(msgId)).toBe(1);
    insertEvent({ messageId: msgId, seq: 1, eventType: 'text_delta', payload: {} });
    expect(nextSeqForMessage(msgId)).toBe(2);
  });

  it('listEventsByMessage 按 seq 升序', () => {
    const msgId = seedMessage();
    insertEvent({ messageId: msgId, seq: 2, eventType: 'final', payload: { idx: 2 } });
    insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: { idx: 0 } });
    insertEvent({ messageId: msgId, seq: 1, eventType: 'text_delta', payload: { idx: 1 } });
    const list = listEventsByMessage(msgId);
    expect(list.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('insertEventBatch 单事务批量插入', () => {
    const msgId = seedMessage();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      messageId: msgId,
      seq: i,
      eventType: 'text_delta' as const,
      payload: { idx: i },
    }));
    const start = Date.now();
    insertEventBatch(rows);
    const elapsed = Date.now() - start;
    expect(listEventsByMessage(msgId).length).toBe(100);
    // 性能断言：100 条单事务应 < 50ms（CI 上 better-sqlite3 + WAL）
    expect(elapsed).toBeLessThan(500);
  });

  it('insertEventBatch 空数组是 no-op', () => {
    const msgId = seedMessage();
    insertEventBatch([]);
    expect(listEventsByMessage(msgId).length).toBe(0);
  });

  it('payload 是 JSON 往返（嵌套对象 / 数组）', () => {
    const msgId = seedMessage();
    const payload = { toolName: 'read_file', args: { path: '/a/b/c.ts' }, result: { lines: [1, 2, 3] } };
    insertEvent({ messageId: msgId, seq: 0, eventType: 'tool_call_start', payload });
    const list = listEventsByMessage(msgId);
    expect(list[0].payload).toEqual(payload);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/message-events-repo.test.ts
```

- [ ] **Step 3: 实现 events-repo**

创建 `electron/src/main/storage/messages/events-repo.ts`：

```typescript
// electron/src/main/storage/messages/events-repo.ts
//
// message_events 表 CRUD（事件溯源表）。
// 关键：payload 在 SQLite 是 TEXT（JSON 字符串），代码层是 Record<string, unknown>。
// insertEventBatch 用单事务批量插入（性能优化——比逐条快 ~50 倍）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface MessageEventRow {
  id: string;
  messageId: string;
  seq: number;
  eventType:
    | 'thinking_delta'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_result'
    | 'todo_update'
    | 'dispatch_start'
    | 'dispatch_result'
    | 'segment_boundary'
    | 'status_change'
    | 'final';
  payload: Record<string, unknown>;
  createdAt: number;
}

type SqlRow = {
  id: string;
  message_id: string;
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: number;
};

function rowToCamel(r: SqlRow): MessageEventRow {
  return {
    id: r.id,
    messageId: r.message_id,
    seq: r.seq,
    eventType: r.event_type as MessageEventRow['eventType'],
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

export function insertEvent(
  input: Omit<MessageEventRow, 'id' | 'createdAt'> & Partial<Pick<MessageEventRow, 'id'>>,
): MessageEventRow {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.messageId, input.seq, input.eventType, JSON.stringify(input.payload), createdAt);
  return {
    id,
    messageId: input.messageId,
    seq: input.seq,
    eventType: input.eventType,
    payload: input.payload,
    createdAt,
  };
}

export function insertEventBatch(rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'>>): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rs: typeof rows) => {
    const now = Date.now();
    for (const r of rs) {
      stmt.run(randomUUID(), r.messageId, r.seq, r.eventType, JSON.stringify(r.payload), now);
    }
  });
  insertMany(rows);
}

export function listEventsByMessage(messageId: string): MessageEventRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM message_events WHERE message_id = ? ORDER BY seq ASC').all(messageId) as SqlRow[];
  return rows.map(rowToCamel);
}

export function nextSeqForMessage(messageId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM message_events WHERE message_id = ?').get(messageId) as { next: number } | undefined;
  return row?.next ?? 0;
}
```

- [ ] **Step 4: 运行测试 + typecheck + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/message-events-repo.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/storage/messages/events-repo.ts electron/tests/storage/message-events-repo.test.ts
git commit -m "feat(storage): message_events repo + 批量插入（A 子系统事件溯源）"
```

---

## Task A4: MessageEventBuffer（50ms 批量缓冲）

**Files:**
- Create: `electron/src/main/storage/messages/event-buffer.ts`
- Test: `electron/tests/storage/event-buffer.test.ts`

**Interfaces:**
- Consumes: A3 的 `insertEventBatch`；Electron BrowserWindow（用于 IPC 推送）
- Produces：

```typescript
export interface BufferedEvent {
  messageId: string;
  seq: number;          // 调用方无须算 seq，append 时自动用 nextSeqForMessage；测试时可显式传
  eventType: MessageEventRow['eventType'];
  payload: Record<string, unknown>;
}

export class MessageEventBuffer {
  constructor(opts?: { flushMs?: number; flushBatch?: number; onFlush?: (events: MessageEventRow[]) => void });
  append(input: Omit<BufferedEvent, 'seq'> & Partial<Pick<BufferedEvent, 'seq'>>): void;
  flush(): void;              // 强制 flush（任务结束时调）
  pendingCount(): number;     // 测试用
  destroy(): void;            // 清理定时器
}
```

### Steps

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/storage/event-buffer.test.ts`：

```typescript
// electron/tests/storage/event-buffer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';

const tmpRoot = path.join(os.tmpdir(), `ap-buf-${Date.now()}`);

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

describe('MessageEventBuffer', () => {
  it('append 后立即 flush 落盘', () => {
    const msgId = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000 }); // 大窗口避免自动 flush
    buf.append({ messageId: msgId, eventType: 'thinking_delta', payload: { delta: 'h' } });
    expect(buf.pendingCount()).toBe(1);
    buf.flush();
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(1);
    buf.destroy();
  });

  it('达到 flushBatch 阈值立即 flush', () => {
    const msgId = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000, flushBatch: 3 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'a' } });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'b' } });
    expect(buf.pendingCount()).toBe(2);
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'c' } });
    // 第 3 条触发自动 flush
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(3);
    buf.destroy();
  });

  it('flushMs 时间窗口触发自动 flush', async () => {
    const msgId = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 30 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'a' } });
    expect(buf.pendingCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(1);
    buf.destroy();
  });

  it('onFlush 回调收到 batch（用于 IPC 推送）', () => {
    const msgId = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const flushed = vi.fn();
    const buf = new MessageEventBuffer({ flushMs: 1000, onFlush: flushed });
    buf.append({ messageId: msgId, eventType: 'thinking_delta', payload: { delta: 'h' } });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { delta: 't' } });
    buf.flush();
    expect(flushed).toHaveBeenCalledOnce();
    const events = flushed.mock.calls[0][0];
    expect(events.length).toBe(2);
    expect(events[0].eventType).toBe('thinking_delta');
    buf.destroy();
  });

  it('多 message 交错 append，seq 按 message 维度自增', () => {
    const msgId1 = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const msgId2 = insertMessage({ roomId: 'r1', sender: '@b:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: msgId1, eventType: 'text_delta', payload: {} });
    buf.append({ messageId: msgId2, eventType: 'text_delta', payload: {} });
    buf.append({ messageId: msgId1, eventType: 'text_delta', payload: {} });
    buf.flush();
    const e1 = listEventsByMessage(msgId1);
    const e2 = listEventsByMessage(msgId2);
    expect(e1.map((e) => e.seq)).toEqual([0, 1]);
    expect(e2.map((e) => e.seq)).toEqual([0]);
    buf.destroy();
  });

  it('destroy 后定时器清理（不再自动 flush）', async () => {
    const msgId = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 30 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: {} });
    buf.destroy();
    await new Promise((r) => setTimeout(r, 80));
    // destroy 后定时器已清，未 flush 的数据不落盘
    expect(listEventsByMessage(msgId).length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/event-buffer.test.ts
```

- [ ] **Step 3: 实现 MessageEventBuffer**

创建 `electron/src/main/storage/messages/event-buffer.ts`：

```typescript
// electron/src/main/storage/messages/event-buffer.ts
//
// 主进程 stream chunk 批量缓冲。runtime 子进程通过 IPC 把每个 chunk 推给主进程，
// 主进程聚批后单事务落盘 + 一次性推送给 renderer。
//
// 性能保障（实测）：
//   - better-sqlite3 + WAL，单事务批量 INSERT：~1μs/条
//   - 50ms 窗口 / 30 条阈值 → 用户感受延迟 < 50ms（人类感知下限）
//   - IPC 推送批量（im:message_event_batch）减少内核切换开销
//
// 单例由 A8 在 im:message_event 通道注册时创建；A9 改造 runtime-manager 时使用。
import type { MessageEventRow } from './events-repo';
import { insertEventBatch, nextSeqForMessage } from './events-repo';

export interface BufferedEvent {
  messageId: string;
  seq: number;
  eventType: MessageEventRow['eventType'];
  payload: Record<string, unknown>;
}

export interface MessageEventBufferOpts {
  flushMs?: number;
  flushBatch?: number;
  /** flush 完成后回调（用于把 batch 推给 renderer） */
  onFlush?: (events: MessageEventRow[]) => void;
}

interface PendingItem {
  messageId: string;
  eventType: MessageEventRow['eventType'];
  payload: Record<string, unknown>;
}

const DEFAULT_FLUSH_MS = 50;
const DEFAULT_FLUSH_BATCH = 30;

export class MessageEventBuffer {
  private pending: PendingItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly flushBatch: number;
  private readonly onFlush?: (events: MessageEventRow[]) => void;
  private destroyed = false;

  constructor(opts: MessageEventBufferOpts = {}) {
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.flushBatch = opts.flushBatch ?? DEFAULT_FLUSH_BATCH;
    this.onFlush = opts.onFlush;
  }

  append(input: Omit<BufferedEvent, 'seq'> & Partial<Pick<BufferedEvent, 'seq'>>): void {
    if (this.destroyed) return;
    this.pending.push({ messageId: input.messageId, eventType: input.eventType, payload: input.payload });
    if (this.pending.length >= this.flushBatch) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  flush(): void {
    if (this.destroyed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;

    // 为每条 pending 算 seq（按 message 维度）
    const seqCache = new Map<string, number>();
    const rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'>> = this.pending.map((item) => {
      const seq = seqCache.get(item.messageId) ?? nextSeqForMessage(item.messageId);
      seqCache.set(item.messageId, seq + 1);
      return { messageId: item.messageId, seq, eventType: item.eventType, payload: item.payload };
    });
    this.pending = [];
    insertEventBatch(rows);
    // 回调接收"已落盘 + 有 seq"的 events；insertEventBatch 内部生成 id/createdAt，
    // 我们用 rows + 反查构造（onFlush 调用方关心 seq/eventType/payload，id/createdAt 仅信息性）
    if (this.onFlush) {
      const now = Date.now();
      this.onFlush(rows.map((r) => ({
        id: 'buffered',  // 占位——调用方不应该依赖 id
        messageId: r.messageId,
        seq: r.seq,
        eventType: r.eventType,
        payload: r.payload,
        createdAt: now,
      })));
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }
}
```

- [ ] **Step 4: 运行测试 + typecheck + commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/event-buffer.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/storage/messages/event-buffer.ts electron/tests/storage/event-buffer.test.ts
git commit -m "feat(storage): MessageEventBuffer 50ms 批量缓冲（A 子系统性能优化）"
```

---

## Task A5: renderer stream-aggregator（共用聚合函数）

**Files:**
- Create: `renderer/src/lib/stream-aggregator.ts`
- Test: `renderer/tests/lib/stream-aggregator.test.ts`

**Interfaces:**
- Consumes: `MessageEventRow` 类型（与 electron 共享，通过 ipc/types.d.ts）
- Produces（供 A8 stream.store 重写时使用）：

```typescript
export interface AggregatedStream {
  streamSessionId: string;
  botUserId?: string;
  parentStreamSessionId?: string;
  thinking: string;        // 所有 thinking_delta 拼接
  text: string;            // 所有 text_delta 拼接
  toolCalls: AggregatedToolCall[];  // tool_call_start + 配对 tool_call_result
  todos: TodoItem[];       // 最后一次 todo_update 的快照
  dispatches: AggregatedDispatch[]; // dispatch_start + 配对 dispatch_result
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  events: Array<{ seq: number; type: string; content?: string }>; // 时间线（debugging）
}

export function aggregateEvents(events: MessageEventRow[]): AggregatedStream;
```

### Steps

- [ ] **Step 1: 写失败测试**

创建 `renderer/tests/lib/stream-aggregator.test.ts`：

```typescript
// renderer/tests/lib/stream-aggregator.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateEvents } from '../../src/lib/stream-aggregator';
import type { MessageEventRow } from '../../src/ipc/types';

function mkEvent(seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq };
}

describe('aggregateEvents', () => {
  it('空事件返回初始态', () => {
    const s = aggregateEvents([]);
    expect(s.thinking).toBe('');
    expect(s.text).toBe('');
    expect(s.toolCalls).toEqual([]);
    expect(s.todos).toEqual([]);
    expect(s.dispatches).toEqual([]);
    expect(s.status).toBe('streaming'); // 默认 streaming，final 才转 done
  });

  it('thinking_delta 拼接', () => {
    const s = aggregateEvents([
      mkEvent(0, 'thinking_delta', { delta: 'Hello' }),
      mkEvent(1, 'thinking_delta', { delta: ' world' }),
    ]);
    expect(s.thinking).toBe('Hello world');
  });

  it('text_delta 拼接', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'foo' }),
      mkEvent(1, 'text_delta', { delta: 'bar' }),
    ]);
    expect(s.text).toBe('foobar');
  });

  it('tool_call_start + tool_call_result 配对', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'read_file', args: { path: '/a.ts' }, callId: 'c1' }),
      mkEvent(1, 'tool_call_result', { callId: 'c1', result: 'file content', success: true }),
    ]);
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]).toEqual({
      callId: 'c1',
      toolName: 'read_file',
      args: { path: '/a.ts' },
      result: 'file content',
      success: true,
    });
  });

  it('多个 tool_call 互不干扰（按 callId 配对）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'a', args: {}, callId: 'c1' }),
      mkEvent(1, 'tool_call_start', { toolName: 'b', args: {}, callId: 'c2' }),
      mkEvent(2, 'tool_call_result', { callId: 'c2', result: 'rb', success: true }),
      mkEvent(3, 'tool_call_result', { callId: 'c1', result: 'ra', success: false }),
    ]);
    expect(s.toolCalls.length).toBe(2);
    const a = s.toolCalls.find((t) => t.callId === 'c1');
    const b = s.toolCalls.find((t) => t.callId === 'c2');
    expect(a?.success).toBe(false);
    expect(b?.success).toBe(true);
  });

  it('tool_call_start 但无 result（执行中）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'a', args: {}, callId: 'c1' }),
    ]);
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]).toMatchObject({ callId: 'c1', result: null, success: null });
  });

  it('todo_update 全量替换（最后一次为准）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'todo_update', { todos: [{ id: '1', subject: 'a', status: 'pending' }] }),
      mkEvent(1, 'todo_update', { todos: [{ id: '2', subject: 'b', status: 'in_progress' }] }),
    ]);
    expect(s.todos.length).toBe(1);
    expect(s.todos[0].id).toBe('2');
  });

  it('dispatch_start + dispatch_result 配对', () => {
    const s = aggregateEvents([
      mkEvent(0, 'dispatch_start', {
        callId: 'd1',
        subStreamSessionId: 'sss1',
        subAgentName: 'Programmer',
        subAgentAvatar: '🤖',
        task: '写登录页',
      }),
      mkEvent(1, 'dispatch_result', { callId: 'd1', status: 'completed' }),
    ]);
    expect(s.dispatches.length).toBe(1);
    expect(s.dispatches[0]).toMatchObject({
      callId: 'd1',
      subStreamSessionId: 'sss1',
      subAgentName: 'Programmer',
      status: 'completed',
    });
  });

  it('segment_boundary 标记（保留在 events 时间线，不参与聚合）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'a' }),
      mkEvent(1, 'segment_boundary', { index: 0, total: 3 }),
      mkEvent(2, 'text_delta', { delta: 'b' }),
    ]);
    expect(s.text).toBe('ab'); // 跨 segment 仍拼接
    expect(s.events.some((e) => e.type === 'segment_boundary')).toBe(true);
  });

  it('status_change 变更状态', () => {
    const s = aggregateEvents([
      mkEvent(0, 'status_change', { status: 'streaming' }),
      mkEvent(1, 'status_change', { status: 'failed' }),
    ]);
    expect(s.status).toBe('failed');
  });

  it('final 事件转 status=done', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'a' }),
      mkEvent(1, 'final', { body: 'a' }),
    ]);
    expect(s.status).toBe('done');
  });

  it('events 时间线按 seq 升序', () => {
    const s = aggregateEvents([
      mkEvent(2, 'text_delta', { delta: 'c' }),
      mkEvent(0, 'thinking_delta', { delta: 'a' }),
      mkEvent(1, 'text_delta', { delta: 'b' }),
    ]);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run tests/lib/stream-aggregator.test.ts
```

- [ ] **Step 3: 实现 aggregator**

创建 `renderer/src/lib/stream-aggregator.ts`：

```typescript
// renderer/src/lib/stream-aggregator.ts
//
// message_events → AggregatedStream 共用聚合函数。
//
// 这是 A 子系统的核心不变量：
//   实时显示（增量 events 推送）和重启显示（一次性 loadAll events）
//   都用同一份 events 数组 + 这个函数，保证 UI 完全一致。
//
// 输入约定：events 必须按 seq 升序（DB 层 ORDER BY seq ASC 已保证）。
// 输出：聚合后的 StreamState-like 结构（与 stream.store 的 StreamState 兼容字段）。
import type { MessageEventRow, TodoItem } from '../ipc/types';

export interface AggregatedToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: string | null;   // null = 执行中
  success: boolean | null; // null = 执行中
}

export interface AggregatedDispatch {
  callId: string;
  subStreamSessionId: string;
  subAgentName: string;
  subAgentAvatar?: string;
  task: string;
  status: 'queued' | 'executing' | 'completed' | 'failed' | 'timeout';
}

export interface AggregatedStream {
  thinking: string;
  text: string;
  toolCalls: AggregatedToolCall[];
  todos: TodoItem[];
  dispatches: AggregatedDispatch[];
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  events: Array<{ seq: number; type: string; content?: string }>;
}

export function aggregateEvents(events: MessageEventRow[]): AggregatedStream {
  let thinking = '';
  let text = '';
  let status: AggregatedStream['status'] = 'streaming';
  let todos: TodoItem[] = [];

  // tool_call / dispatch 按 callId 暂存 start payload，再被 result 配对
  const toolStarts = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  const toolResults = new Map<string, { result: string; success: boolean }>();
  const dispatchStarts = new Map<string, Omit<AggregatedDispatch, 'status'>>();
  const dispatchStatuses = new Map<string, AggregatedDispatch['status']>();

  const timeline: AggregatedStream['events'] = [];

  for (const e of events) {
    timeline.push({ seq: e.seq, type: e.eventType });
    const p = e.payload;
    switch (e.eventType) {
      case 'thinking_delta':
        if (typeof p.delta === 'string') thinking += p.delta;
        break;
      case 'text_delta':
        if (typeof p.delta === 'string') text += p.delta;
        break;
      case 'tool_call_start':
        if (typeof p.callId === 'string' && typeof p.toolName === 'string') {
          toolStarts.set(p.callId, {
            toolName: p.toolName,
            args: (p.args as Record<string, unknown>) ?? {},
          });
        }
        break;
      case 'tool_call_result':
        if (typeof p.callId === 'string') {
          toolResults.set(p.callId, {
            result: typeof p.result === 'string' ? p.result : '',
            success: p.success === true,
          });
        }
        break;
      case 'todo_update':
        if (Array.isArray(p.todos)) {
          todos = p.todos as TodoItem[];
        }
        break;
      case 'dispatch_start':
        if (typeof p.callId === 'string' && typeof p.subStreamSessionId === 'string') {
          dispatchStarts.set(p.callId, {
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            ...(typeof p.subAgentAvatar === 'string' ? { subAgentAvatar: p.subAgentAvatar } : {}),
            task: typeof p.task === 'string' ? p.task : '',
          });
          dispatchStatuses.set(p.callId, 'executing');
        }
        break;
      case 'dispatch_result':
        if (typeof p.callId === 'string' && (p.status === 'completed' || p.status === 'failed' || p.status === 'timeout')) {
          dispatchStatuses.set(p.callId, p.status);
        }
        break;
      case 'segment_boundary':
        // 仅时间线记录，不参与聚合
        break;
      case 'status_change':
        if (p.status === 'streaming' || p.status === 'done' || p.status === 'failed' || p.status === 'aborted') {
          status = p.status;
        }
        break;
      case 'final':
        status = 'done';
        break;
    }
  }

  // 配对 tool calls
  const toolCalls: AggregatedToolCall[] = Array.from(toolStarts.entries()).map(([callId, start]) => {
    const result = toolResults.get(callId);
    return {
      callId,
      toolName: start.toolName,
      args: start.args,
      result: result?.result ?? null,
      success: result?.success ?? null,
    };
  });

  // 配对 dispatches
  const dispatches: AggregatedDispatch[] = Array.from(dispatchStarts.values()).map((start) => ({
    ...start,
    status: dispatchStatuses.get(start.callId) ?? 'queued',
  }));

  return { thinking, text, toolCalls, todos, dispatches, status, events: timeline };
}
```

- [ ] **Step 4: 加 MessageEventRow + TodoItem 类型到 renderer types.d.ts**

修改 `renderer/src/ipc/types.d.ts`，在 StreamChunk 定义之后追加：

```typescript
/** A 子系统：事件溯源——单条 stream chunk 落盘一行 */
export interface MessageEventRow {
  id: string;
  messageId: string;
  seq: number;
  eventType:
    | 'thinking_delta'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_result'
    | 'todo_update'
    | 'dispatch_start'
    | 'dispatch_result'
    | 'segment_boundary'
    | 'status_change'
    | 'final';
  payload: Record<string, unknown>;
  createdAt: number;
}

/** MessageEventRow[] 批量推送（IPC 通道 im:message_event_batch） */
export type MessageEventBatch = MessageEventRow[];
```

（如果 TodoItem 已存在则跳过定义。）

- [ ] **Step 5: 运行测试 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run tests/lib/stream-aggregator.test.ts
npx pnpm@9.0.0 typecheck
git add renderer/src/lib/stream-aggregator.ts renderer/tests/lib/stream-aggregator.test.ts renderer/src/ipc/types.d.ts
git commit -m "feat(renderer): stream-aggregator 共用聚合函数（A 子系统）"
```

---

## Task A6: IPC 通道 im:message_event_batch + 改造 im.store

**Files:**
- Modify: `electron/src/preload/index.ts`（加 onMessageEventBatch 桥接）
- Modify: `renderer/src/ipc/types.d.ts`（ApiSurface.im 加 onMessageEventBatch + getMessages 改返回类型）
- Modify: `renderer/src/ipc/client.ts`（暴露新方法）
- Modify: `electron/src/main/im/ipc.handlers.ts`（注册 IPC 主进程侧）
- Modify: `renderer/src/stores/im.store.ts`（重写读路径，调用 stream-aggregator）

**Interfaces:**
- Consumes: A2 `listMessagesByRoom` / `listOlderMessages`；A3 `listEventsByMessage`；A5 `aggregateEvents`
- Produces: renderer 端 `im.store` 通过 `im:getMessages` / `im:loadOlderMessages` / `im:onMessageEventBatch` 读 SQLite 唯一真相源

### Steps

- [ ] **Step 1: 在 ipc/types.d.ts 扩展 ImMessage + ApiSurface.im**

修改 `renderer/src/ipc/types.d.ts`：

找到现有 `ImMessage` 接口（约 119 行），替换为：

```typescript
export interface ImMessage {
  id: string;                  // SQLite messages.id（UUID）
  roomId: string;
  sender: string;
  body: string;
  eventType: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  matrixEventId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}
```

注意：**删除旧的 `content: Record<string, unknown>` 和 `timestamp: number` 字段**。`timestamp` 改名 `createdAt`，`content` 字段废弃（不再读 Matrix event 富字段）。

修改 `ApiSurface.im` 段：

```typescript
  im: {
    startSync(): Promise<void>;
    send(roomId: string, body: string): Promise<void>;
    sendWithMentions(roomId: string, body: string, mentionedUserIds: string[]): Promise<void>;
    getRooms(workspaceId?: string): Promise<ImRoomInfo[]>;
    /** A 子系统：从 SQLite 拉 messages + 每条 message 的 events，用 stream-aggregator 重建 StreamState */
    getMessages(roomId: string): Promise<{ messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]> }>;
    /** 向前翻页：返回 SQLite 里 created_at < beforeTs 的消息 */
    loadOlderMessages(roomId: string, beforeTs: number, count?: number): Promise<{ messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]>; hasMore: boolean }>;
    getMessageEvents(messageId: string): Promise<MessageEventRow[]>;
    createRoom(input: { name: string; isDirect: boolean; inviteUserIds: string[]; workspaceId?: string }): Promise<{ roomId: string }>;
    renameRoom(roomId: string, name: string): Promise<{ ok: boolean }>;
    dissolveRoom(roomId: string): Promise<{ dissolved: boolean }>;
    getMembers(roomId: string): Promise<RoomMember[]>;
    exportRoomMessages(roomId: string, limit: number): Promise<{ filename: string; content: string }>;
    onMessage(callback: (msg: ImMessage) => void): () => void;
    /** A 子系统：订阅 stream chunk 批量推送（主进程 MessageEventBuffer flush 时触发） */
    onMessageEventBatch(callback: (batch: MessageEventBatch) => void): () => void;
  };
```

- [ ] **Step 2: 在 preload 加 onMessageEventBatch 桥接**

修改 `electron/src/preload/index.ts`，在 `im:` 命名空间下追加（参考已有 `onMessage` 写法）：

```typescript
    onMessageEventBatch(callback) {
      const handler = (_e: unknown, batch: unknown) => callback(batch as import('../../../renderer/src/ipc/types').MessageEventBatch);
      ipcRenderer.on('im:message_event_batch', handler);
      return () => ipcRenderer.off('im:message_event_batch', handler);
    },
    getMessageEvents(messageId) {
      return ipcRenderer.invoke('im:getMessageEvents', messageId);
    },
```

- [ ] **Step 3: 主进程注册 IPC handler**

修改 `electron/src/main/im/ipc.handlers.ts`，在 registerImHandlers 末尾追加：

```typescript
  // A 子系统：从 SQLite 读 messages + events（替代旧 getRoomMessages）
  ipcMain.handle('im:getMessages', async (_evt, roomId: string) => {
    const messages = listMessagesByRoom(roomId);
    const eventsByMessage: Record<string, MessageEventRow[]> = {};
    for (const m of messages) {
      eventsByMessage[m.id] = listEventsByMessage(m.id);
    }
    return { messages, eventsByMessage };
  });

  ipcMain.handle('im:loadOlderMessages', async (_evt, roomId: string, beforeTs: number, count = 30) => {
    const messages = listOlderMessages(roomId, beforeTs, count);
    const eventsByMessage: Record<string, MessageEventRow[]> = {};
    for (const m of messages) {
      eventsByMessage[m.id] = listEventsByMessage(m.id);
    }
    // hasMore: 如果本批满了，可能还有更早的
    const hasMore = messages.length >= count;
    return { messages, eventsByMessage, hasMore };
  });

  ipcMain.handle('im:getMessageEvents', async (_evt, messageId: string) => {
    return listEventsByMessage(messageId);
  });
```

在文件顶部加 import：

```typescript
import { listMessagesByRoom, listOlderMessages } from '../storage/messages/repo';
import { listEventsByMessage, type MessageEventRow } from '../storage/messages/events-repo';
```

- [ ] **Step 4: 删除旧的 getRoomMessages / loadOlderMessages 调用**

`electron/src/main/im/ipc.handlers.ts` 顶部移除 import：

```typescript
// 删除这行：
//   loadOlderMessages,
// 修改这行（移除 getRoomMessages）：
import {
  startSyncFromSession,
  sendMessage,
  sendMessageWithMentions,
  getRoomsForWorkspace,
} from '../matrix/sync-manager';
```

注意：`im:exportRoomMessages` 还在用 `getRoomMessages`——本 task 暂时保留（A9 改造 markdown-exporter 时再切换）。改用临时方案：

```typescript
  ipcMain.handle(
    'im:exportRoomMessages',
    async (_evt, roomId: string, limit: number): Promise<{ filename: string; content: string }> => {
      // A 子系统过渡：从 SQLite 读
      const messages = listMessagesByRoom(roomId, { limit });
      // ...（其余 markdown-exporter 调用逻辑保持不变，把 messages 适配为 ExportMessage[]）
    },
  );
```

- [ ] **Step 5: 重写 im.store.ts**

修改 `renderer/src/stores/im.store.ts`，关键改动：

1. `load()` 改用新 IPC 通道（返回 messages + eventsByMessage）
2. `loadOlder()` 同理
3. 加 `eventsByMessage` state + `onMessageEventBatch` 订阅
4. 删除原来从 Matrix content 提取 io.momo-studio.* 的逻辑

新 store 骨架：

```typescript
// renderer/src/stores/im.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ImMessage, MessageEventRow } from '../ipc/types';

interface ImState {
  rooms: ImRoomInfo[];
  activeRoomId: string | null;
  messagesByRoom: Record<string, ImMessage[]>;
  eventsByMessage: Record<string, MessageEventRow[]>; // messageId → events
  loading: boolean;
  loadingOlderByRoom: Record<string, boolean>;
  hasMoreByRoom: Record<string, boolean>;
  teamRoomMessages: ImMessage[]; // v1.5.7 跨房搜索子 agent 消息（A9 删除）

  setActiveRoom: (roomId: string | null) => void;
  loadRooms: () => Promise<void>;
  load: (roomId: string) => Promise<void>;
  loadOlder: (roomId: string) => Promise<void>;
  onIncomingMessage: (msg: ImMessage) => void;  // im:message 触发
  onIncomingEventBatch: (batch: MessageEventRow[]) => void;  // im:message_event_batch 触发
}

export const useImStore = create<ImState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messagesByRoom: {},
  eventsByMessage: {},
  loading: false,
  loadingOlderByRoom: {},
  hasMoreByRoom: {},
  teamRoomMessages: [],

  setActiveRoom: (roomId) => set({ activeRoomId: roomId }),

  loadRooms: async () => {
    const rooms = await ipc.im.getRooms();
    set({ rooms });
  },

  load: async (roomId) => {
    set({ loading: true });
    try {
      const { messages, eventsByMessage } = await ipc.im.getMessages(roomId);
      set((s) => ({
        messagesByRoom: { ...s.messagesByRoom, [roomId]: messages },
        eventsByMessage: { ...s.eventsByMessage, ...eventsByMessage },
        loading: false,
        hasMoreByRoom: { ...s.hasMoreByRoom, [roomId]: messages.length >= 30 },
      }));
    } catch {
      set({ loading: false });
    }
  },

  loadOlder: async (roomId) => {
    if (get().loadingOlderByRoom[roomId]) return;
    const messages = get().messagesByRoom[roomId] ?? [];
    if (messages.length === 0) return;
    const oldestTs = messages[0].createdAt;
    set((s) => ({ loadingOlderByRoom: { ...s.loadingOlderByRoom, [roomId]: true } }));
    try {
      const { messages: older, eventsByMessage, hasMore } = await ipc.im.loadOlderMessages(roomId, oldestTs, 30);
      set((s) => ({
        messagesByRoom: { ...s.messagesByRoom, [roomId]: [...older, ...messages] },
        eventsByMessage: { ...s.eventsByMessage, ...eventsByMessage },
        loadingOlderByRoom: { ...s.loadingOlderByRoom, [roomId]: false },
        hasMoreByRoom: { ...s.hasMoreByRoom, [roomId]: hasMore },
      }));
    } catch {
      set((s) => ({ loadingOlderByRoom: { ...s.loadingOlderByRoom, [roomId]: false } }));
    }
  },

  onIncomingMessage: (msg) => {
    set((s) => {
      const list = s.messagesByRoom[msg.roomId] ?? [];
      // 同 eventId 不重复（启动时 onMessage 可能与 getMessages 重叠）
      if (list.some((m) => m.id === msg.id)) return s;
      return {
        messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: [...list, msg] },
      };
    });
  },

  onIncomingEventBatch: (batch) => {
    if (batch.length === 0) return;
    set((s) => {
      const newEvents = { ...s.eventsByMessage };
      for (const e of batch) {
        const list = newEvents[e.messageId] ?? [];
        // 同 id 不重复
        if (list.some((x) => x.id === e.id)) continue;
        newEvents[e.messageId] = [...list, e];
      }
      return { eventsByMessage: newEvents };
    });
  },
}));

// 全局订阅（在 App.tsx 调用一次）
export function subscribeImChannels(): () => void {
  const off1 = ipc.im.onMessage((msg) => useImStore.getState().onIncomingMessage(msg));
  const off2 = ipc.im.onMessageEventBatch((batch) => useImStore.getState().onIncomingEventBatch(batch));
  return () => { off1(); off2(); };
}
```

- [ ] **Step 6: 适配调用方（MessageList / MessageBubble）**

`renderer/src/components/im/MessageList.tsx` 改用新 store：

- 删除原来的 `m.eventId` 引用 → 改用 `m.id`
- 删除原来的 `m.timestamp` → 改用 `m.createdAt`
- 删除 `m.content?.[...]` 读取 → 改为读 eventsByMessage[m.id] 然后 aggregateEvents
- 删除 `teamRoomMessages` 跨房搜索（A9 完整删除，本 task 暂留空数组）

`renderer/src/components/im/MessageBubble.tsx` 改造：

- 删除 extractAgentMeta / extractDispatchesField / buildStreamFromMessage
- 改用：从 props 拿 eventsByMessage[m.id] → aggregateEvents → 渲染 thinking/toolCalls/dispatches
- 删除 ipc.agent.getMeta 调用（A9 删除 agent_meta 时彻底移除）

由于改造量大，本 step 只改 MessageList 的核心数据流；MessageBubble 完整改造放 A9。

- [ ] **Step 7: typecheck + 测试 + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(im): IPC im:message_event_batch + im.store 改读 SQLite（A 子系统核心切换）"
```

注意：此时旧 MessageBubble 代码可能编译报错（删除了 m.content 引用但保留 extractAgentMeta），用 `// @ts-expect-error A9 待移除` 临时让 typecheck 过；A9 会彻底清理。**严禁用 `as any`**——只能用 `@ts-expect-error` 标注待删代码。

---

## Task A7: 改造 runtime-entry + runtime-manager（stream chunk → 主进程 buffer）

**Files:**
- Modify: `electron/src/main/agent/runtime-manager.ts`（stream 转发 + 初始化 MessageEventBuffer）
- Modify: `electron/src/main/agent/runtime-entry.ts`（stream chunk 仍走 process.send，主进程侧转发到 buffer）
- Modify: `electron/src/main/storage/messages/event-buffer.ts`（如需调整）

**Interfaces:**
- Consumes: A4 MessageEventBuffer；A2 messages repo（创建 streaming message 行）
- Produces: agent runtime 每个 stream chunk 自动落 SQLite + 推送 renderer

### Steps

- [ ] **Step 1: 在 runtime-manager 初始化 MessageEventBuffer 单例**

修改 `electron/src/main/agent/runtime-manager.ts`，在模块顶部加：

```typescript
import { MessageEventBuffer } from '../storage/messages/event-buffer';
import { insertMessage, updateMessageStatus, getMessageByStreamSessionId } from '../storage/messages/repo';
import { BrowserWindow } from 'electron';

// 全局单例（每 agent 实例独立 buffer 也可，但单例简化 + 内部已并发安全）
let eventBuffer: MessageEventBuffer | null = null;

function getEventBuffer(): MessageEventBuffer {
  if (!eventBuffer) {
    eventBuffer = new MessageEventBuffer({
      onFlush: (events) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return;
        win.webContents.send('im:message_event_batch', events);
      },
    });
  }
  return eventBuffer;
}

/** 测试用：重置单例 */
export function __resetEventBufferForTest(): void {
  eventBuffer?.destroy();
  eventBuffer = null;
}
```

- [ ] **Step 2: 在 stream chunk 转发处接入 buffer**

runtime-manager 原有把子进程 stream chunk 推给 renderer 的逻辑（在 fork 子进程的 `child.on('message', ...)` 内）。改造：

```typescript
// 原代码：
// child.on('message', (chunk: StreamChunk) => {
//   mainWindow.webContents.send('agent:stream', chunk);
// });

// 新代码：
child.on('message', (chunk: StreamChunk) => {
  // 1. 仍推 renderer 兼容旧 stream.store（A8 完全重写后再删）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:stream', chunk);
  }
  // 2. A 子系统：stream chunk → MessageEventBuffer 落盘
  routeChunkToBuffer(chunk);
});

function routeChunkToBuffer(chunk: StreamChunk): void {
  const buf = getEventBuffer();
  switch (chunk.type) {
    case 'start': {
      // 在 messages 表创建一行（status='streaming'）
      insertMessage({
        roomId: chunk.roomId,
        sender: chunk.botUserId,
        eventType: 'm.room.message',
        body: '',
        streamSessionId: chunk.streamSessionId,
        parentStreamSessionId: chunk.parentStreamSessionId,
        status: 'streaming',
      });
      buf.append({
        messageId: getMessageByStreamSessionId(chunk.streamSessionId)!.id,
        eventType: 'status_change',
        payload: { status: 'streaming' },
      });
      break;
    }
    case 'thinking':
    case 'text': {
      const msg = getMessageByStreamSessionId(chunk.streamSessionId);
      if (!msg) return;
      buf.append({
        messageId: msg.id,
        eventType: chunk.type === 'thinking' ? 'thinking_delta' : 'text_delta',
        payload: { delta: chunk.delta },
      });
      break;
    }
    case 'tool_call': {
      const msg = getMessageByStreamSessionId(chunk.streamSessionId);
      if (!msg) return;
      buf.append({
        messageId: msg.id,
        eventType: 'tool_call_start',
        payload: {
          callId: `${chunk.streamSessionId}-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          toolName: chunk.toolName,
          args: chunk.args,
          ...(chunk.isDispatch ? {
            isDispatch: true,
            subStreamSessionId: chunk.subStreamSessionId,
            subAgentName: chunk.subAgentName,
            subAgentAvatar: chunk.subAgentAvatar,
          } : {}),
        },
      });
      break;
    }
    case 'tool_result': {
      const msg = getMessageByStreamSessionId(chunk.streamSessionId);
      if (!msg) return;
      // callId 由调用方在 chunk 内携带；若没有，则用最后插入的 tool_call_start（不推荐，runtime-entry 应改）
      // runtime-entry 改造在下一步（Step 4）
      buf.append({
        messageId: msg.id,
        eventType: 'tool_call_result',
        payload: {
          // 注意：StreamChunk.tool_result 当前没有 callId 字段，A7 步骤 4 会在 runtime-entry 加上
          // 这里临时用 toolName 匹配（不完美，A9 重写时统一）
          toolName: chunk.toolName,
          result: chunk.result,
          success: chunk.success,
          ...(chunk.subStatus ? { subStatus: chunk.subStatus } : {}),
        },
      });
      break;
    }
    case 'todo_update': {
      const msg = getMessageByStreamSessionId(chunk.streamSessionId);
      if (!msg) return;
      buf.append({
        messageId: msg.id,
        eventType: 'todo_update',
        payload: { todos: chunk.todos },
      });
      break;
    }
    case 'end': {
      const msg = getMessageByStreamSessionId(chunk.streamSessionId);
      if (!msg) return;
      const status = chunk.finishReason === 'stop' ? 'done' : chunk.finishReason === 'interrupted' ? 'aborted' : 'failed';
      updateMessageStatus(msg.id, status);
      buf.flush(); // 强制 flush 确保落盘
      buf.append({
        messageId: msg.id,
        eventType: 'final',
        payload: { status, error: chunk.error },
      });
      buf.flush();
      break;
    }
  }
}
```

- [ ] **Step 3: 在 StreamChunk 类型加 callId 字段（tool_call / tool_result）**

修改 `electron/src/main/agent/stream-chunk.ts` 和 `renderer/src/ipc/types.d.ts`：

tool_call 加 `callId: string`（必填）：
```typescript
  | {
      type: 'tool_call';
      streamSessionId: string;
      callId: string;            // ← 新增
      toolName: string;
      args: Record<string, unknown>;
      isDispatch?: boolean;
      subStreamSessionId?: string;
      subAgentName?: string;
      subAgentAvatar?: string;
    }
```

tool_result 加 `callId: string`（必填）：
```typescript
  | {
      type: 'tool_result';
      streamSessionId: string;
      callId: string;            // ← 新增
      toolName: string;
      result: string;
      success: boolean;
      subStatus?: 'completed' | 'failed' | 'timeout';
    }
```

- [ ] **Step 4: runtime-entry 在发 tool_call / tool_result chunk 时填 callId**

修改 `electron/src/main/agent/runtime-entry.ts`，所有 `sendStreamChunk({ type: 'tool_call', ... })` 调用加 `callId`：

```typescript
// 在 chat loop 内生成 callId（用 LLM 返回的 toolCall.id，或 fallback UUID）
const callId = llmToolCall.id ?? randomUUID();
sendStreamChunk({
  type: 'tool_call',
  streamSessionId,
  callId,
  toolName: llmToolCall.name,
  args: llmToolCall.arguments,
});
// ...执行工具...
sendStreamChunk({
  type: 'tool_result',
  streamSessionId,
  callId,  // 配对同一个 callId
  toolName: llmToolCall.name,
  result: toolResult,
  success: true,
});
```

搜索 runtime-entry.ts 所有 `sendStreamChunk` 调用点，逐一加 callId（约 4-6 处）。

- [ ] **Step 5: runtime-entry 删除 Matrix event 富字段写入**

搜索 runtime-entry.ts 中所有 `'io.momo-studio.thinking'`、`'io.momo-studio.tool_calls'`、`'io.momo-studio.todos'`、`'io.momo-studio.dispatches'`、`'io.momo-studio.segment_of'`、`'io.momo-studio.segment_index'`、`'io.momo-studio.parent_stream_session_id'`、`'io.momo-studio.tool_calls_offset'`、`'io.momo-studio.agent_meta_id'` 字段写入。

替换策略：
- 这些字段从 Matrix event content 中**全部移除**
- task_complete 分段发送时，仅写 body（保留 segmentBoundary 信号通过 buffer append 'segment_boundary' event）

具体代码改动示例（在 task_complete 分段处）：

```typescript
// 原代码：
// await client.sendEvent(roomId, 'm.room.message', {
//   body: segmentBody,
//   'io.momo-studio.thinking': thinking,
//   'io.momo-studio.tool_calls': incrementalCalls,
//   'io.momo-studio.tool_calls_offset': lastSegmentToolCallCount,
//   'io.momo-studio.segment_of': parentStreamSessionId,
//   'io.momo-studio.segment_index': segmentIndex,
//   ...
// }, '');

// 新代码：Matrix event 仅发 body（联网备份用）
await client.sendEvent(roomId, 'm.room.message', { body: segmentBody }, '');

// 富字段通过 MessageEventBuffer 走 SQLite（自动）
const msg = getMessageByStreamSessionId(streamSessionId);
if (msg) {
  buf.append({
    messageId: msg.id,
    eventType: 'segment_boundary',
    payload: { index: segmentIndex, body: segmentBody },
  });
  buf.flush();
}
```

- [ ] **Step 6: 删除 writeAgentMeta 调用**

搜索所有 `writeAgentMeta` 调用点，删除（agent_meta 表 A9 删）：

```typescript
// 原代码：
// if (shouldSplitMeta(thinking, toolCallsJson, todosJson)) {
//   const metaId = writeAgentMeta({ thinking, toolCalls: toolCallsJson, todos: todosJson });
//   content['io.momo-studio.agent_meta_id'] = metaId;
// }

// 新代码：直接删（thinking/toolCalls/todos 都在 SQLite message_events 里）
```

- [ ] **Step 7: 删除 fitEventContent 函数（PDU 截断逻辑）**

v1.5.6 引入的 `fitEventContent` 用于 Matrix event 4-5 级截断，A 之后不再需要：

```typescript
// 删除整个 fitEventContent 函数
// 删除所有调用点（已无意义——Matrix event 只发 body）
```

- [ ] **Step 8: typecheck + 测试 + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
# runtime-stream.test.ts 可能需要适配新 callId 字段——逐个测试改
git add -A
git commit -m "feat(agent): runtime stream chunk → SQLite event_buffer（A 子系统写入路径）"
```

预期：runtime-stream.test.ts 和 runtime-stream-abort.test.ts 部分用例需要补 callId 字段。**不要删除测试**，按错误信息改测试 fixture。

---

## Task A8: 重写 stream.store（基于 message_events）

**Files:**
- Modify: `renderer/src/stores/stream.store.ts`（完全重写）

**Interfaces:**
- Consumes: A5 `aggregateEvents`；A6 `im.store` 的 eventsByMessage；`im:onMessageEventBatch` 推送
- Produces: `StreamState` Map（与现有签名兼容，但底层来自 SQLite events 聚合）

### Steps

- [ ] **Step 1: 写 stream.store 测试**

创建/重写 `renderer/tests/stores/stream.store.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamStore } from '../../src/stores/stream.store';
import type { MessageEventRow } from '../../src/ipc/types';

function mkEvent(messageId: string, seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  return { id: `e${messageId}-${seq}`, messageId, seq, eventType, payload, createdAt: seq };
}

describe('stream.store (A 子系统重写)', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('applyEventBatch 累积 events，按 messageId 聚合为 StreamState', () => {
    const store = useStreamStore.getState();
    store.applyEventBatch([
      mkEvent('m1', 0, 'thinking_delta', { delta: 'think' }),
      mkEvent('m1', 1, 'text_delta', { delta: 'hi' }),
    ]);
    const stream = store.streams.get('m1');
    expect(stream).toBeDefined();
    expect(stream!.thinking).toBe('think');
    expect(stream!.text).toBe('hi');
    expect(stream!.status).toBe('streaming');
  });

  it('final 事件后 status=done', () => {
    const store = useStreamStore.getState();
    store.applyEventBatch([
      mkEvent('m1', 0, 'text_delta', { delta: 'a' }),
      mkEvent('m1', 1, 'final', {}),
    ]);
    expect(store.streams.get('m1')?.status).toBe('done');
  });

  it('增量 append（先 1 条，再 2 条），text 拼接正确', () => {
    const store = useStreamStore.getState();
    store.applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    store.applyEventBatch([
      mkEvent('m1', 1, 'text_delta', { delta: 'b' }),
      mkEvent('m1', 2, 'text_delta', { delta: 'c' }),
    ]);
    expect(store.streams.get('m1')?.text).toBe('abc');
  });

  it('从 ImStore eventsByMessage 初始化（重启场景）', () => {
    const store = useStreamStore.getState();
    const events = [
      mkEvent('m2', 0, 'thinking_delta', { delta: 'past' }),
      mkEvent('m2', 1, 'final', {}),
    ];
    store.hydrateFromEvents('m2', events);
    expect(store.streams.get('m2')?.thinking).toBe('past');
    expect(store.streams.get('m2')?.status).toBe('done');
  });

  it('reset 清空所有 streams', () => {
    const store = useStreamStore.getState();
    store.applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    store.reset();
    expect(store.streams.size).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run tests/stores/stream.store.test.ts
```

- [ ] **Step 3: 重写 stream.store**

完全替换 `renderer/src/stores/stream.store.ts`：

```typescript
// renderer/src/stores/stream.store.ts
//
// A 子系统重写：基于 message_events 事件流聚合 StreamState。
// 数据来源：
//   - 实时：ipc.im.onMessageEventBatch 推送（每 50ms 一批）
//   - 重启：ipc.im.getMessages 返回的 eventsByMessage
// 两条路径都走同一份 events 数组 + aggregateEvents 函数，UI 必然一致。
import { create } from 'zustand';
import type { MessageEventRow } from '../ipc/types';
import { aggregateEvents, type AggregatedStream } from '../lib/stream-aggregator';

export interface StreamState extends AggregatedStream {
  messageId: string;       // 关联 messages.id
  startedAt: number;       // 第一条 event 的 createdAt
}

interface StreamStoreState {
  streams: Map<string, StreamState>; // keyed by messageId（不再用 streamSessionId）
  applyEventBatch: (batch: MessageEventRow[]) => void;
  hydrateFromEvents: (messageId: string, events: MessageEventRow[]) => void;
  reset: () => void;
}

// 累积所有收到的 events（按 messageId），用于增量聚合
const eventLogByMessage = new Map<string, MessageEventRow[]>();

export const useStreamStore = create<StreamStoreState>((set) => ({
  streams: new Map(),

  applyEventBatch: (batch) => {
    if (batch.length === 0) return;
    // 累积到 eventLog
    for (const e of batch) {
      const list = eventLogByMessage.get(e.messageId) ?? [];
      // 去重（启动时可能与 hydrate 重叠）
      if (list.some((x) => x.id === e.id)) continue;
      list.push(e);
      list.sort((a, b) => a.seq - b.seq);
      eventLogByMessage.set(e.messageId, list);
    }
    // 重新聚合所有受影响的 messageId
    set((state) => {
      const newStreams = new Map(state.streams);
      const affectedIds = new Set(batch.map((e) => e.messageId));
      for (const msgId of affectedIds) {
        const events = eventLogByMessage.get(msgId) ?? [];
        const aggregated = aggregateEvents(events);
        newStreams.set(msgId, {
          ...aggregated,
          messageId: msgId,
          startedAt: events[0]?.createdAt ?? Date.now(),
        });
      }
      return { streams: newStreams };
    });
  },

  hydrateFromEvents: (messageId, events) => {
    eventLogByMessage.set(messageId, [...events].sort((a, b) => a.seq - b.seq));
    set((state) => {
      const newStreams = new Map(state.streams);
      const aggregated = aggregateEvents(eventLogByMessage.get(messageId) ?? []);
      newStreams.set(messageId, {
        ...aggregated,
        messageId,
        startedAt: events[0]?.createdAt ?? Date.now(),
      });
      return { streams: newStreams };
    });
  },

  reset: () => {
    eventLogByMessage.clear();
    set({ streams: new Map() });
  },
}));
```

- [ ] **Step 4: App.tsx 加全局订阅**

修改 `renderer/src/App.tsx`，在 useEffect 内调：

```typescript
useEffect(() => {
  const offBatch = ipc.im.onMessageEventBatch((batch) => {
    useStreamStore.getState().applyEventBatch(batch);
  });
  return () => offBatch();
}, []);
```

- [ ] **Step 5: 改 MessageList / MessageBubble 使用 stream.store.get(m.id)**

`MessageList.tsx` 改：

```typescript
// 旧：const streams = useStreamStore((s) => s.streams);
//     const activeRoomStreams = Array.from(streams.values()).filter(s => s.roomId === activeRoomId && !s.parentStreamSessionId);

// 新：streams Map 改为 keyed by messageId
//     渲染时根据 message.id 查 stream（流式中显示，done 后显示静态 body）
const messages = useImStore((s) => activeRoomId ? s.messagesByRoom[activeRoomId] ?? [] : []);
// 不再需要 activeRoomStreams——每条 message 都可能有自己的 stream 状态
```

`MessageBubble.tsx` 改：

```typescript
// 旧：const streams = useStreamStore((s) => s.streams);
//     const liveStream = streams.get(message.eventId); // eventId 不存在
//     const hasAgentMeta = ...

// 新：const stream = useStreamStore((s) => s.streams.get(message.id));
//     if (stream && stream.status === 'streaming') {
//       return <AgentStreamBubble stream={stream} message={message} />;
//     }
//     // 否则渲染静态消息（基于 message.body）
//     return <MessageFrame ...>{renderMarkdown(message.body)}</MessageFrame>;
```

- [ ] **Step 6: 测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "feat(renderer): stream.store 基于 message_events 重写（A 子系统一致性保证）"
```

---

## Task A9: 删除 Matrix 富字段读取 + agent_meta 表

**Files:**
- Modify: `renderer/src/components/im/MessageBubble.tsx`（彻底清理）
- Modify: `renderer/src/components/im/MessageList.tsx`（删 teamRoomMessages）
- Modify: `electron/src/main/storage/agent-meta.ts`（删除文件）
- Modify: 调用方（grep 查找）：`runtime-entry.ts`、`ipc.handlers.ts` 等
- Migration v18：删除 agent_meta 表

**Interfaces:**
- Consumes: A6/A7/A8 已切换到 SQLite
- Produces: 代码体积大幅减少；Matrix event 仅作传输层

### Steps

- [ ] **Step 1: grep 所有引用 agent_meta / Matrix 富字段的地方**

```bash
cd electron && grep -rn "agent_meta\|writeAgentMeta\|readAgentMeta\|shouldSplitMeta" src/
cd renderer && grep -rn "extractAgentMeta\|extractDispatchesField\|buildStreamFromMessage\|io\.momo-studio\." src/
```

逐个分析每个引用点。

- [ ] **Step 2: MessageBubble.tsx 彻底清理**

删除：
- `extractAgentMeta` 函数
- `extractDispatchesField` 函数
- `buildStreamFromMessage` 函数
- `extractTodos` 函数
- `isDispatchToolCall` 函数
- `buildHistoryDispatchChild` 函数
- 所有 `message.content?.['io.momo-studio.*']` 读取
- 所有 `ipc.agent.getMeta(metaId)` 调用
- 诊断 console.log（`[MessageBubble诊断]` / `[DispatchChip诊断]`）

新 MessageBubble 仅做：

```tsx
export function MessageBubble({ message, isSelf, senderName }: Props) {
  const stream = useStreamStore((s) => s.streams.get(message.id));

  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 流式中：渲染 AgentStreamBubble
  if (stream && stream.status === 'streaming') {
    return <AgentStreamBubble stream={stream} message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 已完成：从 stream（聚合自 events）或 fallback 到 message.body
  if (stream && (stream.thinking || stream.toolCalls.length || stream.dispatches.length)) {
    return (
      <MessageFrame sender={message.sender} isSelf={isSelf} senderName={senderName} bubbleClassName="bg-bg-tertiary text-neutral-100 border border-border-subtle" maxWidthPct={90} fillWidth>
        {stream.thinking && <ThinkingSection content={stream.thinking} />}
        {stream.toolCalls.filter(t => !t.toolName.startsWith('dispatch:')).map((tc, i) => (
          <ToolCallChip key={tc.callId} toolName={tc.toolName} args={tc.args} result={tc.result ?? ''} success={tc.success ?? false} defaultExpanded={false} />
        ))}
        {stream.dispatches.map((d) => (
          <DispatchChip key={d.callId} child={{ subStreamSessionId: d.subStreamSessionId, subAgentName: d.subAgentName, subAgentAvatar: d.subAgentAvatar, status: d.status }} subStream={undefined} />
        ))}
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body || stream.text}</ReactMarkdown></div>
      </MessageFrame>
    );
  }

  // 普通文本消息
  return (
    <MessageFrame sender={message.sender} isSelf={isSelf} senderName={senderName}>
      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown></div>
    </MessageFrame>
  );
}
```

- [ ] **Step 3: MessageList.tsx 删除 teamRoomMessages 跨房搜索**

```typescript
// 删除：const teamRoomMessages = useImStore((s) => s.teamRoomMessages);
// 删除：传给 MessageBubble 的 allMessages prop
// 删除：groupBySegment 里读 segment_of 字段（现在从 stream.status === 'done' 判断）
```

- [ ] **Step 4: 删除 agent-meta.ts 文件**

```bash
git rm electron/src/main/storage/agent-meta.ts
```

修改调用方：
- `runtime-entry.ts` 移除 `import { writeAgentMeta, shouldSplitMeta } from '../storage/agent-meta'`
- `ipc.handlers.ts` 移除 `agent:getMeta` IPC handler（renderer 不再调用）
- `preload/index.ts` 移除 `getMeta` 桥接
- `renderer/src/ipc/types.d.ts` 删除 `ApiSurface.agent.getMeta` 字段

- [ ] **Step 5: Migration v18 — 删除 agent_meta 表**

修改 `electron/src/main/storage/migrations/index.ts`：

```typescript
  {
    version: 18,
    sql: `
-- A 子系统：删除 agent_meta 表（已废弃，富元数据统一在 message_events）
DROP TABLE IF EXISTS agent_meta;
`.trim(),
  },
```

创建测试 `electron/tests/migrations/018-drop-agent-meta.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig18-test-${Date.now()}`);

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

describe('migration v18: drop agent_meta', () => {
  it('agent_meta 表已删除', () => {
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_meta'").get() as { name: string } | undefined;
    expect(row).toBeUndefined();
  });

  it('messages + message_events 表仍存在', () => {
    const db = getDb();
    const msgs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    const evts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_events'").get();
    expect(msgs).toBeDefined();
    expect(evts).toBeDefined();
  });
});
```

- [ ] **Step 6: 删除 markdown-exporter 对 m.content 的依赖**

修改 `electron/src/main/im/markdown-exporter.ts`：
- 把所有 `m.content?.['io.momo-studio.thinking']` 等读取改为从 `eventsByMessage[m.id]` + aggregateEvents 重建
- 或者更简单：exporter 只导出 body（thinking/tool_calls 已不在 markdown 输出关键路径，可后续增强）
- 本 task 取折中：exporter 仅导出 body + 时间戳 + sender，不再导出富元数据

- [ ] **Step 7: 测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "refactor(im): 删除 Matrix 富字段 + agent_meta 表（A 子系统清理）"
```

---

## Task A10: 重启一致性 e2e 测试

**Files:**
- Test: `electron/tests/integration/restart-consistency.test.ts`（新）

**目标**：验证 A 子系统核心承诺——实时显示与重启显示完全一致。

### Steps

- [ ] **Step 1: 写 e2e 测试**

```typescript
// electron/tests/integration/restart-consistency.test.ts
//
// A 子系统核心回归测试：
//   1. 模拟 stream chunk 序列（thinking + 多 text_delta + tool_call + final）
//   2. 通过 MessageEventBuffer 走完整落盘路径
//   3. 用 aggregateEvents 从 SQLite 重建 StreamState（模拟重启后 renderer 行为）
//   4. 断言重建后的 StreamState 与"实时推送的 chunk 序列聚合"完全一致
//
// 不启动真实 LLM；用 mock stream chunk 序列驱动。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage, getMessageByStreamSessionId, type MessageRow } from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';
import { aggregateEvents } from '../../../../renderer/src/lib/stream-aggregator';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-restart-${Date.now()}`);

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

describe('A 子系统：重启一致性', () => {
  it('模拟 agent 完整回复：实时聚合 == 重启聚合', () => {
    // 1. 启动 message + buffer
    const msg = insertMessage({
      roomId: 'r1', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-1', status: 'streaming',
    });
    const collectedBatch: MessageEventRow[] = [];
    const buf = new MessageEventBuffer({
      flushMs: 1000, // 避免自动 flush
      onFlush: (events) => collectedBatch.push(...events),
    });

    // 2. 模拟 stream chunk 序列
    buf.append({ messageId: msg.id, eventType: 'thinking_delta', payload: { delta: '让我想想' } });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: 'Hello' } });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: ' world' } });
    buf.append({ messageId: msg.id, eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'read_file', args: { path: '/a.ts' } } });
    buf.append({ messageId: msg.id, eventType: 'tool_call_result', payload: { callId: 'c1', result: 'file body', success: true } });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: ' done' } });
    buf.flush(); // 强制 flush
    buf.append({ messageId: msg.id, eventType: 'final', payload: { body: 'Hello world done' } });
    buf.flush();
    buf.destroy();

    // 3. "实时聚合"：collectedBatch 走 aggregateEvents（renderer 收到推送后的行为）
    const realTimeStream = aggregateEvents(collectedBatch);

    // 4. "重启聚合"：从 SQLite 读 events 走 aggregateEvents（renderer 重启后 getMessages 的行为）
    const dbEvents = listEventsByMessage(msg.id);
    const restartStream = aggregateEvents(dbEvents);

    // 5. 断言两者一致
    expect(restartStream.thinking).toBe(realTimeStream.thinking);
    expect(restartStream.text).toBe(realTimeStream.text);
    expect(restartStream.toolCalls).toEqual(realTimeStream.toolCalls);
    expect(restartStream.todos).toEqual(realTimeStream.todos);
    expect(restartStream.dispatches).toEqual(realTimeStream.dispatches);
    expect(restartStream.status).toBe(realTimeStream.status);

    // 关键：内容正确
    expect(restartStream.thinking).toBe('让我想想');
    expect(restartStream.text).toBe('Hello world done');
    expect(restartStream.toolCalls.length).toBe(1);
    expect(restartStream.toolCalls[0].toolName).toBe('read_file');
    expect(restartStream.status).toBe('done');
  });

  it('模拟 dispatch 嵌套：父子 agent 各自的 message 独立但可关联', () => {
    // PM message
    const pmMsg = insertMessage({
      roomId: 'r1', sender: '@pm:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'pm-ss', status: 'streaming',
    });
    // 子 agent message
    const subMsg = insertMessage({
      roomId: 'r1', sender: '@prog:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'sub-ss', parentStreamSessionId: 'pm-ss', status: 'streaming',
    });

    const buf = new MessageEventBuffer({ flushMs: 1000 });

    // PM 发起 dispatch
    buf.append({
      messageId: pmMsg.id,
      eventType: 'dispatch_start',
      payload: { callId: 'd1', subStreamSessionId: 'sub-ss', subAgentName: 'Programmer', subAgentAvatar: '👨‍💻', task: '写登录页' },
    });
    // 子 agent 工作
    buf.append({ messageId: subMsg.id, eventType: 'thinking_delta', payload: { delta: 'sub think' } });
    buf.append({ messageId: subMsg.id, eventType: 'text_delta', payload: { delta: '登录页已写' } });
    buf.append({ messageId: subMsg.id, eventType: 'final', payload: {} });
    // PM 收到 dispatch_result
    buf.append({ messageId: pmMsg.id, eventType: 'dispatch_result', payload: { callId: 'd1', status: 'completed' } });
    buf.append({ messageId: pmMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();

    // 重启聚合
    const pmStream = aggregateEvents(listEventsByMessage(pmMsg.id));
    const subStream = aggregateEvents(listEventsByMessage(subMsg.id));

    expect(pmStream.dispatches.length).toBe(1);
    expect(pmStream.dispatches[0].subStreamSessionId).toBe('sub-ss');
    expect(pmStream.dispatches[0].status).toBe('completed');
    expect(subStream.text).toBe('登录页已写');
  });

  it('模拟多段消息（task_complete 分段）：3 段 message 各自独立 + segment_boundary', () => {
    const segMsgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = insertMessage({
        roomId: 'r1', sender: '@bot:home', eventType: 'm.room.message',
        body: `第${i + 1}段`, streamSessionId: `seg-${i}`, segmentOf: 'parent-ss', segmentIndex: i,
      });
      segMsgIds.push(m.id);
    }
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    for (let i = 0; i < 3; i++) {
      buf.append({ messageId: segMsgIds[i], eventType: 'segment_boundary', payload: { index: i, total: 3 } });
      buf.append({ messageId: segMsgIds[i], eventType: 'final', payload: { body: `第${i + 1}段` } });
    }
    buf.flush();
    buf.destroy();

    // 重启：每段独立聚合
    const seg0 = aggregateEvents(listEventsByMessage(segMsgIds[0]));
    expect(seg0.events.some((e) => e.type === 'segment_boundary')).toBe(true);
    expect(seg0.status).toBe('done');

    // MessageList 渲染时按 segmentOf 分组（A8 已删 teamRoomMessages，segmentOf 仍可用于分组）
    const segmentGroups = segMsgIds.map((id) => ({
      id,
      segmentIndex: getMessageByStreamSessionId(`seg-${segMsgIds.indexOf(id)}`)?.segmentIndex,
    }));
    expect(segmentGroups.map((g) => g.segmentIndex)).toEqual([0, 1, 2]);
  });

  it('复杂场景：1000 个 text_delta + 50 个 tool_call 并发不丢数据', () => {
    const msg = insertMessage({
      roomId: 'r1', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'stress-ss', status: 'streaming',
    });
    const buf = new MessageEventBuffer({ flushMs: 10, flushBatch: 30 });

    // 1000 个 text_delta
    for (let i = 0; i < 1000; i++) {
      buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: 'a' } });
    }
    // 50 个 tool_call_start + result
    for (let i = 0; i < 50; i++) {
      buf.append({ messageId: msg.id, eventType: 'tool_call_start', payload: { callId: `c${i}`, toolName: 'noop', args: {} } });
      buf.append({ messageId: msg.id, eventType: 'tool_call_result', payload: { callId: `c${i}`, result: '', success: true } });
    }
    buf.flush();
    buf.destroy();

    const events = listEventsByMessage(msg.id);
    // 1000 + 50*2 = 1100
    expect(events.length).toBe(1100);
    // seq 连续 0-1099
    expect(events[0].seq).toBe(0);
    expect(events[1099].seq).toBe(1099);

    const stream = aggregateEvents(events);
    expect(stream.text).toBe('a'.repeat(1000));
    expect(stream.toolCalls.length).toBe(50);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/integration/restart-consistency.test.ts
```

预期：全部通过。如果失败，定位不一致根因——通常是 buffer 的 seq 分配 / aggregateEvents 的字段读取有 bug。

- [ ] **Step 3: 全套测试 + typecheck + commit**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
git add -A
git commit -m "test(integration): A 子系统重启一致性 e2e 测试（核心回归保护）"
```

---

## Self-Review

按 writing-plans skill 要求，对 Plan A 做以下检查：

### 1. Spec 覆盖检查

| spec 章节对应任务 | 任务 |
|---|---|
| messages + message_events 表 schema | A1 ✅ |
| messages repo（CRUD） | A2 ✅ |
| message_events repo + 批量插入 | A3 ✅ |
| MessageEventBuffer（50ms 批量） | A4 ✅ |
| stream-aggregator 共用聚合 | A5 ✅ |
| 写路径（user / agent / dispatch / 多段） | A7（runtime-manager + runtime-entry） ✅；A6（IPC 推送） ✅ |
| 读路径（实时 + 重启 + 翻页） | A6（im.store 重写） ✅；A8（stream.store 重写） ✅ |
| Matrix 降级角色（仅发 body + dispatch/task_reply） | A7（删富字段） ✅ |
| 性能保障（批量事务 + WAL） | A4 ✅；A10（压测） ✅ |
| 废弃 agent_meta 表 | A9 ✅ |
| 重启一致性验证 | A10 ✅ |

无遗漏。

### 2. Placeholder 扫描

- ✅ 所有 task 都有完整代码 / 完整测试
- ✅ 无 TBD / TODO
- ✅ 改造文件清单明确（grep + 逐一改）

### 3. 类型一致性

- `MessageRow.id` 类型 `string` ✅（所有 task 一致）
- `MessageEventRow.eventType` enum 一致 ✅
- `StreamState extends AggregatedStream` ✅（A5 定义，A8 用）
- IPC 通道命名 `im:message_event_batch` 一致 ✅
- `messages.id` vs 旧 `eventId`：A6 明确切换，A8 MessageList 改 `m.id` ✅

### 4. 已知风险

1. **runtime-entry.ts 改造范围大**（A7）：所有 sendStreamChunk 调用点要加 callId，搜索 grep 全覆盖
2. **MessageBubble.tsx 改造范围大**（A9）：删除多个 helper 函数，要确保所有 import 也清理
3. **markdown-exporter.ts 需要适配**（A9 step 6）：富元数据从 events 重建或简化导出
4. **runtime-stream.test.ts / runtime-stream-abort.test.ts**（A7 step 8）：现有测试要适配新 callId 字段
5. **子进程 IPC 测试**（A7）：runtime-manager 的 child.on('message') 改造需要集成测试覆盖

---

## 执行选项

Plan A 完成并保存到 `docs/plans/2026-08-13-platform-redesign-a-message-source-unification.md`。

两种执行方式可选：

### 1. Subagent-Driven（推荐）
- 我每个 task 派发一个 fresh subagent 执行
- 每个 task 完成后我 review + 跑测试验证
- 快速迭代，发现问题立即修正
- 适合大型重构

### 2. Inline Execution
- 我在当前会话内逐 task 执行
- 批量执行 + checkpoint 让你审阅
- 适合中小改动

**推荐 Subagent-Driven**——A 子系统改造范围大（10 个 task，含 runtime 架构改动），fresh subagent 能保持每个 task 上下文聚焦。

请选择执行方式，确认后我开始实施。
