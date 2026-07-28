// electron/src/main/workspace/crud.ts
//
// Workspace CRUD — 在 SQLite + 文件系统中创建、查询、删除一个 workspace。
// 每个 workspace 必须绑定一个 Matrix Space ID（由调用方通过 matrix 模块提前创建）。
// git 初始化失败不应阻断 workspace 创建，因此单独 try/catch。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { Workspace, CreateWorkspaceInput } from './types';
import { initGitRepo } from './git';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  directory_path: string;
  matrix_space_id: string;
  git_initialized: number;
  created_at: string;
  owner_id: string;
  icon_emoji: string;
}

/** SQLite 行 → 领域对象（snake_case → camelCase） */
function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directoryPath: row.directory_path,
    matrixSpaceId: row.matrix_space_id,
    gitInitialized: row.git_initialized === 1,
    createdAt: row.created_at,
    ownerId: row.owner_id,
    iconEmoji: row.icon_emoji,
  };
}

/**
 * 创建一个新 workspace：分配 UUID → 创建目录 → git init → 写入 SQLite。
 * git init 失败仅记录警告，不抛出（git 是 nice-to-have，DB 记录才是核心）。
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  ownerUserId: string,
  matrixSpaceId: string,
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
    `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    dir,
    matrixSpaceId,
    gitInitialized ? 1 : 0,
    ownerUserId,
    input.iconEmoji ?? '📁',
  );

  // 添加 owner 为成员（保证授权模型从一开始就有 owner 角色）
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, matrix_user_id, role) VALUES (?, ?, 'owner')`,
  ).run(id, ownerUserId);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  logger.info('Workspace 已创建', { id, name: input.name, dir });
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
