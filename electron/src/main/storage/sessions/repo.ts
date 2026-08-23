// electron/src/main/storage/sessions/repo.ts
//
// sessions / session_members 表 CRUD（2.0.0 P1 会话内核）。
// 取代 Matrix room：workspace 隔离 = 外键；会话设置存 settings_json（取代 room_settings 表）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface SessionRow {
  id: string;
  workspaceId: string;
  title: string;
  kind: 'chat' | 'task_execution';
  settingsJson: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface SessionSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
  conflictStrategy: 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';
}

type SqlRow = {
  id: string; workspace_id: string; title: string; kind: string;
  settings_json: string | null; created_at: number; updated_at: number; last_message_at: number | null;
};

function rowToCamel(r: SqlRow): SessionRow {
  return {
    id: r.id, workspaceId: r.workspace_id, title: r.title,
    kind: r.kind as SessionRow['kind'], settingsJson: r.settings_json,
    createdAt: r.created_at, updatedAt: r.updated_at, lastMessageAt: r.last_message_at,
  };
}

export function insertSession(input: { workspaceId: string; title: string; kind?: SessionRow['kind'] }): SessionRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, kind, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.workspaceId, input.title, input.kind ?? 'chat', now, now);
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function listSessionsByWorkspace(workspaceId: string): SessionRow[] {
  const rows = getDb().prepare(
    'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_message_at DESC, created_at DESC',
  ).all(workspaceId) as SqlRow[];
  return rows.map(rowToCamel);
}

export function renameSession(id: string, title: string): void {
  getDb().prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
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

export function addSessionMember(sessionId: string, assignmentId: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO session_members (session_id, assignment_id, added_at) VALUES (?, ?, ?)',
  ).run(sessionId, assignmentId, Date.now());
}

export function removeSessionMember(sessionId: string, assignmentId: string): void {
  getDb().prepare('DELETE FROM session_members WHERE session_id = ? AND assignment_id = ?')
    .run(sessionId, assignmentId);
}

export function listSessionMembers(sessionId: string): Array<{ assignmentId: string; addedAt: number }> {
  const rows = getDb().prepare(
    'SELECT assignment_id, added_at FROM session_members WHERE session_id = ? ORDER BY added_at ASC',
  ).all(sessionId) as Array<{ assignment_id: string; added_at: number }>;
  return rows.map((r) => ({ assignmentId: r.assignment_id, addedAt: r.added_at }));
}
