// 节点工作目录设置（2026-10-27 节点互联「工作目录」）：
// 新建工作空间（手动预填）与镜像落位共用的根目录——kv_store key 'hub_workspace_dir'。
// rootDir=null 表示默认（<userData>/workspaces）；既有工作空间零迁移（只影响新落位）。
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDb } from '../storage/db';
import { resolveUserDataDir } from '../paths';

const KEY = 'hub_workspace_dir';

/** renderer 侧展示/编辑用视图（get/set 共用回执形状） */
export interface HubWorkspaceDirView {
  /** 用户配置的根（null=默认） */
  rootDir: string | null;
  /** 默认根（<userData>/workspaces，随环境解析） */
  defaultRootDir: string;
  /** 生效根 = rootDir ?? defaultRootDir（消费方唯一读点） */
  effectiveRootDir: string;
}

export function defaultWorkspaceRootDir(): string {
  return path.join(resolveUserDataDir(), 'workspaces');
}

function toView(rootDir: string | null): HubWorkspaceDirView {
  const defaultRootDir = defaultWorkspaceRootDir();
  return { rootDir, defaultRootDir, effectiveRootDir: rootDir ?? defaultRootDir };
}

export interface HubWorkspaceDirStore {
  view(): HubWorkspaceDirView;
  write(input: { rootDir: string | null }): HubWorkspaceDirView;
}

export function createHubWorkspaceDirStore(db: Database = getDb()): HubWorkspaceDirStore {
  const read = (): string | null => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { rootDir?: unknown };
      return typeof parsed.rootDir === 'string' && parsed.rootDir !== '' ? parsed.rootDir : null;
    } catch {
      return null; // 脏数据容错（config-store 同款读侧纪律）
    }
  };
  return {
    view: () => toView(read()),
    write(input) {
      let rootDir: string | null;
      if (input.rootDir === null) {
        rootDir = null;
      } else {
        // 目录选择器产物恒绝对路径；相对路径在此拦截（防半截配置落库后镜像落位漂移）
        if (!path.isAbsolute(input.rootDir)) {
          throw new Error(`工作目录必须为绝对路径: ${input.rootDir}`);
        }
        rootDir = path.resolve(input.rootDir);
      }
      db.prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(KEY, JSON.stringify({ rootDir }));
      return toView(rootDir);
    },
  };
}
