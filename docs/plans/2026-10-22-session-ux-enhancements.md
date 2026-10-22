# 会话体验优化实施计划（类型图标 / 置顶 / 分组 / 多选建会 / agent 能力展示）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 六项会话体验优化——会话类型图标、全局置顶、手动分组、协作会话多选建会（含主 agent）、agent 描述与能力（MCP/工具/技能）友好展示。

**Architecture:** 迁移 067 加 `session_groups` 表与 sessions 三新列（`pinned_at` / `group_id` / `session_type`）；排序契约收敛在主进程 SQL（置顶区 > 分组 > 未分组 > 活跃时间）；`CollabTarget` 增 `members` 第三态实现建会临时组队；新只读 IPC `agent:getEffectiveCapabilities` 与 spawn 同源合并能力；renderer 以共享 `AgentPickerCard` 卡片行统一三个选择弹窗。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React + Zustand renderer（ESM + Vite）、Vitest（electron `--pool=forks`）。

**Spec:** `docs/specs/2026-10-22-session-ux-enhancements-design.md`（本计划一切取舍以 spec 为准，执行者须先读 spec）

## Global Constraints

- Node 24：所有命令前 `nvm use 24`；包管理一律 `npx pnpm@9.0.0`。
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）。
- renderer 新代码只用语义 token（`bg-surface-*` / `text-secondary`…），禁标准 Tailwind 色阶、禁 inline 硬编码颜色、禁 emoji 图标（iconEmoji 用户数据豁免）；图标 lucide-react，列表内 12-14px / stroke 1.75。
- 注释、文档、commit message 以外文案一律中文；Conventional Commits（`feat:` / `fix:` / `test:` / `docs:`）。
- 特性 commit 不动版本号；全部合入后一次性三处 `package.json` alpha +1（由收尾任务做，见 Task 14）。
- 测试位置：electron 主进程集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 与组件同目录）。
- electron DB 重度测试（storage/、im/、agent/）一律 `--pool=forks`。
- DB 单测范式：`process.env.AP_USER_DATA_DIR` 指向临时目录 → `runMigrations()` → `getDb()` → afterEach `closeDb()`（照抄 `electron/tests/storage/sessions-repo.test.ts`）。**测试夹具的 workspaces INSERT 列集以该文件现行写法为准（含 description / icon_emoji 等列）——本计划示例里的简化 INSERT 遇列不匹配时以该文件为准修正，勿反推 schema。**
- IPC 契约两端同步：改 `renderer/src/ipc/types.d.ts` 必同步 electron 镜像类型 + `electron/src/preload/index.ts` 桥接；每任务收尾跑 `npx pnpm@9.0.0 typecheck`（根目录，双 workspace）。
- 迁移模块范式：`electron/src/main/storage/migrations/0NN_*.ts` 导出 `{ version, up }`，在 `index.ts` 的 `MIGRATIONS` 数组尾注册 `{ version: migration0NN.version, sql: migration0NN.up }`。

## Review Focus（五类最可能咬人的输入/边界，测试必须锁死）

1. **旧库升级**（v066 → 067）：存量 chat 行回填多成员→collab、单成员→quick、task_execution→NULL；重复应用幂等 → Task 1 测试锁。
2. **receiveMessage 上浮越界**：置顶会话来消息不得移动；非置顶会话不得越置顶区、不得越组 → Task 5 测试锁。
3. **members 形态非法输入**：空列表 / leader 不在集合 / 跨 workspace 成员 → 中文 Error.message → Task 9 测试锁。
4. **置顶与分组独立**：删组后组内置顶会话回落未分组但保持置顶；置顶不清分组 → Task 2 + Task 3 测试锁。
5. **两端契约漂移**：types.d.ts 镜像字段与 electron 端不一致 / preload 缺桥接 → 每任务 typecheck 步骤锁（Task 3/4/9/12）。

---

# Phase 1：列表管理（类型图标 #1 / 置顶 #2 / 分组 #3）

### Task 1: 迁移 067——session_groups 表 + sessions 三新列 + 存量回填

**Files:**
- Create: `electron/src/main/storage/migrations/067_session_groups_pin_type.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（MIGRATIONS 数组尾，`migration066` 条目之后）
- Test: `electron/tests/storage/migration-067-session-groups.test.ts`

**Interfaces:**
- Produces: `migration067 = { version: 67, up: string }`（Task 2/3 的 SQL 依赖此 schema）。

- [ ] **Step 1: 写失败测试**（模式照抄 `migration-047-kanban-groups.test.ts` 的 `applyUpTo` + 生产注册路径取迁移）

```ts
// electron/tests/storage/migration-067-session-groups.test.ts
//
// 迁移 067 老库升级专项：构造 066 终态库 → 插入 workspace/sessions/session_members
// 既有行 → 应用 067 → 断言：三新列存在且存量回填正确（多成员 chat→collab、
// 单成员 chat→quick、task_execution→NULL）、session_groups 表 5 列、重复应用幂等。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

function applyUpTo(db: DB, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    mark.run(m.version);
  }
}

function migration67(): string {
  const m = loadMigrations().find((x) => x.version === 67);
  if (!m) throw new Error('migration 067 未注册进 MIGRATIONS 数组');
  return m.sql;
}

const WS = 'ws-a';

/** 066 终态夹具：一个 workspace + 三个会话（多成员 chat / 单成员 chat / task_execution） */
function seed066(db: DB): void {
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
    VALUES (?, 'ws', '/tmp/ws', 0, 'u1')`).run(WS);
  const ins = db.prepare(`INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`);
  ins.run('s-multi', WS, '多成员', 'chat', 100, 100);
  ins.run('s-single', WS, '单成员', 'chat', 101, 101);
  ins.run('s-task', WS, '任务', 'task_execution', 102, 102);
  const insMember = db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override, last_running, created_at)
     VALUES (?, ?, 'def-1', ?, 0, 0, 1)`);
  insMember.run('inst-1', WS, 'au-1');
  insMember.run('inst-2', WS, 'au-2');
  const insSm = db.prepare('INSERT INTO session_members (session_id, instance_id, is_leader, added_at) VALUES (?, ?, 0, 1)');
  insSm.run('s-multi', 'inst-1');
  insSm.run('s-multi', 'inst-2');
  insSm.run('s-single', 'inst-1');
}

describe('migration 067：会话分组/置顶/类型', () => {
  it('三新列存在且存量回填正确；task_execution 保持 NULL', () => {
    const db = new Database(':memory:');
    applyUpTo(db, 66);
    seed066(db);
    db.exec(migration67());
    const row = (id: string) =>
      db.prepare('SELECT pinned_at, group_id, session_type FROM sessions WHERE id = ?').get(id) as
        { pinned_at: number | null; group_id: string | null; session_type: string | null };
    expect(row('s-multi').session_type).toBe('collab');
    expect(row('s-single').session_type).toBe('quick');
    expect(row('s-task').session_type).toBeNull();
    expect(row('s-multi').pinned_at).toBeNull();
    expect(row('s-multi').group_id).toBeNull();
    db.close();
  });

  it('session_groups 表 5 列 + workspace 索引；重复应用幂等', () => {
    const db = new Database(':memory:');
    applyUpTo(db, 66);
    db.exec(migration67());
    const cols = (db.prepare('PRAGMA table_info(session_groups)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'workspace_id', 'name', 'position', 'created_at']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_groups_ws'").get();
    expect(idx).toBeTruthy();
    expect(() => db.exec(migration67())).toThrow(); // ALTER ADD COLUMN 重复应用必炸 → 幂等由迁移框架的版本标记保证
    db.close();
  });
});
```

注意：第二条断言「重复应用必炸」锁的是**迁移框架只能靠版本标记防重放**这一事实——不要给 SQL 加 IF NOT EXISTS 掩盖它（ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS）。`CREATE TABLE/INDEX` 保留 IF NOT EXISTS 与既有迁移习惯一致。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/migration-067-session-groups.test.ts`
Expected: FAIL——`migration 067 未注册进 MIGRATIONS 数组`

- [ ] **Step 3: 写迁移模块并注册**

```ts
// electron/src/main/storage/migrations/067_session_groups_pin_type.ts
//
// 会话体验优化（spec 2026-10-22 §3）：
//   1. session_groups 表（会话手动分组；position 镜像 task_groups 的 (i+1)*1024 契约）
//   2. sessions 三新列：pinned_at（非空即置顶，值=置顶时间戳）/ group_id（分组归属）/
//      session_type（'quick'|'collab'；NULL=泛化创建路径，图标按 kind 判定）
//   3. 存量回填：仅 chat 行按成员数一次推断（此后由创建路径定型，不再推断）
export const version = 67;
export const up = `
-- ─── 067：会话分组 / 置顶 / 类型（spec 2026-10-22）─────────────────────────
CREATE TABLE IF NOT EXISTS session_groups (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_groups_ws ON session_groups(workspace_id, position);
ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
ALTER TABLE sessions ADD COLUMN group_id TEXT REFERENCES session_groups(id);
ALTER TABLE sessions ADD COLUMN session_type TEXT;
UPDATE sessions SET session_type =
  CASE WHEN (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = sessions.id) > 1
  THEN 'collab' ELSE 'quick' END
WHERE kind = 'chat';
`;
```

在 `index.ts`：顶部 import 区加 `import * as migration067 from './067_session_groups_pin_type';`（对齐 066 的 import 风格）；`MIGRATIONS` 数组 `migration066` 条目之后追加：

```ts
  {
    // 会话体验优化（spec 2026-10-22 §3）：session_groups 表 + sessions
    // pinned_at/group_id/session_type 三列 + 存量 chat 行按成员数回填类型。
    version: migration067.version,
    sql: migration067.up,
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/migration-067-session-groups.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 回归既有迁移/存储测试 + commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/`
Expected: 全 PASS

```bash
git add electron/src/main/storage/migrations/067_session_groups_pin_type.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/migration-067-session-groups.test.ts
git commit -m "feat: 迁移 067——session_groups 表 + sessions 置顶/分组/类型三列与存量回填（spec 2026-10-22 §3）"
```

---

### Task 2: repo 扩展——SessionRow 新列映射 + session_groups CRUD + 置顶/归组写函数

**Files:**
- Modify: `electron/src/main/storage/sessions/repo.ts`
- Test: `electron/tests/storage/sessions-group-repo.test.ts`

**Interfaces:**
- Produces（Task 3/4 消费）:
  - `SessionRow` 增 `pinnedAt: number | null; groupId: string | null; sessionType: 'quick' | 'collab' | null`
  - `insertSession(input)` 增可选 `sessionType?: 'quick' | 'collab'`（缺省不写 NULL）
  - `interface SessionGroupRow { id: string; workspaceId: string; name: string; position: number; createdAt: number }`
  - `listSessionGroups(workspaceId: string): SessionGroupRow[]`
  - `insertSessionGroup(workspaceId: string, name: string): SessionGroupRow`
  - `renameSessionGroup(id: string, name: string): void`
  - `deleteSessionGroup(id: string): void`（事务：组内会话 group_id 置 NULL → 删组行）
  - `setSessionPinned(id: string, pinned: boolean): void`
  - `setSessionGroup(sessionId: string, groupId: string | null): void`

- [ ] **Step 1: 写失败测试**（DB 范式照抄 `sessions-repo.test.ts`：临时目录 + runMigrations + closeDb afterEach；夹具沿用其 workspaces/agent_definitions/workspace_agent_members 插入段）

```ts
// electron/tests/storage/sessions-group-repo.test.ts
//
// session_groups CRUD + 置顶/归组写函数测试（spec 2026-10-22 §4.1）。
// 覆盖：建组 position 步进 / 删组事务（组内会话回落未分组）/ 置顶切换 /
//       置顶与分组独立（删组后置顶会话仍置顶）/ insertSession sessionType 落列。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession, getSession, insertSessionGroup, listSessionGroups,
  renameSessionGroup, deleteSessionGroup, setSessionPinned, setSessionGroup,
} from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-session-group-repo-${Date.now()}`);
const WS = 'ws-g';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
     VALUES (?, 'ws', '/tmp/ws', 0, 'u1')`,
  ).run(WS);
});
afterEach(() => closeDb());

describe('session_groups CRUD', () => {
  it('建组 position 依次 +1024；列表按 position 升序', () => {
    const a = insertSessionGroup(WS, 'A');
    const b = insertSessionGroup(WS, 'B');
    expect(a.position).toBe(1024);
    expect(b.position).toBe(2048);
    expect(listSessionGroups(WS).map((g) => g.name)).toEqual(['A', 'B']);
  });

  it('重命名组', () => {
    const g = insertSessionGroup(WS, '旧名');
    renameSessionGroup(g.id, '新名');
    expect(listSessionGroups(WS)[0]!.name).toBe('新名');
  });

  it('删组事务：组内会话 group_id 回落 NULL；置顶会话删组后仍置顶（Review Focus #4）', () => {
    const g = insertSessionGroup(WS, 'G');
    const s = insertSession({ workspaceId: WS, title: 't', sessionType: 'collab' });
    setSessionGroup(s.id, g.id);
    setSessionPinned(s.id, true);
    deleteSessionGroup(g.id);
    const after = getSession(s.id)!;
    expect(after.groupId).toBeNull();
    expect(after.pinnedAt).not.toBeNull();
    expect(listSessionGroups(WS)).toEqual([]);
  });
});

describe('置顶/归组写函数', () => {
  it('setSessionPinned 切换：置顶写时间戳、取消回 NULL', () => {
    const s = insertSession({ workspaceId: WS, title: 't' });
    setSessionPinned(s.id, true);
    expect(getSession(s.id)!.pinnedAt).not.toBeNull();
    setSessionPinned(s.id, false);
    expect(getSession(s.id)!.pinnedAt).toBeNull();
  });

  it('insertSession sessionType 落列；缺省为 NULL', () => {
    const a = insertSession({ workspaceId: WS, title: 'a', sessionType: 'quick' });
    const b = insertSession({ workspaceId: WS, title: 'b' });
    expect(getSession(a.id)!.sessionType).toBe('quick');
    expect(getSession(b.id)!.sessionType).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/sessions-group-repo.test.ts`
Expected: FAIL——导入的 `insertSessionGroup` 等不存在

- [ ] **Step 3: 实现 repo 扩展**

`repo.ts` 修改点（全部贴着现有同族函数放置）：

```ts
// —— SqlRow / rowToCamel 扩展 ——
type SqlRow = {
  id: string; workspace_id: string; title: string; title_auto: number; kind: string;
  settings_json: string | null; created_at: number; updated_at: number; last_message_at: number | null;
  pinned_at: number | null; group_id: string | null; session_type: string | null;
};

function rowToCamel(r: SqlRow): SessionRow {
  return {
    id: r.id, workspaceId: r.workspace_id, title: r.title,
    titleAuto: r.title_auto === 1,
    kind: r.kind as SessionRow['kind'], settingsJson: r.settings_json,
    createdAt: r.created_at, updatedAt: r.updated_at, lastMessageAt: r.last_message_at,
    pinnedAt: r.pinned_at, groupId: r.group_id,
    sessionType: r.session_type === 'quick' || r.session_type === 'collab' ? r.session_type : null,
  };
}

// —— SessionRow 接口增三字段（注释中文）——
//   /** 置顶时间戳（spec 2026-10-22 §4.1）；NULL=未置顶 */
//   pinnedAt: number | null;
//   /** 所属分组（spec 2026-10-22 §4）；NULL=未分组 */
//   groupId: string | null;
//   /** 会话类型（spec §3.1）；NULL=泛化创建路径（图标按 kind 判定） */
//   sessionType: 'quick' | 'collab' | null;

// —— insertSession 增参（SQL 与 VALUES 同步加一列）——
export function insertSession(input: {
  workspaceId: string;
  title: string;
  kind?: SessionRow['kind'];
  titleAuto?: boolean;
  sessionType?: 'quick' | 'collab';
}): SessionRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at, session_type)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(id, input.workspaceId, input.title, input.titleAuto ? 1 : 0, input.kind ?? 'chat', now, now,
        input.sessionType ?? null);
  emitPluginEvent('sessionStarted', { id, workspaceId: input.workspaceId, title: input.title });
  return getSession(id)!;
}

// —— 文件尾部新增分组与置顶段 ——
// ─── 分组与置顶（spec 2026-10-22 §4.1）──────────────────────────────────────
export interface SessionGroupRow {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: number;
}

type GroupSqlRow = { id: string; workspace_id: string; name: string; position: number; created_at: number };

function groupRowToCamel(r: GroupSqlRow): SessionGroupRow {
  return { id: r.id, workspaceId: r.workspace_id, name: r.name, position: r.position, createdAt: r.created_at };
}

export function listSessionGroups(workspaceId: string): SessionGroupRow[] {
  const rows = getDb().prepare(
    'SELECT * FROM session_groups WHERE workspace_id = ? ORDER BY position ASC, created_at ASC',
  ).all(workspaceId) as GroupSqlRow[];
  return rows.map(groupRowToCamel);
}

export function insertSessionGroup(workspaceId: string, name: string): SessionGroupRow {
  const db = getDb();
  const id = randomUUID();
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM session_groups WHERE workspace_id = ?')
    .get(workspaceId) as { p: number };
  db.prepare(
    'INSERT INTO session_groups (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, workspaceId, name, max.p + 1024, Date.now());
  return groupRowToCamel(
    db.prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as GroupSqlRow,
  );
}

export function renameSessionGroup(id: string, name: string): void {
  getDb().prepare('UPDATE session_groups SET name = ? WHERE id = ?').run(name, id);
}

/** 删组（事务）：组内会话回落未分组 → 删组行。置顶位 pinned_at 独立保留（spec §4.1）。 */
export function deleteSessionGroup(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE sessions SET group_id = NULL, updated_at = ? WHERE group_id = ?').run(Date.now(), id);
    db.prepare('DELETE FROM session_groups WHERE id = ?').run(id);
  });
  tx();
}

/** 置顶切换：置顶=Date.now()（重置顶可上浮置顶区），取消=NULL。 */
export function setSessionPinned(id: string, pinned: boolean): void {
  getDb().prepare('UPDATE sessions SET pinned_at = ?, updated_at = ? WHERE id = ?')
    .run(pinned ? Date.now() : null, Date.now(), id);
}

export function setSessionGroup(sessionId: string, groupId: string | null): void {
  getDb().prepare('UPDATE sessions SET group_id = ?, updated_at = ? WHERE id = ?')
    .run(groupId, Date.now(), sessionId);
}
```

- [ ] **Step 4: 跑测试确认通过 + 既有 repo 测试回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/sessions-group-repo.test.ts tests/storage/sessions-repo.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/sessions/repo.ts electron/tests/storage/sessions-group-repo.test.ts
git commit -m "feat: sessions repo——置顶/归组写函数 + session_groups CRUD + SessionRow 新列映射（spec 2026-10-22 §4.1）"
```

---

### Task 3: JOIN 排序查询 + session_type 写入定型 + SessionSummary 契约扩展（两端）

**Files:**
- Modify: `electron/src/main/storage/sessions/repo.ts`（`listSessionsWithGroup` / `listAllSessions` 同源排序）
- Modify: `electron/src/main/im/session-ops.ts`（`insertSessionWithMembers` 加 sessionType；`createQuickSession`/`createCollabSession` 定型；`getSessionsForWorkspace` 扩展 summary）
- Modify: `renderer/src/ipc/types.d.ts`（SessionRow/SessionSummary 镜像扩展）
- Test: `electron/tests/storage/sessions-list-order.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SessionRow` 新列 / `insertSession.sessionType`。
- Produces:
  - `listSessionsWithGroup(workspaceId): Array<SessionRow & { groupName: string | null }>`（Task 4 IPC `session:list` 数据源）
  - `SessionSummary` 增 `pinnedAt / groupId / groupName / sessionType`（renderer Task 5/7 消费）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/sessions-list-order.test.ts
//
// 排序契约测试（spec 2026-10-22 §4.1）：置顶区（pinned_at DESC）> 分组（position ASC，
// 组内活跃时间 DESC）> 未分组（活跃时间 DESC）。空组不影响排序。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession, touchSessionLastMessage, insertSessionGroup,
  setSessionPinned, setSessionGroup, listSessionsWithGroup,
} from '../../src/main/storage/sessions/repo';
import { getSessionsForWorkspace } from '../../src/main/im/session-ops';

const tmpRoot = path.join(os.tmpdir(), `ap-session-order-${Date.now()}`);
const WS = 'ws-o';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
     VALUES (?, 'ws', '/tmp/ws', 0, 'u1')`,
  ).run(WS);
});
afterEach(() => closeDb());

describe('会话列表排序契约（spec §4.1）', () => {
  it('置顶区 > 分组 > 未分组；置顶区内后置顶在上；组内按活跃时间倒序', () => {
    const gB = insertSessionGroup(WS, 'B'); // position 1024
    const gA = insertSessionGroup(WS, 'A'); // position 2048（建组序 B 先 A 后——组序按 position，A 后建却在下）
    const old = insertSession({ workspaceId: WS, title: '旧', sessionType: 'quick' });
    const fresh = insertSession({ workspaceId: WS, title: '新', sessionType: 'quick' });
    const inB = insertSession({ workspaceId: WS, title: 'inB', sessionType: 'collab' });
    const inA = insertSession({ workspaceId: WS, title: 'inA', sessionType: 'collab' });
    const pinnedOld = insertSession({ workspaceId: WS, title: 'pin旧', sessionType: 'quick' });
    const pinnedNew = insertSession({ workspaceId: WS, title: 'pin新', sessionType: 'quick' });

    setSessionGroup(inB.id, gB.id);
    setSessionGroup(inA.id, gA.id);
    setSessionPinned(pinnedOld.id, true);
    touchSessionLastMessage(fresh.id);  // 未分组两条：fresh 最近活跃在前
    setSessionPinned(pinnedNew.id, true); // 后置顶 → 置顶区更上

    const order = listSessionsWithGroup(WS).map((s) => s.title);
    expect(order).toEqual(['pin新', 'pin旧', 'inB', 'inA', '新', '旧']);
    // 等价验证（时间戳精度兜底）：置顶两条在最前两条之内
    expect(order.slice(0, 2)).toEqual(expect.arrayContaining(['pin新', 'pin旧']));

    // groupName JOIN 带出
    const withGroup = listSessionsWithGroup(WS).find((s) => s.title === 'inB')!;
    expect(withGroup.groupName).toBe('B');
  });

  it('getSessionsForWorkspace summary 含 pinnedAt/groupId/groupName/sessionType', () => {
    const g = insertSessionGroup(WS, 'G');
    const s = insertSession({ workspaceId: WS, title: 't', sessionType: 'collab' });
    setSessionGroup(s.id, g.id);
    setSessionPinned(s.id, true);
    const summary = getSessionsForWorkspace(WS).find((x) => x.id === s.id)!;
    expect(summary.pinnedAt).not.toBeNull();
    expect(summary.groupId).toBe(g.id);
    expect(summary.groupName).toBe('G');
    expect(summary.sessionType).toBe('collab');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/sessions-list-order.test.ts`
Expected: FAIL——`listSessionsWithGroup` 不存在

- [ ] **Step 3: 实现**

`repo.ts` 新增（`listSessionsByWorkspace` 旁）：

```ts
/** 排序契约单点（spec 2026-10-22 §4.1）：置顶区 > 分组 > 未分组 > 活跃时间。 */
const SESSION_ORDER_BY = `
  (s.pinned_at IS NULL) ASC,
  s.pinned_at DESC,
  (g.position IS NULL) ASC,
  g.position ASC,
  g.created_at ASC,
  COALESCE(s.last_message_at, s.created_at) DESC,
  s.created_at DESC`;

export interface SessionWithGroupRow extends SessionRow {
  groupName: string | null;
}

export function listSessionsWithGroup(workspaceId: string): SessionWithGroupRow[] {
  const rows = getDb().prepare(
    `SELECT s.*, g.name AS group_name FROM sessions s
     LEFT JOIN session_groups g ON g.id = s.group_id
     WHERE s.workspace_id = ? ${SESSION_ORDER_BY}`,
  ).all(workspaceId) as Array<SqlRow & { group_name: string | null }>;
  return rows.map((r) => ({ ...rowToCamel(r), groupName: r.group_name }));
}
```

同文件 `listAllSessions` 换同源排序（保返回类型不变）：

```ts
export function listAllSessions(): SessionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.* FROM sessions s
       LEFT JOIN session_groups g ON g.id = s.group_id
       ${SESSION_ORDER_BY}`,
    )
    .all() as SqlRow[];
  return rows.map(rowToCamel);
}
```

`session-ops.ts` 修改：

```ts
// insertSessionWithMembers 入参增 sessionType?: 'quick' | 'collab'，透传 insertSession：
function insertSessionWithMembers(args: {
  workspaceId: string; title: string; titleAuto: boolean;
  kind: SessionRow['kind']; members: MemberWrite[];
  sessionType?: 'quick' | 'collab';
}): SessionRow {
  // ...事务体内 insertSession({...a 既有字段, sessionType: a.sessionType})
}

// createQuickSession：insertSessionWithMembers 增 sessionType: 'quick'
// createCollabSession：增 sessionType: 'collab'（三分支统一，Task 9 加 members 分支同参）

// getSessionsForWorkspace 换数据源并带出新字段：
export function getSessionsForWorkspace(workspaceId?: string): SessionSummary[] {
  const sessions = workspaceId ? listSessionsWithGroup(workspaceId) : listAllSessions();
  return sessions.map((s) => ({
    id: s.id, workspaceId: s.workspaceId, title: s.title, titleAuto: s.titleAuto,
    kind: s.kind, lastMessageAt: s.lastMessageAt,
    pinnedAt: s.pinnedAt, groupId: s.groupId, groupName: s.groupName ?? null,
    sessionType: s.sessionType,
    members: getSessionMembersInfo(s.id),
  }));
}
// SessionSummary 接口同步加四字段（pinnedAt: number | null; groupId: string | null;
// groupName: string | null; sessionType: 'quick' | 'collab' | null）。
// import 列表加 listSessionsWithGroup。
```

`renderer/src/ipc/types.d.ts` 镜像（SessionRow 与 SessionSummary 各加同名字段，中文注释标注 spec 来源；SessionSummary 增 `groupName: string | null`）。

- [ ] **Step 4: 跑测试 + typecheck（Review Focus #5）**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/storage/` ，然后根目录 `npx pnpm@9.0.0 typecheck`
Expected: 全 PASS / typecheck 双 workspace 零错误

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/sessions/repo.ts electron/src/main/im/session-ops.ts renderer/src/ipc/types.d.ts electron/tests/storage/sessions-list-order.test.ts
git commit -m "feat: 会话列表排序契约（置顶>分组>未分组>活跃时间）+ session_type 建会定型 + SessionSummary 四新字段（spec 2026-10-22 §4.1/§3.1）"
```

---

### Task 4: IPC 通道——setPinned / moveToGroup / sessionGroup CRUD（主进程 + preload + types）

**Files:**
- Create: `electron/src/main/im/session-group.ipc.handlers.ts`
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（setPinned / moveToGroup 两通道）
- Modify: `electron/src/main/ipc/index.ts`（注册 registerSessionGroupIpcHandlers）
- Modify: `electron/src/preload/index.ts`（api.session 两方法 + api.sessionGroup 命名空间）
- Modify: `renderer/src/ipc/types.d.ts`（ApiSurface 扩展）
- Test: `electron/tests/im/session-group-ipc.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 repo 函数。
- Produces（renderer 消费）:
  - `ipc.session.setPinned(sessionId: string, pinned: boolean): Promise<void>`
  - `ipc.session.moveToGroup(sessionId: string, groupId: string | null): Promise<void>`
  - `ipc.sessionGroup.list(workspaceId: string): Promise<SessionGroupRow[]>`（types.d.ts 加 `SessionGroupRow` 镜像）
  - `ipc.sessionGroup.create(workspaceId: string, name: string): Promise<SessionGroupRow>`
  - `ipc.sessionGroup.rename(groupId: string, name: string): Promise<void>`
  - `ipc.sessionGroup.delete(groupId: string): Promise<void>`
  - 通道名：`session:setPinned` / `session:moveToGroup` / `sessionGroup:list` / `sessionGroup:create` / `sessionGroup:rename` / `sessionGroup:delete`

- [ ] **Step 1: 写失败测试**（模式照抄 `tests/im/session.ipc.handlers.test.ts` 的 handler 直调范式；若其为 ipcMain 级集成则照抄其 invoke mock——执行者先读该文件选对范式）

```ts
// electron/tests/im/session-group-ipc.test.ts
//
// sessionGroup IPC + session:setPinned/moveToGroup 测试（spec 2026-10-22 §7）。
// 覆盖：建组空名中文报错 / moveToGroup 跨 workspace 组拒绝 / setPinned 落库。
// 范式：照抄 session.ipc.handlers.test.ts 的 DB 初始化与 handler 直调方式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { registerSessionGroupIpcHandlers } from '../../src/main/im/session-group.ipc.handlers';
import { insertSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-session-group-ipc-${Date.now()}`);
const WS = 'ws-i';
const WS2 = 'ws-i2';
type Handler = (e: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  for (const id of [WS, WS2]) {
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
      VALUES (?, ?, '/tmp/ws', 0, 'u1')`).run(id, id);
  }
  handlers.clear();
  registerSessionGroupIpcHandlers((ch: string, h: Handler) => handlers.set(ch, h));
});
afterEach(() => closeDb());

const call = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(undefined, ...args);

describe('sessionGroup IPC', () => {
  it('create 空名/纯空白 → 中文报错', async () => {
    await expect(call('sessionGroup:create', WS, '  ')).rejects.toThrow('分组名不能为空');
  });

  it('create/list/rename/delete 全链路', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string; name: string };
    expect(g.name).toBe('G');
    await call('sessionGroup:rename', g.id, 'G2');
    const list = (await call('sessionGroup:list', WS)) as Array<{ name: string }>;
    expect(list.map((x) => x.name)).toEqual(['G2']);
    await call('sessionGroup:delete', g.id);
    expect(await call('sessionGroup:list', WS)).toEqual([]);
  });

  it('moveToGroup 跨 workspace 组 → 中文报错；setPinned 落库', async () => {
    const g = (await call('sessionGroup:create', WS2, '别家组')) as { id: string };
    const s = insertSession({ workspaceId: WS, title: 't' });
    await expect(call('session:moveToGroup', s.id, g.id)).rejects.toThrow('分组不属于当前会话所在工作空间');
    await call('session:setPinned', s.id, true);
    const row = getDb().prepare('SELECT pinned_at FROM sessions WHERE id = ?').get(s.id) as { pinned_at: number };
    expect(row.pinned_at).not.toBeNull();
  });
});
```

（若 `session.ipc.handlers.ts` 的 setPinned/moveToGroup 不走 session-group.ipc.handlers 的注册器，`session:moveToGroup` 断言按该文件既有测试的直调方式补两行同义断言——执行者以现有范式为准，语义不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/im/session-group-ipc.test.ts`
Expected: FAIL——`session-group.ipc.handlers` 模块不存在

- [ ] **Step 3: 实现**

```ts
// electron/src/main/im/session-group.ipc.handlers.ts
//
// sessionGroup:* IPC（spec 2026-10-22 §7）：会话分组 CRUD。
// 注册器签名与 task/groups.ipc.handlers.ts 的 registerTaskGroupHandlers 对齐。
import { ipcMain } from 'electron';
import {
  listSessionGroups, insertSessionGroup, renameSessionGroup, deleteSessionGroup,
  type SessionGroupRow,
} from '../storage/sessions/repo';
import { getSession, setSessionGroup, setSessionPinned } from '../storage/sessions/repo';

function assertNonEmptyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('分组名不能为空');
  return trimmed;
}

export function registerSessionGroupIpcHandlers(
  register: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown) => void = (ch, h) =>
    ipcMain.handle(ch, h as never),
): void {
  register('sessionGroup:list', (_e, workspaceId: string) => listSessionGroups(workspaceId));
  register('sessionGroup:create', (_e, workspaceId: string, name: string) =>
    insertSessionGroup(workspaceId, assertNonEmptyName(name)));
  register('sessionGroup:rename', (_e, groupId: string, name: string) =>
    renameSessionGroup(groupId, assertNonEmptyName(name)));
  register('sessionGroup:delete', (_e, groupId: string) => {
    deleteSessionGroup(groupId);
  });
  // 置顶/归组语义上属 session 命名空间，通道名按 spec §7（注册在此避免拆两文件）
  register('session:setPinned', (_e, sessionId: string, pinned: boolean) => {
    setSessionPinned(sessionId, pinned);
  });
  register('session:moveToGroup', (_e, sessionId: string, groupId: string | null) => {
    if (groupId !== null) {
      const session = getSession(sessionId);
      const group = listSessionGroups(session?.workspaceId ?? '')
        .find((g: SessionGroupRow) => g.id === groupId);
      if (!group) throw new Error('分组不存在或不属于当前会话所在工作空间');
    }
    setSessionGroup(sessionId, groupId);
  });
}
```

`electron/src/main/ipc/index.ts`：import + `registerSessionGroupIpcHandlers()`（对齐 `registerTaskGroupHandlers` 的接线行）。

`preload/index.ts`（api 对象，对齐既有 invoke 桥接风格）：

```ts
session: {
  // ...既有方法不动，追加：
  setPinned: (sessionId: string, pinned: boolean) => invoke('session:setPinned', sessionId, pinned),
  moveToGroup: (sessionId: string, groupId: string | null) => invoke('session:moveToGroup', sessionId, groupId),
},
sessionGroup: {
  list: (workspaceId: string) => invoke('sessionGroup:list', workspaceId),
  create: (workspaceId: string, name: string) => invoke('sessionGroup:create', workspaceId, name),
  rename: (groupId: string, name: string) => invoke('sessionGroup:rename', groupId, name),
  delete: (groupId: string) => invoke('sessionGroup:delete', groupId),
},
```

`types.d.ts`：ApiSurface 加 `sessionGroup` 段与 session 两方法签名；加 `SessionGroupRow` 镜像接口（与 electron 端同名同构，注释标注两端对齐）。

- [ ] **Step 4: 跑测试 + typecheck + 既有 ipc 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/im/session-group-ipc.test.ts tests/im/session.ipc.handlers.test.ts` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/session-group.ipc.handlers.ts electron/src/main/ipc/index.ts electron/src/main/im/session.ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/im/session-group-ipc.test.ts
git commit -m "feat: session:setPinned/moveToGroup + sessionGroup CRUD IPC 六通道全链路（spec 2026-10-22 §7）"
```

---

### Task 5: session.store——receiveMessage 桶内上浮

**Files:**
- Modify: `renderer/src/stores/session.store.ts`（`receiveMessage` 的上浮块替换）
- Test: `renderer/src/stores/session.store.test.ts`（扩展，不新建）

**Interfaces:**
- Consumes: Task 3 的 `SessionSummary.pinnedAt / groupId`。
- Produces: 行为不变量——置顶会话来消息原地更新；非置顶会话上浮至「同分组桶」顶部，不越置顶区、不越组。

- [ ] **Step 1: 写失败测试**（在 `session.store.test.ts` 追加 describe；mock `ipc.session` 方式照抄该文件既有用例——`vi.mock('../ipc/client')` 范式已在文件内）

```ts
// 追加到 session.store.test.ts（import 区补 type 无需——sessions 直接构造）
describe('receiveMessage 桶内上浮（spec 2026-10-22 §4.2）', () => {
  const mk = (id: string, over: Partial<SessionSummary>): SessionSummary => ({
    id, workspaceId: 'ws', title: id, titleAuto: false, kind: 'chat',
    lastMessageAt: null, members: [], pinnedAt: null, groupId: null,
    groupName: null, sessionType: 'quick', ...over,
  });
  const msg = (sessionId: string, createdAt: number): ImMessage =>
    ({ id: `m-${sessionId}-${createdAt}`, sessionId, sender: 'owner', body: 'x', createdAt, streamSessionId: null }) as unknown as ImMessage;

  it('置顶会话来消息：原地更新 lastMessageAt，位置不动', () => {
    const pinned = mk('pinned', { pinnedAt: 500 });
    const other = mk('other', {});
    const store = useSessionStore.getState();
    useSessionStore.setState({ sessions: [pinned, other] });
    store.receiveMessage(msg('pinned', 999));
    const s = useSessionStore.getState().sessions;
    expect(s.map((x) => x.id)).toEqual(['pinned', 'other']);
    expect(s[0]!.lastMessageAt).toBe(999);
  });

  it('非置顶会话来消息：上浮至同组桶顶，不越置顶区、不越组', () => {
    const pinned = mk('pinned', { pinnedAt: 500 });
    const g1a = mk('g1a', { groupId: 'g1' });
    const g1b = mk('g1b', { groupId: 'g1' });
    const g2a = mk('g2a', { groupId: 'g2' });
    const un1 = mk('un1', {});
    useSessionStore.setState({ sessions: [pinned, g1a, g1b, g2a, un1] });
    useSessionStore.getState().receiveMessage(msg('g1b', 999));
    expect(useSessionStore.getState().sessions.map((x) => x.id))
      .toEqual(['pinned', 'g1b', 'g1a', 'g2a', 'un1']);
  });

  it('未分组会话来消息：上浮至未分组桶顶（分组之后）', () => {
    const g1a = mk('g1a', { groupId: 'g1' });
    const un1 = mk('un1', {});
    const un2 = mk('un2', {});
    useSessionStore.setState({ sessions: [g1a, un1, un2] });
    useSessionStore.getState().receiveMessage(msg('un2', 999));
    expect(useSessionStore.getState().sessions.map((x) => x.id)).toEqual(['g1a', 'un2', 'un1']);
  });

  it('组内唯一会话来消息：保持原位（同组无他人可插队）', () => {
    const g1a = mk('g1a', { groupId: 'g1' });
    const g2a = mk('g2a', { groupId: 'g2' });
    useSessionStore.setState({ sessions: [g1a, g2a] });
    useSessionStore.getState().receiveMessage(msg('g2a', 999));
    expect(useSessionStore.getState().sessions.map((x) => x.id)).toEqual(['g1a', 'g2a']);
  });
});
```

（`ImMessage` 构造字段以该测试文件既有 fixture 为准——照抄其 mkMessage/工厂，勿凭空造字段。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts`
Expected: FAIL——现逻辑把置顶会话也 unshift 到全局顶

- [ ] **Step 3: 实现——替换 receiveMessage 内「只上浮」块**

```ts
// 列表实时性（语义演进 spec 2026-10-22 §4.2）：
//   - 置顶会话：只原地更新 lastMessageAt，不移动（置顶区顺序=置顶时间）
//   - 非置顶会话：桶内上浮——移至「未置顶且同 groupId」首个位置；不越置顶区、不越组
//     （主进程全局序保证同桶连续，findIndex 首个命中即桶头）
const sIdx = state.sessions.findIndex((s) => s.id === msg.sessionId);
if (sIdx === -1) return { messagesBySession: map };
const target = state.sessions[sIdx]!;
const updated = { ...target, lastMessageAt: msg.createdAt };

if (updated.pinnedAt != null) {
  const next = [...state.sessions];
  next[sIdx] = updated;
  return { messagesBySession: map, sessions: next };
}
const rest = state.sessions.filter((s) => s.id !== msg.sessionId);
const bucketHead = rest.findIndex((s) => s.pinnedAt == null && s.groupId === updated.groupId);
// 组内无他人（自己即桶头）：保持原相对位（过滤前 sIdx 映射到过滤后 = sIdx）
const insertAt = bucketHead !== -1 ? bucketHead : Math.min(sIdx, rest.length);
const sessions = [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
return { messagesBySession: map, sessions };
```

（原注释块「2026-09-28：只上浮、禁全量 sort……」保留在新注释上方，注明由 067 排序契约接替。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts`
Expected: 全 PASS（含既有用例——注意既有用例若断言旧上浮行为需同步为新语义，属预期演进非删测试）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/stores/session.store.ts renderer/src/stores/session.store.test.ts
git commit -m "feat: receiveMessage 桶内上浮——置顶原地更新、非置顶不越组不越置顶区（spec 2026-10-22 §4.2）"
```

---

### Task 6: 静态预览 A——会话列表（置顶/分组/类型图标）【P1 门禁】

**Files:**
- Create: `.omo/previews/session-list-groups.html`（gitignored 产物，不 commit）

**Interfaces:** 无代码接口；产出用户批准的视觉定值合同（Task 7 消费）。

- [ ] **Step 1: 制作静态 HTML 预览**（单文件、无构建、内联 CSS；语义 token 色值参照 `docs/dev/design-system.md` 与 renderer Tailwind 配置的实际变量值；形态必须覆盖以下全部状态）
  - 置顶区 2 项（右侧 Pin 10px + title 提示所属分组）+ 分组「项目 A」头（ChevronDown + 名称 + 计数 2 + hover 重命名/删除按钮）+ 组内 2 项 + 分组「项目 B」折叠态（ChevronRight）+ 未分组 3 项
  - 会话项四态图标：Zap（快速）/ Users（协作）/ ListTodo（任务执行）14px tertiary；hover 工具条四钮（Pin/ FolderInput/ Pencil/ Trash2 12px）
  - 类型图标 + Pin 与标题的间距定值；搜索过滤拍平态一屏
  - 「移动到分组」Dialog 形态：分组 radio 列表 + 内联新建输入 + 「未分组」选项
  - 深浅两主题（CSS 变量切换）

- [ ] **Step 2: 交用户批准（gate——未获批准不得进入 Task 7）**

提示用户打开 `.omo/previews/session-list-groups.html` 审阅；记录定值（间距/字号/颜色 token）。用户要求改 → 改完再审。

- [ ] **Step 3: 定值回填本计划**

把批准稿的定值清单（每状态 3-6 条）追加到 Task 7 的「定值合同」小节（手写补入本文件 Task 7 开头）。

---

### Task 7: RoomList——类型图标 / 置顶 / 分组 / 移动弹窗

**Files:**
- Create: `renderer/src/lib/session-type.ts`
- Create: `renderer/src/components/im/MoveToGroupDialog.tsx`
- Modify: `renderer/src/components/im/RoomList.tsx`
- Test: `renderer/src/lib/session-type.test.ts`、`renderer/src/components/im/RoomList.test.tsx`（扩展）、`renderer/src/components/im/MoveToGroupDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 `SessionSummary` 新字段；Task 4 `ipc.session.setPinned/moveToGroup`、`ipc.sessionGroup.*`；Task 6 定值合同。
- Produces: `deriveSessionType(s: SessionSummary): 'quick' | 'collab'`（纯函数，测试锚点）。

**定值合同**（以 Task 6 批准稿为准回填；未回填前禁用 emoji、禁标准色阶、图标 12-14px/1.75）

- [ ] **Step 1: 写失败测试**

`renderer/src/lib/session-type.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { deriveSessionType } from './session-type';

const mk = (over: Partial<Parameters<typeof deriveSessionType>[0]>) => ({
  kind: 'chat' as const, sessionType: null, members: [{}] , ...over,
});

describe('deriveSessionType（spec §3.1 判定顺序）', () => {
  it('kind 优先：task_execution 恒任务', () => {
    expect(deriveSessionType(mk({ kind: 'task_execution' }))).toBe('task_execution');
  });
  it('sessionType 次之；NULL 兜底按成员数推断', () => {
    expect(deriveSessionType(mk({ sessionType: 'collab', members: [{}] }))).toBe('collab');
    expect(deriveSessionType(mk({ sessionType: null, members: [{}, {}] }))).toBe('collab');
    expect(deriveSessionType(mk({ sessionType: null, members: [{}] }))).toBe('quick');
  });
});
```

（`deriveSessionType` 返回 `'quick' | 'collab' | 'task_execution'`——kind 命中时直接返回 kind，RoomList 用它选图标。）

`MoveToGroupDialog.test.tsx`（核心断言）：渲染分组列表 + 「未分组」项；选中既有组提交回调 `(groupId)`；内联输入新名提交回调建组后归组；当前所属组预选。mock `ipc.sessionGroup`（`vi.mock('../../ipc/client')`，范式照抄 `AddAgentDialog.test.tsx`）。

`RoomList.test.tsx` 追加 describe（既有文件已 mock session.store——照抄其 set-up）：
- 分桶渲染顺序：置顶区（无组头）→ 组头「项目 A (2)」+ 组内项 → 未分组项；`data-testid="session-group-header"`
- 类型图标三态：`sessionType:'quick'` → Zap、`'collab'` → Users、`kind:'task_execution'` → ListTodo（断言 `aria-label`「快速会话/协作会话/任务执行会话」）
- 置顶项渲染 Pin 标记 `aria-label="已置顶"`
- 组头点击折叠：组内项消失（mock localStorage）
- 搜索过滤：输入关键词后无组头，匹配项平铺
- hover 工具条四钮 aria-label（置顶或取消置顶/移动到分组/重命名/解散）；点置顶 → `ipc.session.setPinned` 调用 + `refreshSessionList`

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/session-type.test.ts src/components/im/RoomList.test.tsx src/components/im/MoveToGroupDialog.test.tsx`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现**

`renderer/src/lib/session-type.ts`：

```ts
// 会话类型判定（spec 2026-10-22 §3.1）：kind 优先 → sessionType → 成员数兜底（旧库防御）。
import type { SessionSummary } from '../ipc/types';

export type SessionType = 'quick' | 'collab' | 'task_execution';

export function deriveSessionType(s: Pick<SessionSummary, 'kind' | 'sessionType' | 'members'>): SessionType {
  if (s.kind === 'task_execution') return 'task_execution';
  if (s.sessionType) return s.sessionType;
  return s.members.length > 1 ? 'collab' : 'quick';
}
```

`MoveToGroupDialog.tsx`（Dialog + radio 列表 + 内联新建 + 未分组选项；提交调 `ipc.session.moveToGroup` 后 `refreshSessionList` + onClose）：

```tsx
// renderer/src/components/im/MoveToGroupDialog.tsx
// 「移动到分组」弹窗（spec 2026-10-22 §4.4）：分组 radio（含「未分组」）+ 内联新建分组。
// 提交：新建模式先 sessionGroup.create 再 moveToGroup；成功后 refreshSessionList。
import { useEffect, useState, type FormEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import type { SessionGroupRow, SessionSummary } from '../../ipc/types';

interface Props {
  session: SessionSummary;
  workspaceId: string;
  onClose: () => void;
}

const UNGROUPED = '__ungrouped__';

export function MoveToGroupDialog({ session, workspaceId, onClose }: Props) {
  const refreshSessionList = useSessionStore((s) => s.refreshSessionList);
  const [groups, setGroups] = useState<SessionGroupRow[]>([]);
  const [selected, setSelected] = useState<string>(session.groupId ?? UNGROUPED);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.sessionGroup.list(workspaceId).then(setGroups).catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let target = selected === UNGROUPED ? null : selected;
      const name = newName.trim();
      if (name !== '') {
        const created = await ipc.sessionGroup.create(workspaceId, name);
        target = created.id;
      }
      await ipc.session.moveToGroup(session.id, target);
      refreshSessionList();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`移动「${session.title}」到分组`} width={360}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1.5">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3">
              <input type="radio" name="move-group" checked={selected === g.id && newName === ''} onChange={() => { setSelected(g.id); setNewName(''); }} />
              <span>{g.name}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3">
            <input type="radio" name="move-group" checked={selected === UNGROUPED && newName === ''} onChange={() => { setSelected(UNGROUPED); setNewName(''); }} />
            <span>未分组</span>
          </label>
        </fieldset>
        <div className="border-t border-subtle pt-2 flex items-center gap-2">
          <FolderPlus size={14} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="或新建分组（优先于上方选择）" />
        </div>
        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={busy}>{busy ? '移动中…' : '移动'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
```

（`cn` 未用到则删 import——以 lint 为准。）

`RoomList.tsx` 改造（保留搜索/重命名/解散既有逻辑；新增分桶渲染 + 工具条扩两钮 + FolderPlus 建组 + 折叠持久化）。核心结构：

```tsx
// 新增 import：Zap, Users, ListTodo, Pin, PinOff, FolderInput, FolderPlus, ChevronDown, ChevronRight
// 状态：groups（ipc.sessionGroup.list，workspace 变更时加载）、collapsedIds: Set<string>
// （localStorage 键 momo.sessionGroups.collapsed.<wsId>）、moving: SessionSummary | null、
// creatingGroup: boolean（PromptDialog 复用）、renamingGroup / deletingGroup 同法。

const TYPE_ICON: Record<SessionType, { Icon: typeof Zap; label: string }> = {
  quick: { Icon: Zap, label: '快速会话' },
  collab: { Icon: Users, label: '协作会话' },
  task_execution: { Icon: ListTodo, label: '任务执行会话' },
};

// 非过滤态分桶（sessions 已是主进程全局序；组序来自 groups position，空组也渲染组头）：
const pinned = visibleSessions.filter((s) => s.pinnedAt != null);
const unpinned = visibleSessions.filter((s) => s.pinnedAt == null);
const byGroup = new Map<string, SessionSummary[]>();
for (const g of groups) byGroup.set(g.id, []);
const ungrouped: SessionSummary[] = [];
for (const s of unpinned) {
  if (s.groupId && byGroup.has(s.groupId)) byGroup.get(s.groupId)!.push(s);
  else ungrouped.push(s);
}

// 渲染（过滤态 q !== '' 时走现有平铺 map，仅加类型图标 + Pin）：
// 1) pinned.map(项)——项 = <SessionItem>（无组头）
// 2) groups.map(g => <GroupSection group={g} sessions={byGroup.get(g.id)!} …/>)——折叠时只渲染组头
// 3) ungrouped.map(项)
```

`SessionItem`（组件内函数或同文件独立函数）：现有按钮结构 + 标题左侧类型图标（`const { Icon, label } = TYPE_ICON[deriveSessionType(session)]`，14px/1.75/text-tertiary，`aria-label={label}`）+ 标题右侧 `session.pinnedAt != null && <Pin size={10} … aria-label="已置顶" title={session.groupName ? `分组：${session.groupName}` : '已置顶'} />`；hover 工具条四钮：

```tsx
<button type="button" title={session.pinnedAt != null ? '取消置顶' : '置顶'} aria-label={session.pinnedAt != null ? '取消置顶' : '置顶'}
  onClick={(e) => { e.stopPropagation(); void ipc.session.setPinned(session.id, session.pinnedAt == null).then(() => refreshSessionList()); }}
  className="text-tertiary hover:text-primary">
  {session.pinnedAt != null ? <PinOff size={12} strokeWidth={1.75} aria-hidden /> : <Pin size={12} strokeWidth={1.75} aria-hidden />}
</button>
<button type="button" title="移动到分组" aria-label="移动到分组"
  onClick={(e) => { e.stopPropagation(); setMoving(session); }}
  className="text-tertiary hover:text-primary">
  <FolderInput size={12} strokeWidth={1.75} aria-hidden />
</button>
{/* 既有 Pencil / Trash2 两钮原样保留 */}
```

`GroupSection` 组头（chevron 折叠 + 名称 + `(n)` + hover Pencil/Trash2；重命名走 PromptDialog → `ipc.sessionGroup.rename`；删除走 ConfirmDialog（文案「只删除分组，组内 N 个会话将回到未分组」）→ `ipc.sessionGroup.delete` → 两者后 `refreshSessionList` + 重拉 groups）；折叠态写 localStorage。搜索框旁 `FolderPlus` 按钮开 PromptDialog → `ipc.sessionGroup.create` → 重拉 groups。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/session-type.test.ts src/components/im/RoomList.test.tsx src/components/im/MoveToGroupDialog.test.tsx src/stores/session.store.test.ts` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/session-type.ts renderer/src/components/im/MoveToGroupDialog.tsx renderer/src/components/im/RoomList.tsx renderer/src/lib/session-type.test.ts renderer/src/components/im/RoomList.test.tsx renderer/src/components/im/MoveToGroupDialog.test.tsx
git commit -m "feat: 会话列表类型图标/全局置顶/手动分组/移动分组弹窗（spec 2026-10-22 §4，预览 A 批准定值）"
```

---

### Task 8: session-tools 输出补 [type] + P5 导出路径核对

**Files:**
- Modify: `electron/src/main/agent/tools/session-tools.ts`（`executeListSessions` 输出行）
- Test: `electron/tests/agent/tools/session-tools.test.ts`（扩展）

**Interfaces:** 无新接口；LLM 可读输出行从 `[chat]` 变为 `[chat/quick]` / `[chat/collab]` / `[task_execution]`。

- [ ] **Step 1: 写失败测试**（在该文件既有 executeListSessions 直调用例旁追加；DB 夹具照抄同文件）

```ts
it('list_sessions 输出行带会话类型：chat/quick、chat/collab、task_execution（spec §8 消费面）', async () => {
  // 夹具：一个 sessionType='quick'、一个 'collab'、一个 kind='task_execution'
  // （insertSession + sessionType 参数；task 行 kind='task_execution'）
  const out = await executeListSessions({}, mkCtx(WS));
  expect(out).toContain('[chat/quick]');
  expect(out).toContain('[chat/collab]');
  expect(out).toContain('[task_execution]');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/agent/tools/session-tools.test.ts`
Expected: FAIL——输出行只有 `[chat]`

- [ ] **Step 3: 实现**（`executeListSessions` 行构造处；`s.sessionType` 现已在 SessionRow 上）

```ts
const typeTag = s.kind === 'chat' ? `chat/${s.sessionType ?? (listSessionMembers(s.id).length > 1 ? 'collab' : 'quick')}` : s.kind;
lines.push(
  `- id=${s.id} 《${s.title}》 [${typeTag}] 活跃=${formatTs(s.lastMessageAt ?? s.createdAt)} 消息数=${countMessagesBySession(s.id)}`,
  // ……第二行不动
);
```

（`members` 变量已在该循环内求值——若其先于行构造，直接复用长度，勿二次查询。）

- [ ] **Step 4: P5 导出路径核对（消费面矩阵 §8）**

Run: `grep -rn "FROM sessions" electron/src/main --include="*.ts" | grep -iv repo`
检查导出/只读导出模块是否显式列名 SELECT（是 → 新列零影响）或 SELECT *（确认导出 JSON 序列化不会因新列崩溃——新列均可空、标量，无风险；若导出有字段白名单，把 `pinned_at/group_id/session_type` 加入会话导出行）。把核对结论写进 commit body。

- [ ] **Step 5: 跑测试 + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/agent/tools/session-tools.test.ts`
Expected: PASS

```bash
git add electron/src/main/agent/tools/session-tools.ts electron/tests/agent/tools/session-tools.test.ts
git commit -m "feat: list_sessions 输出行带会话类型标签 + P5 导出路径新列核对（spec 2026-10-22 §8）"
```

---

# Phase 2：多选建会（#4）

### Task 9: CollabTarget 第三态 members——主进程校验与写入 + 两端契约

**Files:**
- Modify: `electron/src/main/im/session-ops.ts`（`CollabTarget` 联合 + `createCollabSession` members 分支）
- Modify: `renderer/src/ipc/types.d.ts`（`CollabTarget` 镜像扩展）
- Test: `electron/tests/im/collab-members-target.test.ts`

**Interfaces:**
- Consumes: Task 2 `insertSession.sessionType`、Task 3 `insertSessionWithMembers.sessionType`。
- Produces:
  - `CollabTarget = { type: 'agent'; instanceId: string } | { type: 'team'; teamId: string } | { type: 'members'; instanceIds: string[]; leaderInstanceId: string }`（Task 11 消费）
  - 校验错误文案（测试锚点）：`会话目标不能为空：请至少选择一个 agent` / `主 agent 必须是所选成员之一` / `成员不存在或不属于当前工作空间：<instanceId>`

- [ ] **Step 1: 写失败测试**（DB 夹具照抄 `session-ops.test.ts`：workspaces + agent_definitions + workspace_agent_members 两成员）

```ts
// electron/tests/im/collab-members-target.test.ts
// members 三态测试（spec 2026-10-22 §5.2）：leader 落库 / 三个非法输入中文错误 /
// session_type='collab' / 去重容错 / 'agent'|'team' 旧形态回归。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createCollabSession } from '../../src/main/im/session-ops';
import { getSession, listSessionMembers } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-collab-members-${Date.now()}`);
const WS = 'ws-c';
const INST_A = 'inst-a';
const INST_B = 'inst-b';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
    VALUES (?, 'ws', '/tmp/ws', 0, 'u1')`).run(WS);
  for (const [i, defId] of ['def-a', 'def-b'].entries()) {
    db.prepare(`INSERT INTO agent_definitions
      (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven, created_at)
      VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', NULL, 'm', 1, ?)`)
      .run(defId, `d${i}`, `d-${i}`, Date.now());
    db.prepare(`INSERT INTO workspace_agent_members
      (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override, last_running, created_at)
      VALUES (?, ?, ?, ?, 0, 0, 1)`)
      .run(i === 0 ? INST_A : INST_B, WS, defId, `au-${i}`);
  }
});
afterEach(() => closeDb());

describe('createCollabSession members 形态（spec §5.2）', () => {
  it('多成员：leader 落 is_leader=1 其余 0；session_type=collab；重复 id 静默去重', () => {
    const s = createCollabSession(WS, null, { type: 'members', instanceIds: [INST_A, INST_B, INST_A], leaderInstanceId: INST_B });
    const members = listSessionMembers(s.id);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.instanceId === INST_B)!.isLeader).toBe(true);
    expect(members.find((m) => m.instanceId === INST_A)!.isLeader).toBe(false);
    expect(getSession(s.id)!.sessionType).toBe('collab');
  });

  it('单成员：等价旧 agent 形态（唯一成员即 leader）', () => {
    const s = createCollabSession(WS, null, { type: 'members', instanceIds: [INST_A], leaderInstanceId: INST_A });
    expect(listSessionMembers(s.id)).toHaveLength(1);
    expect(listSessionMembers(s.id)[0]!.isLeader).toBe(true);
  });

  it('非法输入三连（Review Focus #3）：空 / leader 越集 / 跨 ws 成员 → 中文错误', () => {
    expect(() => createCollabSession(WS, null, { type: 'members', instanceIds: [], leaderInstanceId: INST_A }))
      .toThrow('会话目标不能为空：请至少选择一个 agent');
    expect(() => createCollabSession(WS, null, { type: 'members', instanceIds: [INST_A], leaderInstanceId: INST_B }))
      .toThrow('主 agent 必须是所选成员之一');
    expect(() => createCollabSession(WS, null, { type: 'members', instanceIds: [INST_A, 'inst-x'], leaderInstanceId: INST_A }))
      .toThrow('成员不存在或不属于当前工作空间：inst-x');
  });

  it('旧形态回归：agent 单选 / team 快照仍可用且 session_type=collab', () => {
    const a = createCollabSession(WS, null, { type: 'agent', instanceId: INST_A });
    expect(getSession(a.id)!.sessionType).toBe('collab');
    expect(listSessionMembers(a.id)[0]!.isLeader).toBe(true);
  });
});
```

（team 分支回归需 teams 夹具——若既有 `session-ops.test.ts` 已覆盖 team 展开，此处只留一行注释指向既有用例即可，勿重复造夹具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/im/collab-members-target.test.ts`
Expected: FAIL——target.type 不含 'members'（编译错或运行时走 team 分支报团队不存在）

- [ ] **Step 3: 实现**（`session-ops.ts`）

```ts
/** 协作会话目标（spec §4.4 + 2026-10-22 §5.1）：单 agent / 团队 / 建会临时组队。 */
export type CollabTarget =
  | { type: 'agent'; instanceId: string }
  | { type: 'team'; teamId: string }
  | { type: 'members'; instanceIds: string[]; leaderInstanceId: string };

// createCollabSession 成员解析改为三分支：
let members: MemberWrite[];
if (target.type === 'agent') {
  members = [{ instanceId: target.instanceId, isLeader: true }];
} else if (target.type === 'members') {
  const ids = [...new Set(target.instanceIds)];
  if (ids.length === 0) throw new Error('会话目标不能为空：请至少选择一个 agent');
  if (!ids.includes(target.leaderInstanceId)) throw new Error('主 agent 必须是所选成员之一');
  const validIds = new Set(listMembers(workspaceId).map((m) => m.instanceId));
  const invalid = ids.find((id) => !validIds.has(id));
  if (invalid !== undefined) throw new Error(`成员不存在或不属于当前工作空间：${invalid}`);
  members = ids.map((id) => ({ instanceId: id, isLeader: id === target.leaderInstanceId }));
} else {
  // 既有 team 分支原样（listTeams 校验 + 快照展开）
  …
}
// insertSessionWithMembers 调用增 sessionType: 'collab'
//（import 区补 listMembers——from '../agent/agent-queries'，断环先例见该文件头注）
```

`types.d.ts`：`CollabTarget` 同步三分支（renderer 镜像，注释标 spec §5.1）。

- [ ] **Step 4: 跑测试 + typecheck + session-ops 既有回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/im/` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/session-ops.ts renderer/src/ipc/types.d.ts electron/tests/im/collab-members-target.test.ts
git commit -m "feat: CollabTarget 增 members 第三态——建会临时组队 + 主 agent 校验落库（spec 2026-10-22 §5）"
```

---

### Task 10: 静态预览 B——选择器卡片 + 多选/主 agent 交互形态【P1 门禁】

**Files:**
- Create: `.omo/previews/agent-picker-cards.html`（不 commit）

**Interfaces:** 产出 Task 11（多选行）与 Task 13（AgentPickerCard）的视觉定值合同。

- [ ] **Step 1: 制作静态 HTML 预览**，必须覆盖：
  - 卡片行：icon + 名称 + 描述两行截断（空 → 「暂无说明」斜体占位）+ 能力徽标行（Wrench n / Server n / Sparkles n，0 不渲染）+ 在线态徽标
  - 多选态（CollabSessionDialog agent 页签）：checkbox 勾选行、勾选 >1 时行尾 Crown 钮（唯一 accent 高亮）、单选 1 个无 Crown
  - 徽标点击展开：三区 chip（内置工具 / MCP 服务器 / 技能）+ denied 灰显删除线示例 + 再点收起
  - 团队页签行（Crown + 成员数）与 notJoined 区（「+ 加入」）
  - 深浅两主题

- [ ] **Step 2: 交用户批准（gate——未获批准不得进入 Task 11/13）**

- [ ] **Step 3: 定值回填 Task 11 / Task 13 开头（手写补入本文件）**

---

### Task 11: CollabSessionDialog——多选 + Crown 主 agent

**Files:**
- Modify: `renderer/src/components/im/CollabSessionDialog.tsx`
- Test: `renderer/src/components/im/CollabSessionDialog.test.tsx`（新建——该组件目前无测试）

**Interfaces:**
- Consumes: Task 9 `CollabTarget` members 形态；Task 10 定值。
- Produces: 提交 payload 恒 `{ type: 'members', instanceIds, leaderInstanceId }`（单选亦然）。

**定值合同**（以 Task 10 批准稿回填）

- [ ] **Step 1: 写失败测试**（mock `../ipc/client` + agent.store/session.store/workspace.store/ui.store——范式照抄 `AddAgentDialog.test.tsx` 的 store mock 方式）

```tsx
// 核心用例（4 个）：
// 1. 勾选两个成员 → 每个已选行出现 Crown 钮；默认第一个选中者高亮
// 2. 点击第二个成员 Crown → 高亮唯一切换
// 3. 取消选中当前 leader（第二个）→ leader 回落到剩余首个（Review Focus：不变量）
// 4. 提交 → createCollabSession 以 { type:'members', instanceIds:[a,b], leaderInstanceId:b } 调用
// 断言锚点：data-testid="leader-crown-<instanceId>"（高亮态 aria-pressed=true）
```

（具体渲染断言按组件实际 DOM 写；测试数据两成员：`{ instanceId: 'ia', agentName: 'A', iconEmoji: '', lastRunning: true, agentDefinitionId: 'da', workspaceId: WS, agentUserId: 'aua', hasApiKeyOverride: false, createdAt: 1 }` 同构 B。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CollabSessionDialog.test.tsx`
Expected: FAIL——组件仍是 radio 单选

- [ ] **Step 3: 实现**（agent 页签改造；团队页签与 notJoined 区不动）

```tsx
// 状态替换：const [target, setTarget] = useState<CollabTarget | null>(null) 改为
const [selectedIds, setSelectedIds] = useState<string[]>([]);       // 勾选序
const [leaderId, setLeaderId] = useState<string | null>(null);      // 主 agent

const toggle = (id: string): void => {
  setSelectedIds((prev) => {
    if (prev.includes(id)) {
      const next = prev.filter((x) => x !== id);
      // 取消的是当前 leader → 回落剩余首个（spec §5.3 不变量）
      if (leaderId === id) setLeaderId(next[0] ?? null);
      return next;
    }
    setLeaderId((cur) => cur ?? id); // 首个选中默认 leader
    return [...prev, id];
  });
};

// handleSubmit 目标构造（替换 target 判空）：
if (selectedIds.length === 0 || leaderId === null) { setError('请选择会话成员'); return; }
const target: CollabTarget = { type: 'members', instanceIds: selectedIds, leaderInstanceId: leaderId };

// 成员行：radio → checkbox；选中 >1 时行尾 Crown 按钮：
<input type="checkbox" checked={selectedIds.includes(m.instanceId)} onChange={() => toggle(m.instanceId)} />
…
{selectedIds.length > 1 && selectedIds.includes(m.instanceId) && (
  <button type="button" data-testid={`leader-crown-${m.instanceId}`} aria-pressed={leaderId === m.instanceId}
    title="主 agent：接待用户输入与任务分派"
    onClick={(e) => { e.preventDefault(); setLeaderId(m.instanceId); }}
    className={cn('shrink-0', leaderId === m.instanceId ? 'text-accent-500' : 'text-tertiary hover:text-primary')}>
    <Crown size={12} strokeWidth={1.75} aria-hidden />
  </button>
)}
// switchTab 切页签时 setSelectedIds([]) + setLeaderId(null)（原 setTarget(null) 语义）
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CollabSessionDialog.test.tsx` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/CollabSessionDialog.tsx renderer/src/components/im/CollabSessionDialog.test.tsx
git commit -m "feat: 协作会话创建多选 agent + Crown 主 agent 指定（spec 2026-10-22 §5.3，预览 B 批准）"
```

---

# Phase 3：agent 描述与能力展示（#5 #6）

### Task 12: agent:getEffectiveCapabilities——与 spawn 同源能力合并 IPC

**Files:**
- Create: `electron/src/main/agent/effective-capabilities.ts`
- Modify: `electron/src/main/agent/agent-queries.ts`（加 `getMemberByInstanceId`）
- Modify: `electron/src/main/agent/ipc.handlers.ts`（注册 `agent:getEffectiveCapabilities`）
- Modify: `electron/src/preload/index.ts` + `renderer/src/ipc/types.d.ts`
- Test: `electron/tests/agent/effective-capabilities.test.ts`

**Interfaces:**
- Consumes: `mergeCapabilities / readAllocationLayer / readAssignmentDeltas`（capability-merger.ts 既有导出）。
- Produces:
  - `ipc.agent.getEffectiveCapabilities(instanceIds: string[]): Promise<Record<string, { tools: string[]; mcps: string[]; skills: string[]; deniedTools: string[] }>>`
  - 未知 instanceId：返回 Map 中**省略**该条目（Task 13 renderer 降级消费）

- [ ] **Step 1: 写失败测试**（DB 夹具照抄 `capability-merger-layer3.test.ts` 的 def/allocation/deltas 构造——先读该文件）

```ts
// electron/tests/agent/effective-capabilities.test.ts
// 三层合并同源测试（spec §6.1）：def ∪ allocation ± deltas 产物与 mergeCapabilities
// 直调一致；批量多成员；未知 instanceId 条目省略。
// 核心断言：
const caps = getEffectiveCapabilities([INST_A, 'inst-unknown']);
expect(caps['inst-unknown']).toBeUndefined();
expect(caps[INST_A]!.tools).toEqual(mergeCapabilities(defA, allocationA, deltasA).tools);
//（defA/allocationA/deltasA 用与本测试相同夹具分别构造——同源即逐字段相等）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/agent/effective-capabilities.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现**

`agent-queries.ts` 追加：

```ts
/** 按 instance_id 取单个成员（跨 workspace；effective-capabilities 消费）。 */
export function getMemberByInstanceId(instanceId: string): WorkspaceAgentMember | null {
  const row = getDb().prepare(
    `SELECT wam.*, d.name, d.icon_emoji FROM workspace_agent_members wam
     JOIN agent_definitions d ON d.id = wam.agent_definition_id
     WHERE wam.instance_id = ?`,
  ).get(instanceId) as WorkspaceMemberRow | undefined;
  return row ? rowToMember(row) : null;
}
```

`effective-capabilities.ts`：

```ts
// electron/src/main/agent/effective-capabilities.ts
// 成员生效能力批量查询（spec 2026-10-22 §6.1）：与 spawn 同源 mergeCapabilities
// （Layer1 def ∪ Layer2 allocation ± Layer3 deltas）——展示=实际能用，合并单点不漂移。
import { getAgentDefinition, getMemberByInstanceId } from './agent-queries';
import {
  mergeCapabilities, readAllocationLayer, readAssignmentDeltas, type MergedCapabilities,
} from './capability-merger';

export function getEffectiveCapabilities(instanceIds: string[]): Record<string, MergedCapabilities> {
  const out: Record<string, MergedCapabilities> = {};
  for (const id of instanceIds) {
    const member = getMemberByInstanceId(id);
    if (!member) continue; // 未知/已移出成员：条目省略，renderer 降级 def 级徽标
    const def = getAgentDefinition(member.agentDefinitionId);
    if (!def) continue;
    out[id] = mergeCapabilities(def, readAllocationLayer(member.workspaceId), readAssignmentDeltas(id));
  }
  return out;
}
```

`ipc.handlers.ts`（registerAgentHandlers 内，对齐既有 `agent:getMemberDeltas` 接线行）：

```ts
ipcMain.handle('agent:getEffectiveCapabilities', (_e, instanceIds: string[]) =>
  getEffectiveCapabilities(instanceIds));
```

preload `api.agent` 追加 `getEffectiveCapabilities: (instanceIds: string[]) => invoke('agent:getEffectiveCapabilities', instanceIds)`；types.d.ts 加签名与返回类型 `Record<string, EffectiveCapabilities>`（types.d.ts 定义镜像 `interface EffectiveCapabilities { tools: string[]; mcps: string[]; skills: string[]; deniedTools: string[] }`，注释标注与 electron `MergedCapabilities` 对齐）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/agent/effective-capabilities.test.ts` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/effective-capabilities.ts electron/src/main/agent/agent-queries.ts electron/src/main/agent/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/agent/effective-capabilities.test.ts
git commit -m "feat: agent:getEffectiveCapabilities 批量生效能力查询——与 spawn 同源三层合并（spec 2026-10-22 §6.1）"
```

---

### Task 13: AgentPickerCard 共享组件 + 三弹窗接入（描述 + 能力徽标 + 展开）

**Files:**
- Create: `renderer/src/components/agent/AgentPickerCard.tsx`
- Modify: `renderer/src/components/im/CollabSessionDialog.tsx`、`renderer/src/components/im/DefaultAgentPickerDialog.tsx`、`renderer/src/components/agent/AddAgentDialog.tsx`
- Test: `renderer/src/components/agent/AgentPickerCard.test.tsx`、`renderer/src/components/agent/AddAgentDialog.test.tsx`（扩展）、`renderer/src/components/im/DefaultAgentPickerDialog.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 12 `ipc.agent.getEffectiveCapabilities`；`capability-helpers.deniedMatch`（既有导出，denied 灰显判定）。
- Produces:

```ts
export interface AgentPickerCardProps {
  name: string;
  iconEmoji?: string;
  description?: string;
  /** 生效能力（IPC 产物或 def 级降级）；undefined = 无徽标行（数据未就绪） */
  capabilities?: { tools: string[]; mcps: string[]; skills: string[]; deniedTools: string[] };
  selected?: boolean;
  onToggle?: () => void;
  /** Crown 主 agent 控制（CollabSessionDialog 多选 >1 时启用） */
  leader?: boolean;
  onSetLeader?: () => void;
  /** 右侧元信息插槽（在线态 / source 徽标 / 加入按钮） */
  trailing?: ReactNode;
}
```

**定值合同**（Task 10 批准稿回填；描述两行截断对齐 MembersPanel 卡片合同 `line-clamp-2` + 空「暂无说明」斜体占位 + 整行 title 全文）

- [ ] **Step 1: 写失败测试**

`AgentPickerCard.test.tsx` 核心 6 断言：
1. 描述两行截断渲染 + title 全文；空描述 → 「暂无说明」占位
2. 徽标：`Wrench 2` / `Server 1` / `Sparkles 3` 计数正确；**计数 0 分类不渲染**（`queryByTitle('MCP 服务器')` 为 null）
3. deniedTools 命中的 plugin 工具不计入徽标计数（deniedMatch 语义）
4. 点击徽标行 → 展开三区 chip（工具名/MCP 名/技能名）；denied 命中项带删除线类；再点收起
5. selected/onToggle 勾选态；leader=true 时 Crown `aria-pressed=true`
6. trailing 插槽内容渲染在行尾

`AddAgentDialog.test.tsx` 追加：def 行渲染徽标（def 级计数——def.defaultTools 长度，title 含「默认能力」）。
`DefaultAgentPickerDialog.test.tsx` 新建：成员行显示描述 + 徽标（mock getEffectiveCapabilities 返回固定桶）；单成员自动预选既有行为回归。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/AgentPickerCard.test.tsx`
Expected: FAIL——组件不存在

- [ ] **Step 3: 实现 AgentPickerCard**

```tsx
// renderer/src/components/agent/AgentPickerCard.tsx
// 选择器统一卡片行（spec 2026-10-22 §6.2/§6.3）：描述两行截断 + 能力摘要徽标
// （0 不渲染）+ 原地展开三区 chip（denied 灰显删除线）+ Crown/勾选/尾插槽。
import { useState, type ReactNode } from 'react';
import { Crown, Server, Sparkles, Wrench } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { cn } from '../../lib/cn';
import { deniedMatch } from '../../lib/capability-helpers';

export function AgentPickerCard(props: AgentPickerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const desc = props.description?.trim();
  // 生效集：tools 剔除 denied 命中（deniedMatch 语义：精确名或 plugin:<id>/* 组模式）
  const denied = props.capabilities?.deniedTools ?? [];
  const tools = (props.capabilities?.tools ?? []).filter((t) => !deniedMatch(t, denied));
  const mcps = props.capabilities?.mcps ?? [];
  const skills = props.capabilities?.skills ?? [];
  const badges = [
    { Icon: Wrench, n: tools.length, label: '内置工具', title: '内置工具' },
    { Icon: Server, n: mcps.length, label: 'MCP 服务器', title: 'MCP 服务器' },
    { Icon: Sparkles, n: skills.length, label: '技能', title: '技能' },
  ].filter((b) => b.n > 0);

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 px-2.5 py-2 transition-colors hover:bg-surface-3">
      <div className="flex items-center gap-2">
        {props.onToggle ? (
          <input type="checkbox" checked={props.selected ?? false} onChange={props.onToggle} aria-label={props.name} />
        ) : null}
        <span className="shrink-0">{props.iconEmoji || <Avatar name={props.name} bot size="sm" />}</span>
        <span className="truncate text-sm text-primary" title={desc || undefined}>{props.name}</span>
        {props.leader !== undefined && props.onSetLeader && (
          <button type="button" data-testid={`leader-crown-${props.name}`} aria-pressed={props.leader}
            title="主 agent：接待用户输入与任务分派" onClick={props.onSetLeader}
            className={cn('shrink-0', props.leader ? 'text-accent-500' : 'text-tertiary hover:text-primary')}>
            <Crown size={12} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {props.trailing}
      </div>
      <p className="mt-1 line-clamp-2 min-h-[33px] text-xs leading-[1.55] text-secondary">
        {desc ? desc : <span className="italic text-tertiary">暂无说明</span>}
      </p>
      {props.capabilities && (
        <>
          <button type="button" className="mt-1 flex items-center gap-1.5" onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded} aria-label="能力清单展开切换">
            {badges.map((b) => (
              <span key={b.title} title={b.title} className="inline-flex items-center gap-0.5 rounded bg-surface-3 px-1.5 py-px text-[11px] text-secondary">
                <b.Icon size={11} strokeWidth={1.75} aria-hidden />{b.n}
              </span>
            ))}
          </button>
          {expanded && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {([['内置工具', tools], ['MCP 服务器', mcps], ['技能', skills]] as const).map(([label, list]) =>
                list.length === 0 ? null : (
                  <div key={label} className="flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-tertiary w-16 shrink-0">{label}</span>
                    {list.map((n) => (
                      <span key={n} className={cn('rounded bg-surface-2 px-1.5 py-px text-[11px] text-secondary',
                        deniedMatch(n, denied) && 'line-through opacity-50')}>{n}</span>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

（`AgentPickerCardProps` 见上方 Interfaces。）

三弹窗接入：
- **CollabSessionDialog**：成员行换 `<AgentPickerCard name={memberLabel(m)} iconEmoji={m.iconEmoji} description={defMap 取描述} capabilities={capsByInstance[m.instanceId]} selected onToggle={() => toggle(m.instanceId)} leader={leaderId === m.instanceId} onSetLeader={() => setLeaderId(m.instanceId)} trailing={在线态徽标} />`；`useEffect` 打开时批量 `ipc.agent.getEffectiveCapabilities(members.map((m) => m.instanceId))` 存 `Record` state；notJoined def 行用 def 级 `capabilities={{ tools: d.defaultTools.map((t) => t.ref), mcps: d.defaultMcps.map((x) => x.ref), skills: d.defaultSkills.map((x) => x.ref), deniedTools: d.deniedTools ?? [] }}`（title 语义由徽标 tooltip 承担）。defMap 由 `definitions`（已加载）按 `agentDefinitionId` 建——WorkspaceAgentMember 无 description，描述取 def。
- **DefaultAgentPickerDialog**：radio 行换 AgentPickerCard（无 onToggle → 不渲染 checkbox；selected 视觉以 Border accent 表达，点击行 setSelectedId）；同样批量拉 capabilities。
- **AddAgentDialog**：def 行换 AgentPickerCard（trailing = source 徽标 + 加入按钮；capabilities 用 def 级降级，同上）；描述从单行 truncate 统一为组件两行合同。

- [ ] **Step 4: 跑全部相关测试 + typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/AgentPickerCard.test.tsx src/components/agent/AddAgentDialog.test.tsx src/components/im/DefaultAgentPickerDialog.test.tsx src/components/im/CollabSessionDialog.test.tsx` ；根目录 `npx pnpm@9.0.0 typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/agent/AgentPickerCard.tsx renderer/src/components/agent/AgentPickerCard.test.tsx renderer/src/components/im/CollabSessionDialog.tsx renderer/src/components/im/DefaultAgentPickerDialog.tsx renderer/src/components/agent/AddAgentDialog.tsx renderer/src/components/im/DefaultAgentPickerDialog.test.tsx renderer/src/components/agent/AddAgentDialog.test.tsx
git commit -m "feat: AgentPickerCard 统一选择器卡片——描述直出 + 能力徽标 + 展开三区 + 三弹窗接入（spec 2026-10-22 §6，预览 B 批准）"
```

---

### Task 14: 收尾——全量回归 + 版本 alpha +1 + spec 状态更新

**Files:**
- Modify: 根 / electron / renderer 三处 `package.json`（alpha +1，如 `2.1.0-alpha.24` → `2.1.0-alpha.25`）

**Interfaces:** 无。

- [ ] **Step 1: 全量测试**

Run: `nvm use 24 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 双 workspace 全 PASS（vitest 异常退出后按 AGENTS.md 检查清理孤儿 worker）

- [ ] **Step 2: App 级验收（momo-acceptance skill）**

按 `.opencode/skills/momo-acceptance` 流程起隔离实例走查：建组/置顶/移动/多选建会/徽标展开六条主路径，产出 `.omo/qa-reports/` 报告。发现问题回对应 Task 修复（不扩大范围）。

- [ ] **Step 3: alpha +1 + spec 状态行更新**

三处 `package.json` alpha 号 +1；`docs/specs/2026-10-22-session-ux-enhancements-design.md` 状态行改「已实施」。

- [ ] **Step 4: Commit**

```bash
git add package.json electron/package.json renderer/package.json docs/specs/2026-10-22-session-ux-enhancements-design.md
git commit -m "chore: 合入会话体验优化大特性 alpha 号 +1（spec 2026-10-22 已实施）"
```

---

## 自审记录（writing-plans Self-Review）

1. **Spec coverage**：spec §3→Task 1/2/3；§4.1→Task 2/3；§4.2→Task 5；§4.3/4.4/4.5→Task 7；§5→Task 9/11；§6→Task 12/13；§7→Task 4/9/12；§8→Task 8/14；§9 分布各任务 Step；§10 分期即 Phase 1/2/3 + 预览门禁 Task 6/10；§11 为决策记录无任务。无缺口。
2. **Placeholder scan**：无 TBD/TODO；两处「照抄既有测试范式」附了范式来源文件与替代指令（Task 4 Step 1 括注、Task 9 team 分支括注）——执行者有明确路径，非占位。
3. **Type consistency**：`SessionRow.pinnedAt/groupId/sessionType`、`SessionSummary.groupName`、`CollabTarget` 三分态、`SessionGroupRow`、`EffectiveCapabilities` 五个名字跨任务一致（Task 2 产 → 3/4/5/7 消费；Task 9 产 → 11 消费；Task 12 产 → 13 消费）。
4. **Review Focus**：五条各有 owning task 测试（#1→T1、#2→T5、#3→T9、#4→T2/T3、#5→各任务 typecheck 步骤）。
