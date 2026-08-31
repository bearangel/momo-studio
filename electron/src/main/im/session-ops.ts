// electron/src/main/im/session-ops.ts
//
// 会话生命周期操作层（2.0.0 P1 会话内核）。
// 取代原 room-ops 的创建/重命名/解散语义，纯 SQLite——无 Matrix。
//
// 设计要点：
//   - 创建路径统一走 insertSessionWithMembers 事务核心：sessions 行与全部
//     session_members 行（含 is_leader 快照）同事务提交，任一失败整笔回滚。
//   - 双流程（spec §4.4）：createQuickSession 默认 agent 直达；
//     createCollabSession 按 target（单 agent / 团队快照展开）写成员，
//     leader 成员 is_leader=1。
//   - title 语义（spec D4）：占位标题（'新会话'）配 title_auto=1（命名服务
//     可接管）；用户实名配 title_auto=0（永不自动改名）。
//   - getSessionMembersInfo 三表 JOIN（session_members/workspace_agent_members +
//     agent_definitions）；isLeader 读 session_members.is_leader 建会快照（spec §3.3）。
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
import { getWorkspace } from '../workspace/crud';
import { listTeams } from '../agent/team';

/** 协作会话目标（spec §4.4）：单个 agent 或团队（建会时快照展开） */
export type CollabTarget =
  | { type: 'agent'; instanceId: string }
  | { type: 'team'; teamId: string };

/** 快速/协作会话留空时的占位标题（Task 8 命名服务接管前的默认，spec D4） */
export const PLACEHOLDER_TITLE = '新会话';

/**
 * workspace 未设置默认会话 agent（spec §4.4）。
 * message 以 'NO_DEFAULT_AGENT' 开头：Electron IPC 序列化只保留 message，
 * renderer 靠 message 子串识别后弹一次性选择/引导（types.d.ts 契约）。
 */
export class NoDefaultAgentError extends Error {
  readonly code = 'NO_DEFAULT_AGENT' as const;

  constructor(workspaceId: string) {
    super(`NO_DEFAULT_AGENT: workspace ${workspaceId} 未设置默认会话 agent`);
    this.name = 'NoDefaultAgentError';
  }
}

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

/** 事务核心的成员写入项：instance_id + is_leader 快照位 */
interface MemberWrite {
  instanceId: string;
  isLeader: boolean;
}

/**
 * 事务核心：insertSession + 按 members 写 session_members（含 is_leader）。
 * 原子性：任一成员写入抛错（典型：FK 命中不存在的 instance_id），整笔回滚，
 * 不留 orphan 空会话。
 */
function insertSessionWithMembers(args: {
  workspaceId: string;
  title: string;
  titleAuto: boolean;
  kind: SessionRow['kind'];
  members: MemberWrite[];
}): SessionRow {
  const db = getDb();
  const tx = db.transaction((a: {
    workspaceId: string;
    title: string;
    titleAuto: boolean;
    kind: SessionRow['kind'];
    members: MemberWrite[];
  }): SessionRow => {
    const row = insertSession({
      workspaceId: a.workspaceId,
      title: a.title,
      kind: a.kind,
      titleAuto: a.titleAuto,
    });
    for (const m of a.members) {
      addSessionMember(row.id, m.instanceId, m.isLeader);
    }
    return row;
  });
  return tx(args);
}

/**
 * 泛化创建：memberInstanceIds 全部以非 leader 入会（title_auto=0）。
 * 双流程（createQuick/createCollab）之外的通用入口——测试夹具与
 * task_execution 等系统命名路径使用。
 */
export function createSession(input: {
  workspaceId: string;
  title: string;
  /** 成员 instance_id 列表；缺省/空数组 → 创建后无成员 */
  memberInstanceIds?: string[];
  kind?: SessionRow['kind'];
}): SessionRow {
  return insertSessionWithMembers({
    workspaceId: input.workspaceId,
    title: input.title,
    titleAuto: false,
    kind: input.kind ?? 'chat',
    members: (input.memberInstanceIds ?? []).map((iid) => ({ instanceId: iid, isLeader: false })),
  });
}

/**
 * 快速会话（spec §4.4）：workspace 默认 agent 单成员直达。
 * - 无默认 agent → NoDefaultAgentError（renderer 弹一次性选择/引导）
 * - title='新会话' + title_auto=1；唯一成员 is_leader=1（接待判定）
 */
export function createQuickSession(workspaceId: string): SessionRow {
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`未找到 workspace: ${workspaceId}`);
  if (!ws.defaultAgentInstanceId) throw new NoDefaultAgentError(workspaceId);

  return insertSessionWithMembers({
    workspaceId,
    title: PLACEHOLDER_TITLE,
    titleAuto: true,
    kind: 'chat',
    members: [{ instanceId: ws.defaultAgentInstanceId, isLeader: true }],
  });
}

/**
 * 协作会话（spec §4.4）：
 * - target 单 agent → 单成员 is_leader=1
 * - target 团队 → listTeams 取当前成员快照展开写入；leader 成员 is_leader=1
 *   （建会后团队变更不影响本会话，spec §7「团队编辑」行）
 * - title 留空（null/空白）→ 占位标题 + title_auto=1；用户命名 → title_auto=0
 */
export function createCollabSession(
  workspaceId: string,
  title: string | null,
  target: CollabTarget,
): SessionRow {
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`未找到 workspace: ${workspaceId}`);

  // 留空语义（null/undefined/空串/全空白）统一归一为 null → 占位标题 + title_auto=1
  const userTitle = title?.trim() || null;

  let members: MemberWrite[];
  if (target.type === 'agent') {
    members = [{ instanceId: target.instanceId, isLeader: true }];
  } else {
    const team = listTeams(workspaceId).find((t) => t.id === target.teamId);
    if (!team) throw new Error(`团队不存在: ${target.teamId}`);
    if (team.members.length === 0) {
      throw new Error(`团队 ${team.name} 无成员，无法创建会话`);
    }
    members = team.members.map((m) => ({
      instanceId: m.instanceId,
      isLeader: m.instanceId === team.leaderInstanceId,
    }));
  }

  return insertSessionWithMembers({
    workspaceId,
    title: userTitle ?? PLACEHOLDER_TITLE,
    titleAuto: userTitle === null,
    kind: 'chat',
    members,
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
