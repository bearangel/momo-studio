// electron/src/main/storage/sessions/repo.ts
//
// sessions / session_members 表 CRUD（2.0.0 P1 会话内核；v25 概念模型更换）。
// 取代 Matrix room：workspace 隔离 = 外键；会话设置存 settings_json（取代 v1 的房间级设置表）。
// v25：sessions.title_auto（自动命名标记，spec D4）；session_members.instance_id
// （FK → workspace_agent_members）+ is_leader（快照记 leader，接待判定依据，spec §3.3）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

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
}

export interface SessionSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
  conflictStrategy: 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';
}

type SqlRow = {
  id: string; workspace_id: string; title: string; title_auto: number; kind: string;
  settings_json: string | null; created_at: number; updated_at: number; last_message_at: number | null;
};

function rowToCamel(r: SqlRow): SessionRow {
  return {
    id: r.id, workspaceId: r.workspace_id, title: r.title,
    titleAuto: r.title_auto === 1,
    kind: r.kind as SessionRow['kind'], settingsJson: r.settings_json,
    createdAt: r.created_at, updatedAt: r.updated_at, lastMessageAt: r.last_message_at,
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
}): SessionRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.workspaceId, input.title, input.titleAuto ? 1 : 0, input.kind ?? 'chat', now, now);
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
