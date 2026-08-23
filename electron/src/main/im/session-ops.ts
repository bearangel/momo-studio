// electron/src/main/im/session-ops.ts
//
// 会话生命周期操作层（2.0.0 P1 会话内核）。
// 取代原 room-ops 的创建/重命名/解散语义，纯 SQLite——无 Matrix。
//
// 设计要点：
//   - 团队会话由 workspaces.team_session_id 指向一个 sessions.id，随 workspace 生命周期，
//     deleteSessionOp 命中即抛错；调用方应改为 setWorkspaceTeamSession(null) 再删。
//   - createSession 把 memberAssignmentIds 一次性写入 session_members，
//     复用 Task 2 sessions repo 的 insertSession + addSessionMember。
//   - getSessionMembersInfo 三表 JOIN（session_members/agent_assignments/agent_definitions），
//     isCoordinator 由 workspaces.coordinator_instance_id 判定（同一 workspace 内逐行比对）。
//
// 留待后续 task：群消息写入（messages.session_id 落库）、@ 解析、Runtime 链接。

import { getDb } from '../storage/db';
import { getWorkspace } from '../workspace/crud';
import {
  insertSession,
  renameSession as repoRenameSession,
  deleteSession,
  addSessionMember,
  listSessionsByWorkspace,
  type SessionRow,
} from '../storage/sessions/repo';

export interface SessionMemberInfo {
  assignmentId: string;
  agentName: string;
  iconEmoji: string;
  role: 'standalone' | 'main' | 'sub';
  lastRunning: boolean;
  /** 该成员是否为该会话所属 workspace 的协调 agent */
  isCoordinator: boolean;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  kind: SessionRow['kind'];
  lastMessageAt: number | null;
  members: SessionMemberInfo[];
}

/**
 * 创建会话并以事务方式一次性写入成员。
 * - workspaceId 必须存在（FK 由 sessions.workspace_id 约束）
 * - memberAssignmentIds 元素必须在该 workspace 下合法存在
 *   （FK 由 session_members.assignment_id 约束，依赖 agent_assignments.instance_id）
 *
 * 事务原子性：sessions 行与全部 session_members 行在同一事务中提交——任一成员
 * 写入抛错（典型：FK 命中不存在的 assignment_id），整笔回滚，避免半状态。
 * 因此函数返回前不会留下 orphan 的空 session。
 */
export function createSession(input: {
  workspaceId: string;
  title: string;
  /** 成员 assignment instance_id 列表；缺省/空数组 → 创建后无成员 */
  memberAssignmentIds?: string[];
  kind?: SessionRow['kind'];
}): SessionRow {
  const db = getDb();
  const ids = input.memberAssignmentIds ?? [];
  const tx = db.transaction((args: {
    workspaceId: string;
    title: string;
    kind: SessionRow['kind'] | undefined;
    memberIds: string[];
  }): SessionRow => {
    const row = insertSession({
      workspaceId: args.workspaceId,
      title: args.title,
      kind: args.kind,
    });
    for (const aid of args.memberIds) {
      addSessionMember(row.id, aid);
    }
    return row;
  });
  return tx({
    workspaceId: input.workspaceId,
    title: input.title,
    kind: input.kind,
    memberIds: ids,
  });
}

/**
 * 重命名会话。空串或仅空白不在此层校验——由调用方按业务规则决定。
 */
export function renameSession(id: string, title: string): void {
  repoRenameSession(id, title);
}

/**
 * 解散会话。团队会话（workspaces.team_session_id === id）禁止单独解散，抛错。
 * 非团队会话级联清理 session_members（DB ON DELETE CASCADE）。
 */
export function deleteSessionOp(id: string): void {
  const db = getDb();
  // 团队会话保护：读 workspaces.team_session_id，命中即抛错
  const protectedRow = db
    .prepare('SELECT id FROM workspaces WHERE team_session_id = ?')
    .get(id) as { id: string } | undefined;
  if (protectedRow) {
    throw new Error('团队会话随 workspace 删除，禁止单独解散');
  }
  deleteSession(id);
}

/**
 * 列出某 workspace 下的全部会话（含成员信息）。
 * workspaceId 缺省 → 返回全部 workspace 的会话（仅迁移/调试用，
 * IM 入口应总是带 workspaceId 过滤）。
 */
export function getSessionsForWorkspace(workspaceId?: string): SessionSummary[] {
  const sessions = workspaceId ? listSessionsByWorkspace(workspaceId) : listAllSessions();
  return sessions.map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    title: s.title,
    kind: s.kind,
    lastMessageAt: s.lastMessageAt,
    members: getSessionMembersInfo(s.id),
  }));
}

/** 不过滤 workspace 的全量会话列表；内部辅助。 */
function listAllSessions(): SessionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM sessions ORDER BY last_message_at DESC, created_at DESC')
    .all() as Array<{
    id: string; workspace_id: string; title: string; kind: string;
    settings_json: string | null; created_at: number; updated_at: number; last_message_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    kind: r.kind as SessionRow['kind'],
    settingsJson: r.settings_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
  }));
}

/**
 * 读会话成员信息：JOIN session_members → agent_assignments → agent_definitions，
 * isCoordinator 需二次比对 workspace.coordinator_instance_id。
 *
 * 步骤：
 *   1) 取 sessionId 所属 workspaceId；
 *   2) JOIN 三表，按 added_at ASC 拉成员；
 *   3) 读 workspace.coordinator_instance_id（可能为 null），命中成员打 isCoordinator=true。
 *
 * 空成员返回 []（不抛错）。
 */
export function getSessionMembersInfo(sessionId: string): SessionMemberInfo[] {
  const db = getDb();

  const sessionRow = db
    .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
    .get(sessionId) as { workspace_id: string } | undefined;
  if (!sessionRow) return [];

  const ws = getWorkspace(sessionRow.workspace_id);
  const coordinatorInstanceId = ws?.coordinatorInstanceId ?? null;

  const rows = db
    .prepare(
      `SELECT a.instance_id, a.role, a.last_running, d.name, d.icon_emoji
       FROM session_members m
       JOIN agent_assignments a ON m.assignment_id = a.instance_id
       JOIN agent_definitions d ON a.agent_definition_id = d.id
       WHERE m.session_id = ?
       ORDER BY m.added_at ASC`,
    )
    .all(sessionId) as Array<{
    instance_id: string;
    role: string;
    last_running: number;
    name: string;
    icon_emoji: string;
  }>;

  return rows.map((r) => ({
    assignmentId: r.instance_id,
    agentName: r.name,
    iconEmoji: r.icon_emoji,
    role: r.role as SessionMemberInfo['role'],
    lastRunning: r.last_running === 1,
    isCoordinator: coordinatorInstanceId !== null && coordinatorInstanceId === r.instance_id,
  }));
}
