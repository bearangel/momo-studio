// electron/src/main/sandbox/write-grant.ts
// 通用写授权存储（spec 2026-10-03 §3/§4）：session/ws 两键 kv_store，值为归一化
// 绝对路径 JSON 数组。会话授权随 deleteSession 清理、工作空间授权随 deleteWorkspace
// 清理（storage/workspace 层挂接）——授权账本不留越权残留。
// 归一化复用 expandToolchainDirs（~/ 展开 + 占位项解析 + realpath 去重；授权目录
// 恒为绝对路径输入，走「原样 + realpath 归一」分支）。
import os from 'node:os';
import { getDb } from '../storage/db';
import { expandToolchainDirs } from './toolchain-grant';

type Scope = 'session' | 'workspace';

function kvKey(scope: Scope, key: string): string {
  return scope === 'session'
    ? `sandbox_write_grant_session_${key}`
    : `sandbox_write_grant_ws_${key}`;
}

function readKey(scope: Scope, key: string): string[] {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(kvKey(scope, key)) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    return []; // 损坏行按空处理（账本卫生不抛错）
  }
}

function writeKey(scope: Scope, key: string, dirs: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(kvKey(scope, key), JSON.stringify(dirs));
}

/** 授权（spec §3）：写入前归一化，与既有条目并集去重 */
export function grantWriteDirs(scope: Scope, key: string, dirs: string[]): void {
  const normalized = expandToolchainDirs(dirs, os.homedir());
  if (normalized.length === 0) return;
  const merged = [...new Set([...readKey(scope, key), ...normalized])];
  writeKey(scope, key, merged);
}

export function revokeWriteDir(scope: Scope, key: string, dir: string): void {
  writeKey(scope, key, readKey(scope, key).filter((d) => d !== dir));
}

/** 两层合成（预置清单在 resolveShellSpawn 侧另行合成）；null 键跳过该层 */
export function getGrantedDirs(sessionId: string | null, workspaceId: string | null): string[] {
  const out: string[] = [];
  if (sessionId !== null) out.push(...readKey('session', sessionId));
  if (workspaceId !== null) out.push(...readKey('workspace', workspaceId));
  return [...new Set(out)];
}

/** 设置页（spec §8）：全部工作空间持久授权 */
export function listWorkspaceGrants(): Array<{ workspaceId: string; dirs: string[] }> {
  const rows = getDb()
    .prepare("SELECT key FROM kv_store WHERE key LIKE 'sandbox_write_grant_ws_%'")
    .all() as Array<{ key: string }>;
  return rows.map((r) => {
    const workspaceId = r.key.slice('sandbox_write_grant_ws_'.length);
    return { workspaceId, dirs: readKey('workspace', workspaceId) };
  });
}

export function clearSessionGrants(sessionId: string): void {
  getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(kvKey('session', sessionId));
}

export function clearWorkspaceGrants(workspaceId: string): void {
  getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(kvKey('workspace', workspaceId));
}

export function __clearWriteGrantsForTest(): void {
  getDb().prepare("DELETE FROM kv_store WHERE key LIKE 'sandbox_write_grant_%'").run();
}
