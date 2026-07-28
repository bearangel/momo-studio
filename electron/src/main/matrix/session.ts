// electron/src/main/matrix/session.ts
//
// 从 DB + keychain 恢复当前登录用户的会话，构造一个【未启动 sync】的
// Matrix client。供 workspace / agent 等 IPC handler 做一次性 Matrix 操作
// （建 room、邀请 bot）。与 sync-manager 的 startSyncFromSession 区别在于：
// 本函数只创建 client 句柄，不 startClient、不注册事件监听，调用方用完即弃。

import type { MatrixClient } from 'matrix-js-sdk';
import { createMatrixClient } from './client';
import { startConduit } from '../conduit/manager';
import { getSecret } from '../storage/keychain';
import { getDb } from '../storage/db';

const CURRENT_USER_KEY = 'current_user_session';

interface StoredSession {
  userId: string;
  deviceId: string;
}

/** 从 kv_store 读取当前会话记录；未登录返回 undefined */
function readSession(): StoredSession | undefined {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(CURRENT_USER_KEY) as { value: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as StoredSession;
}

/**
 * 构造当前登录用户的 Matrix client（不启动 /sync）。
 * @throws 未登录 / token 丢失 / Conduit 启动失败时抛错
 */
export async function getOwnerMatrixClient(): Promise<MatrixClient> {
  const session = readSession();
  if (!session) throw new Error('未登录');

  const token = await getSecret(`user.${session.userId}.matrix_token`);
  if (!token) throw new Error('Matrix token 丢失');

  const { baseUrl } = await startConduit();
  return createMatrixClient({
    baseUrl,
    userId: session.userId,
    accessToken: token,
    deviceId: session.deviceId,
  });
}

/** 当前登录用户的 Matrix user ID（未登录返回 null） */
export function getCurrentUserId(): string | null {
  return readSession()?.userId ?? null;
}
