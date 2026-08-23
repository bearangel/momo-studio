// electron/src/main/workspace/crud.ts
//
// Workspace CRUD — 在 SQLite + 文件系统中创建、查询、删除一个 workspace。
// v23：Matrix space 关联列已删除；团队房间列更名 team_session_id。
// v2（Task 10）：createWorkspace 内部创建默认团队会话（sessions 表）并回填
// team_session_id——不再由调用方先建 Matrix room 后传入。
// git 初始化失败不应阻断 workspace 创建，因此单独 try/catch。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../storage/db';
import { insertSession } from '../storage/sessions/repo';
import { logger } from '../logger';
import type { Workspace, CreateWorkspaceInput } from './types';
import { initGitRepo } from './git';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  directory_path: string;
  team_session_id: string;
  git_initialized: number;
  created_at: string;
  owner_id: string;
  icon_emoji: string;
  coordinator_instance_id: string | null;
}

/** SQLite 行 → 领域对象（snake_case → camelCase） */
function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directoryPath: row.directory_path,
    teamSessionId: row.team_session_id,
    gitInitialized: row.git_initialized === 1,
    createdAt: row.created_at,
    ownerId: row.owner_id,
    iconEmoji: row.icon_emoji,
    coordinatorInstanceId: row.coordinator_instance_id,
  };
}

/**
 * 创建一个新 workspace：分配 UUID → 创建目录 → git init → 写入 SQLite →
 * 创建默认团队会话并回填 team_session_id。
 * git init 失败仅记录警告，不抛出（git 是 nice-to-have，DB 记录才是核心）。
 *
 * v2（Task 10）：团队会话是本地 sessions 表行（title='团队会话'，kind='chat'），
 * 不再创建 Matrix room——用户与 agent 的团队交流全部落 SQLite。
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  ownerUserId: string,
): Promise<Workspace> {
  const id = randomUUID();
  const dir = path.resolve(input.directoryPath);

  // 创建目录（如不存在）。workspace 直接建在该目录下，工作空间内部没有额外嵌套。
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // git init — 失败不阻断流程
  let gitInitialized = false;
  try {
    await initGitRepo(dir);
    gitInitialized = true;
  } catch (err) {
    logger.warn('Git 初始化失败，继续创建 workspace', { error: (err as Error).message });
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, team_session_id, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    dir,
    gitInitialized ? 1 : 0,
    ownerUserId,
    input.iconEmoji ?? '📁',
  );

  // 默认团队会话：本地 sessions 行 + 回填外键（两步写而非事务——workspace 行
  // 先落地，会话创建失败时 workspace 仍可用，team_session_id 留空可后补）
  const teamSession = insertSession({ workspaceId: id, title: '团队会话', kind: 'chat' });
  db.prepare('UPDATE workspaces SET team_session_id = ? WHERE id = ?').run(teamSession.id, id);

  // 添加 owner 为成员（保证授权模型从一开始就有 owner 角色）
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, matrix_user_id, role) VALUES (?, ?, 'owner')`,
  ).run(id, ownerUserId);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  logger.info('Workspace 已创建', { id, name: input.name, dir, teamSessionId: teamSession.id });
  return rowToWorkspace(row);
}

/** 列出所有 workspace，按 created_at 倒序（最新优先）。 */
export function listWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}

/** 按 ID 查询，未找到返回 null。 */
export function getWorkspace(id: string): Workspace | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/** 按 ID 删除记录（注意：当前实现不删除磁盘上的 directory_path）。 */
export function deleteWorkspace(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  logger.info('Workspace 已删除', { id });
}

/** 重命名 workspace（仅更新 name 列）。不存在时抛错。空/全空白名拒绝并抛错。 */
export function renameWorkspace(id: string, name: string): void {
  // 空名校验：trim 后为空视为空名（防止 "   " 这种全空白绕过）；存 DB 的是 trim 后的值。
  const trimmed = name.trim();
  if (!trimmed) throw new Error('工作空间名称不能为空');
  const db = getDb();
  const result = db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(trimmed, id);
  if (result.changes === 0) throw new Error(`Workspace 不存在: ${id}`);
  logger.info('Workspace 已重命名', { id, name: trimmed });
}

/** 设置/清空 workspace 的协调 agent。null 表示清空。 */
export function setWorkspaceCoordinator(workspaceId: string, instanceId: string | null): void {
  const db = getDb();
  const result = db.prepare('UPDATE workspaces SET coordinator_instance_id = ? WHERE id = ?').run(
    instanceId,
    workspaceId,
  );
  if (result.changes === 0) throw new Error(`Workspace 不存在: ${workspaceId}`);
}
