// electron/src/main/workspace/ipc.handlers.ts
//
// Workspace IPC handlers — 把 T2 的 CRUD 函数包装成 `workspace:*` IPC 通道，
// 并在 create 时联动 Matrix：先创建 Space，再把 spaceId 落到 DB 记录里。
//
// 取已登录用户 Matrix client 的逻辑放在 getMatrixClient：从 keychain 恢复
// token，用现有 createMatrixClient 工厂构造一个临时 client（无需长连接）。
// 这里复用 authFlows 的 AuthDeps 形状，确保与 auth 模块行为一致。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from './crud';
import { createMatrixSpace } from '../matrix/rooms';
import { getDb } from '../storage/db';
import { createMatrixClient } from '../matrix/client';
import { getCurrentUserFlow } from '../ipc/authFlows';
import type { AuthDeps } from '../ipc/authFlows';
import type { CreateWorkspaceInput } from './types';
import type { MatrixClient } from 'matrix-js-sdk';
import { setSecret, getSecret, deleteSecret } from '../storage/keychain';

/** 从 kv_store 读出当前登录用户 ID；未登录返回 null。 */
function getCurrentUserId(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('current_user_session') as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.value) as { userId: string };
  return parsed.userId;
}

/** 获取已登录用户的 Matrix client（从 keychain 恢复 token） */
async function getMatrixClient(): Promise<MatrixClient> {
  // AuthDeps 的运行时依赖直接静态导入（matrix-js-sdk / keychain / db 都已在
  // 进程中加载，无循环依赖风险）；getCurrentUserFlow 复用 auth 模块的会话恢复
  // 逻辑，确保与 auth:* 行为一致。
  const deps: AuthDeps = {
    startConduit: async () => ({ port: 8008, baseUrl: 'http://127.0.0.1:8008' }),
    createMatrixClient,
    setSecret,
    getSecret,
    deleteSecret,
    dbRun: (sql: string, ...params: unknown[]): void => {
      getDb().prepare(sql).run(...params);
    },
    dbGet: <T>(sql: string, ...params: unknown[]): T | undefined => {
      return getDb().prepare(sql).get(...params) as T | undefined;
    },
  };

  const session = await getCurrentUserFlow(deps);
  if (!session) throw new Error('未登录');

  const token = await deps.getSecret(`user.${session.userId}.matrix_token`);
  if (!token) throw new Error('Matrix token 丢失');

  return createMatrixClient({
    baseUrl: 'http://127.0.0.1:8008',
    userId: session.userId,
    accessToken: token,
  });
}

/** 注册 workspace:* IPC handlers。重复注册会被 Electron 拒绝，故仅调用一次。 */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:create', async (_evt, input: CreateWorkspaceInput) => {
    const userId = getCurrentUserId();
    if (!userId) throw new Error('未登录，无法创建 workspace');

    const client = await getMatrixClient();
    const spaceId = await createMatrixSpace(client, input.name);

    return createWorkspace(input, userId, spaceId);
  });

  ipcMain.handle('workspace:list', async () => {
    return listWorkspaces();
  });

  ipcMain.handle('workspace:get', async (_evt, id: string) => {
    return getWorkspace(id);
  });

  ipcMain.handle('workspace:delete', async (_evt, id: string) => {
    deleteWorkspace(id);
    return;
  });

  logger.info('Workspace IPC handlers 已注册');
}
