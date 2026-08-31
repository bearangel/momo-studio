// electron/src/main/im/session-ops.ts
//
// 会话生命周期操作层（2.0.0 P1 会话内核）。
// 取代原 room-ops 的创建/重命名/解散语义，纯 SQLite——无 Matrix。
//
// 设计要点：
//   - createSession 把 memberInstanceIds 一次性写入 session_members，
//     复用 sessions repo 的 insertSession + addSessionMember。
//   - getSessionMembersInfo 两表 JOIN（session_members/workspace_agent_members +
//     agent_definitions）；isDefaultAgent 由 workspaces.default_agent_instance_id 判定。
//
// v25 过渡态：workspaces.team_session_id 已退役，deleteSessionOp 的团队会话保护
// 待后续 task 按新会话模型（spec §4.4）重接。
// 留待后续 task：群消息写入（messages.session_id 落库）、@ 解析、Runtime 链接。

import { getDb } from '../storage/db';
import {
  insertSession,
  renameSession as repoRenameSession,
  deleteSession,
  addSessionMember,
  listSessionsByWorkspace,
  type SessionRow,
} from '../storage/sessions/repo';

export interface SessionMemberInfo {
  instanceId: string;
  agentName: string;
  iconEmoji: string;
  lastRunning: boolean;
  /** 会话创建时的 leader 快照（session_members.is_leader；接待判定依据，spec §3.3） */
  isLeader: boolean;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  /** 1=自动命名（可被 LLM 替换）；0=用户命名/已手动改名（spec D4） */
  titleAuto: boolean;
  kind: SessionRow['kind'];
  lastMessageAt: number | null;
  members: SessionMemberInfo[];
}

/**
 * 创建会话并以事务方式一次性写入成员。
 * - workspaceId 必须存在（FK 由 sessions.workspace_id 约束）
 * - memberInstanceIds 元素必须在该 workspace 下合法存在
 *   （FK 由 session_members.instance_id 约束，依赖 workspace_agent_members.instance_id）
 *
 * 事务原子性：sessions 行与全部 session_members 行在同一事务中提交——任一成员
 * 写入抛错（典型：FK 命中不存在的 instance_id），整笔回滚，避免半状态。
 * 因此函数返回前不会留下 orphan 的空 session。
 */
export function createSession(input: {
  workspaceId: string;
  title: string;
  /** 成员 instance_id 列表；缺省/空数组 → 创建后无成员 */
  memberInstanceIds?: string[];
  kind?: SessionRow['kind'];
}): SessionRow {
  const db = getDb();
  const ids = input.memberInstanceIds ?? [];
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
    for (const iid of args.memberIds) {
      addSessionMember(row.id, iid);
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
 * 解散会话。非保护会话级联清理 session_members（DB ON DELETE CASCADE）。
 */
export function deleteSessionOp(id: string): void {
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
    titleAuto: s.titleAuto,
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
    id: string; workspace_id: string; title: string; title_auto: number; kind: string;
    settings_json: string | null; created_at: number; updated_at: number; last_message_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    titleAuto: r.title_auto === 1,
    kind: r.kind as SessionRow['kind'],
    settingsJson: r.settings_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
  }));
}

/**
 * 读会话成员信息：JOIN session_members → workspace_agent_members → agent_definitions；
 * isLeader 读 session_members.is_leader 快照列（建会时写入，spec §3.3）。
 *
 * 空成员返回 []（不抛错）。
 */
export function getSessionMembersInfo(sessionId: string): SessionMemberInfo[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT m.instance_id, m.is_leader, a.last_running, d.name, d.icon_emoji
       FROM session_members m
       JOIN workspace_agent_members a ON m.instance_id = a.instance_id
       JOIN agent_definitions d ON a.agent_definition_id = d.id
       WHERE m.session_id = ?
       ORDER BY m.added_at ASC`,
    )
    .all(sessionId) as Array<{
    instance_id: string;
    is_leader: number;
    last_running: number;
    name: string;
    icon_emoji: string;
  }>;

  return rows.map((r) => ({
    instanceId: r.instance_id,
    agentName: r.name,
    iconEmoji: r.icon_emoji,
    lastRunning: r.last_running === 1,
    isLeader: r.is_leader === 1,
  }));
}
