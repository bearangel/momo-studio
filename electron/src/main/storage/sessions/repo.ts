// electron/src/main/storage/sessions/repo.ts
//
// sessions / session_members 表 CRUD（2.0.0 P1 会话内核；v25 概念模型更换）。
// 取代 Matrix room：workspace 隔离 = 外键；会话设置存 settings_json（取代 v1 的房间级设置表）。
// v25：sessions.title_auto（自动命名标记，spec D4）；session_members.instance_id
// （FK → workspace_agent_members）+ is_leader（快照记 leader，接待判定依据，spec §3.3）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { emitPluginEvent } from '../../plugin/event-sources';
import { clearSessionGrants } from '../../sandbox/write-grant';

export interface SessionRow {
  id: string;
  workspaceId: string;
  title: string;
  /** 1=自动命名（可被 LLM 替换）；0=用户命名/已手动改名（spec D4） */
  titleAuto: boolean;
  kind: 'chat' | 'task_execution';
  settingsJson: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  /** 置顶时间戳（spec 2026-10-22 §4.1）；NULL=未置顶 */
  pinnedAt: number | null;
  /** 所属分组（spec 2026-10-22 §4）；NULL=未分组 */
  groupId: string | null;
  /** 会话类型（spec §3.1）；NULL=泛化创建路径（图标按 kind 判定） */
  sessionType: 'quick' | 'collab' | null;
}

export interface SessionSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
  conflictStrategy: 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';
}

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

/**
 * 写入 sessions 行。titleAuto 缺省 false（用户/系统命名）；快速/协作会话的
 * 占位标题路径传 true（spec D4：title_auto=1 才允许命名服务改名）。
 */
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

export function getSession(id: string): SessionRow | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function listSessionsByWorkspace(workspaceId: string): SessionRow[] {
  const rows = getDb().prepare(
    'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC, created_at DESC',
  ).all(workspaceId) as SqlRow[];
  return rows.map(rowToCamel);
}

/**
 * 排序契约单点（spec 2026-10-22 §4.1）：置顶区 > 分组 > 未分组 > 活跃时间。
 * 供 listSessionsWithGroup（列表数据源）与 listAllSessions（不限 ws）同源引用，
 * 避免两处 ORDER BY 漂移。依赖左侧 JOIN 别名：s=sessions / g=session_groups。
 */
const SESSION_ORDER_BY = `ORDER BY
  (s.pinned_at IS NULL) ASC,
  s.pinned_at DESC,
  (g.position IS NULL) ASC,
  g.position ASC,
  g.created_at ASC,
  COALESCE(s.last_message_at, s.created_at) DESC,
  s.created_at DESC`;

/** 会话行 + 分组名（LEFT JOIN 产物；group_name 未分组时为 NULL） */
export interface SessionWithGroupRow extends SessionRow {
  groupName: string | null;
}

/** 会话列表（排序契约单源，Task 4 IPC `session:list` 数据源） */
export function listSessionsWithGroup(workspaceId: string): SessionWithGroupRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, g.name AS group_name FROM sessions s
       LEFT JOIN session_groups g ON g.id = s.group_id
       WHERE s.workspace_id = ? ${SESSION_ORDER_BY}`,
    )
    .all(workspaceId) as Array<SqlRow & { group_name: string | null }>;
  return rows.map((r) => ({ ...rowToCamel(r), groupName: r.group_name }));
}

/** 不限 workspace 的全量会话列表（仅迁移/调试用）；排序契约与 listSessionsWithGroup 同源 */
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

export function renameSession(id: string, title: string): void {
  // 手动改名在同一语句内清 title_auto（spec D4 竞态锁的另一半）：
  // 若分两条语句，title 已改但 title_auto=1 的窗口内，飞行中的 LLM 命名
  // （WHERE title_auto=1）仍可覆盖用户手动命名
  getDb()
    .prepare('UPDATE sessions SET title = ?, title_auto = 0, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id);
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  // 会话授权随会话清理（spec 2026-10-03 §4 生命周期）——write-grant 只依赖
  // storage/db，import 方向无环
  clearSessionGrants(id);
  emitPluginEvent('sessionEnded', { id });
}

/** 消息写入路径调用：刷新 last_message_at（排序键） */
export function touchSessionLastMessage(id: string): void {
  getDb().prepare('UPDATE sessions SET last_message_at = ? WHERE id = ?').run(Date.now(), id);
}

export function updateSessionSettings(id: string, patch: Partial<SessionSettings>): void {
  const merged = { ...getSessionSettings(id), ...patch };
  getDb().prepare('UPDATE sessions SET settings_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), Date.now(), id);
}

export function getSessionSettings(id: string): SessionSettings {
  const row = getDb().prepare('SELECT settings_json FROM sessions WHERE id = ?').get(id) as
    | { settings_json: string | null } | undefined;
  if (!row?.settings_json) return { maxToolCalls: null, conflictStrategy: 'ask' };
  const parsed = JSON.parse(row.settings_json) as Partial<SessionSettings>;
  return {
    maxToolCalls: parsed.maxToolCalls ?? null,
    conflictStrategy: parsed.conflictStrategy ?? 'ask',
  };
}

// ─── 成员 ──────────────────────────────────────────────────────────────────

export function addSessionMember(sessionId: string, instanceId: string, isLeader = false): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO session_members (session_id, instance_id, is_leader, added_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, instanceId, isLeader ? 1 : 0, Date.now());
}

export function removeSessionMember(sessionId: string, instanceId: string): void {
  getDb().prepare('DELETE FROM session_members WHERE session_id = ? AND instance_id = ?')
    .run(sessionId, instanceId);
}

export function listSessionMembers(sessionId: string): Array<{ instanceId: string; isLeader: boolean; addedAt: number }> {
  const rows = getDb().prepare(
    'SELECT instance_id, is_leader, added_at FROM session_members WHERE session_id = ? ORDER BY added_at ASC',
  ).all(sessionId) as Array<{ instance_id: string; is_leader: number; added_at: number }>;
  return rows.map((r) => ({ instanceId: r.instance_id, isLeader: r.is_leader === 1, addedAt: r.added_at }));
}

// ─── 分组与置顶（spec 2026-10-22 §4.1）──────────────────────────────────────

/**
 * 组色轮转盘（预览 A rev2 批准定值 light 档，spec 2026-10-22 §4.4）。
 * 与 renderer/src/lib/group-colors.ts 对齐（镜像纪律）——renderer 侧由 Task 7 建；
 * 迁移 068 的存量回填 CASE 分支与本数组顺序一致，改一处必同步三处。
 */
export const GROUP_COLOR_PALETTE = [
  '#5E6AD2', '#23835C', '#B7791F', '#D33F49', '#6E56CF', '#3E8F8C',
] as const;

export interface SessionGroupRow {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  /** 组色（#RRGGBB）。存量行迁移 068 回填后非空；groupRowToCamel 以 ?? '' 防御 */
  color: string;
  createdAt: number;
}

type GroupSqlRow = {
  id: string; workspace_id: string; name: string;
  position: number; color: string | null; created_at: number;
};

function groupRowToCamel(r: GroupSqlRow): SessionGroupRow {
  return {
    id: r.id, workspaceId: r.workspace_id, name: r.name,
    position: r.position, color: r.color ?? '', createdAt: r.created_at,
  };
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
  // position 步进契约镜像 task_groups：(max + 1024)，同 workspace 内单调递增
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM session_groups WHERE workspace_id = ?')
    .get(workspaceId) as { p: number };
  // 组色建组即定值：按该 workspace 既有组数轮转（迁移 068 后不再有 NULL 色）
  const count = db.prepare('SELECT COUNT(*) AS c FROM session_groups WHERE workspace_id = ?')
    .get(workspaceId) as { c: number };
  const color = GROUP_COLOR_PALETTE[count.c % GROUP_COLOR_PALETTE.length];
  db.prepare(
    'INSERT INTO session_groups (id, workspace_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, name, max.p + 1024, color, Date.now());
  return groupRowToCamel(
    db.prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as GroupSqlRow,
  );
}

export function renameSessionGroup(id: string, name: string): void {
  getDb().prepare('UPDATE session_groups SET name = ? WHERE id = ?').run(name, id);
}

/** 组色直写（预览 A rev2）：组表无 updated_at，单 UPDATE 不带时间戳。 */
export function setSessionGroupColor(id: string, color: string): void {
  getDb().prepare('UPDATE session_groups SET color = ? WHERE id = ?').run(color, id);
}

/** 删组（事务）：组内会话回落未分组 → 删组行。置顶位 pinned_at 独立保留（spec §4.1）。 */
export function deleteSessionGroup(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    // 先清引用再删组行：sessions.group_id FK 为 NO ACTION，顺序颠倒会因外键约束失败
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
