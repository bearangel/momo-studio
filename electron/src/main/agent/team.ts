// electron/src/main/agent/team.ts
//
// 团队服务（v25 spec 2026-08-31 §4.2）。
//
// 数据模型（migration v25）：teams（ws 级，leader FK 指成员表）+ team_members
// （PK (team_id, instance_id)，双向 FK ON DELETE CASCADE）。
// DB 不约束「leader ∈ team_members」，本层负责事务内保证（spec §3.2）：
// leader 必须同时在成员集内，建团/换 leader 同事务校验。
//
// instanceId / teamId 均单点生成沿线透传：instanceId 由 addMember（crud.ts）
// 生成，本模块只消费；teamId 在 createTeam 生成后由调用方传递。
//
// 失败语义分野：目标不存在——removeTeamMember / deleteTeam 幂等 no-op
// （对齐 removeMember 先例）；renameTeam / setLeader / addTeamMember 显式 throw。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { rowToMember, type WorkspaceMemberRow } from './crud';
import type { Team, WorkspaceAgentMember } from './types';

/** teams 行的弱类型映射 */
interface TeamRow {
  id: string;
  workspace_id: string;
  name: string;
  icon_emoji: string;
  leader_instance_id: string;
  created_at: string;
}

function rowToTeam(row: TeamRow, members: WorkspaceAgentMember[]): Team {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    iconEmoji: row.icon_emoji,
    leaderInstanceId: row.leader_instance_id,
    members,
    createdAt: row.created_at,
  };
}

/** 批量 JOIN 展开 team_members → WorkspaceAgentMember（单查询按 team_id 分组；
 *  v2.2：JOIN agent_definitions 带出 agentName/iconEmoji，团队列表不再显示 ID） */
function loadMembersByTeam(teamIds: string[]): Map<string, WorkspaceAgentMember[]> {
  if (teamIds.length === 0) return new Map();
  const placeholders = teamIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT tm.team_id, wam.*, d.name, d.icon_emoji FROM team_members tm
       JOIN workspace_agent_members wam ON wam.instance_id = tm.instance_id
       JOIN agent_definitions d ON d.id = wam.agent_definition_id
       WHERE tm.team_id IN (${placeholders})
       ORDER BY tm.added_at ASC, wam.instance_id ASC`,
    )
    .all(...teamIds) as (WorkspaceMemberRow & { team_id: string })[];
  const map = new Map<string, WorkspaceAgentMember[]>();
  for (const row of rows) {
    const list = map.get(row.team_id) ?? [];
    list.push(rowToMember(row));
    map.set(row.team_id, list);
  }
  return map;
}

function getTeamRow(teamId: string): TeamRow | undefined {
  return getDb().prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
}

/**
 * 建团（spec §4.2）：单事务——校验 + 写 teams + 写 team_members 任一失败整笔回滚。
 * 校验顺序：memberInstanceIds 先去重（保序）→ 成员数 ≥2（leader + 至少 1 子）→
 * leader ∈ 去重后成员集 → 全部成员存在且属于该 workspace（FK 兜底并发窗口）。
 */
export function createTeam(
  workspaceId: string,
  name: string,
  iconEmoji: string,
  memberInstanceIds: string[],
  leaderInstanceId: string,
): Team {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('团队名称不能为空');

  const db = getDb();
  const teamId = randomUUID();
  const icon = iconEmoji.trim() || '👥';

  db.transaction(() => {
    const uniqueIds = [...new Set(memberInstanceIds)];
    if (uniqueIds.length < 2) {
      throw new Error(`团队成员数至少 2（leader + 至少 1 名成员），去重后为 ${uniqueIds.length}`);
    }
    if (!uniqueIds.includes(leaderInstanceId)) {
      throw new Error(`leader 必须在团队成员集内: ${leaderInstanceId}`);
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const found = db
      .prepare(
        `SELECT instance_id FROM workspace_agent_members
         WHERE workspace_id = ? AND instance_id IN (${placeholders})`,
      )
      .all(workspaceId, ...uniqueIds) as { instance_id: string }[];
    const foundSet = new Set(found.map((r) => r.instance_id));
    const missing = uniqueIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new Error(`成员不存在或不属于该工作空间: ${missing.join(', ')}`);
    }

    db.prepare(
      `INSERT INTO teams (id, workspace_id, name, icon_emoji, leader_instance_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(teamId, workspaceId, trimmedName, icon, leaderInstanceId);

    const insertMember = db.prepare(
      'INSERT INTO team_members (team_id, instance_id, added_at) VALUES (?, ?, ?)',
    );
    const base = Date.now();
    uniqueIds.forEach((instanceId, i) => insertMember.run(teamId, instanceId, base + i));
  })();

  const row = getTeamRow(teamId)!;
  const members = loadMembersByTeam([teamId]).get(teamId) ?? [];
  logger.info('团队已创建', { teamId, workspaceId, name: trimmedName, memberCount: members.length });
  return rowToTeam(row, members);
}

/** 改名 / 换图标；iconEmoji 省略时保留原值。 */
export function renameTeam(teamId: string, name: string, iconEmoji?: string): void {
  const db = getDb();
  const existing = getTeamRow(teamId);
  if (!existing) throw new Error(`团队不存在: ${teamId}`);
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('团队名称不能为空');
  const icon = iconEmoji !== undefined ? iconEmoji.trim() || '👥' : existing.icon_emoji;
  db.prepare('UPDATE teams SET name = ?, icon_emoji = ? WHERE id = ?').run(
    trimmedName,
    icon,
    teamId,
  );
  logger.info('团队已更名', { teamId, name: trimmedName });
}

/**
 * 换 leader（spec §4.2）：事务保证新 leader 在 team_members 内——
 * 校验与 UPDATE 同事务，杜绝「校验后、更新前成员被移出」的窗口。
 */
export function setLeader(teamId: string, leaderInstanceId: string): void {
  const db = getDb();
  db.transaction(() => {
    if (!getTeamRow(teamId)) throw new Error(`团队不存在: ${teamId}`);
    const inTeam = db
      .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND instance_id = ?')
      .get(teamId, leaderInstanceId);
    if (!inTeam) throw new Error(`新 leader 必须是团队成员: ${leaderInstanceId}`);
    db.prepare('UPDATE teams SET leader_instance_id = ? WHERE id = ?').run(
      leaderInstanceId,
      teamId,
    );
  })();
  logger.info('团队 leader 已切换', { teamId, leaderInstanceId });
}

/** 加团队成员。成员须存在且属于团队所在 workspace（与 createTeam 同一 ws 一致性不变量）；
 *  重复添加先检友好报错（PK 约束兜底并发窗口）。 */
export function addTeamMember(teamId: string, instanceId: string): void {
  const db = getDb();
  const team = getTeamRow(teamId);
  if (!team) throw new Error(`团队不存在: ${teamId}`);
  const dup = db
    .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND instance_id = ?')
    .get(teamId, instanceId);
  if (dup) throw new Error('该成员已在团队中');
  const member = db
    .prepare('SELECT 1 FROM workspace_agent_members WHERE instance_id = ? AND workspace_id = ?')
    .get(instanceId, team.workspace_id);
  if (!member) throw new Error(`成员不存在或不属于该工作空间: ${instanceId}`);
  db.prepare('INSERT INTO team_members (team_id, instance_id, added_at) VALUES (?, ?, ?)').run(
    teamId,
    instanceId,
    Date.now(),
  );
  logger.info('团队成员已添加', { teamId, instanceId });
}

/**
 * 移除团队成员。leader 守卫（参考 removeMember 守卫风格，brief 指定 throw）：
 * 移除的是该团队 leader → 拒绝（先转移 leader 或解散团队），零破坏。
 * 不存在的成员 / 团队幂等 no-op。
 */
export function removeTeamMember(teamId: string, instanceId: string): void {
  const db = getDb();
  const team = getTeamRow(teamId);
  if (!team) return;
  if (team.leader_instance_id === instanceId) {
    logger.warn('移除团队成员被拒：该成员是 leader', { teamId, instanceId });
    throw new Error('不能移除团队 leader，请先转移 leader 或解散团队');
  }
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND instance_id = ?').run(
    teamId,
    instanceId,
  );
  logger.info('团队成员已移除', { teamId, instanceId });
}

/**
 * 解散团队（仅删定义）：team_members 由 FK ON DELETE CASCADE 级联清理，
 * workspace_agent_members 与已建会话快照（session_members 存量）不受影响。
 * 不存在的团队幂等 no-op。
 */
export function deleteTeam(teamId: string): void {
  const db = getDb();
  const info = db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
  if (info.changes > 0) logger.info('团队已解散', { teamId });
}

/** 列出某 workspace 全部团队（JOIN 展开成员；leaderInstanceId 即 leader 标记，UI 依此渲染 👑）。 */
export function listTeams(workspaceId: string): Team[] {
  const db = getDb();
  const teamRows = db
    .prepare('SELECT * FROM teams WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(workspaceId) as TeamRow[];
  if (teamRows.length === 0) return [];
  const membersByTeam = loadMembersByTeam(teamRows.map((r) => r.id));
  return teamRows.map((r) => rowToTeam(r, membersByTeam.get(r.id) ?? []));
}
