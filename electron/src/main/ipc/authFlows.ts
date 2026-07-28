// electron/src/main/ipc/authFlows.ts
//
// Pure, dependency-injected auth flow functions. Each flow takes an explicit
// `AuthDeps` bundle (Conduit, Matrix client factory, keychain, DB) so the
// orchestration is trivially unit-testable without an Electron runtime or any
// real IO. The IPC handler layer (auth.handlers.ts) constructs production deps
// and wires these flows into `ipcMain.handle`.
import type { MatrixClient } from 'matrix-js-sdk';
import { logger } from '../logger';

/**
 * Bundle of every external capability the auth flows touch. Real wiring lives in
 * auth.handlers.ts; tests pass a stub of this object.
 */
export interface AuthDeps {
  startConduit(): Promise<{ port: number; baseUrl: string }>;
  createMatrixClient(opts: {
    baseUrl: string;
    userId?: string;
    accessToken?: string;
  }): MatrixClient;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  dbRun(sql: string, ...params: unknown[]): void;
  dbGet<T>(sql: string, ...params: unknown[]): T | undefined;
}

function tokenKey(userId: string): string {
  return `user.${userId}.matrix_token`;
}

/** Subset of Matrix register/login response that we consume. */
interface MatrixAuthResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

/**
 * Narrow an `unknown` Matrix auth payload to the typed fields we depend on.
 * Throws if the payload is not an object or any required field is mistyped,
 * which is the only way to safely consume the untyped SDK return.
 */
function pickAuthFields(raw: unknown): MatrixAuthResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Matrix auth response is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.user_id !== 'string' ||
    typeof r.access_token !== 'string' ||
    typeof r.device_id !== 'string'
  ) {
    throw new Error('Matrix auth response missing or mistyped required fields');
  }
  return { user_id: r.user_id, access_token: r.access_token, device_id: r.device_id };
}

const CURRENT_USER_KEY = 'current_user_id';

/** Register a brand-new user, persist token + current user pointer. */
export async function registerFlow(
  opts: { username: string; password: string },
  deps: AuthDeps,
): Promise<{ userId: string; deviceId: string }> {
  const { baseUrl } = await deps.startConduit();
  const client = deps.createMatrixClient({ baseUrl });

  // sessionId is null (no interactive auth session yet); m.login.dummy is the
  // Conduit-friendly "no auth" flow.
  const raw: unknown = await client.register(opts.username, opts.password, null, {
    type: 'm.login.dummy',
  });
  const response = pickAuthFields(raw);

  await deps.setSecret(tokenKey(response.user_id), response.access_token);
  deps.dbRun(
    'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
    CURRENT_USER_KEY,
    JSON.stringify(response.user_id),
  );

  logger.info('User registered', { userId: response.user_id });
  return { userId: response.user_id, deviceId: response.device_id };
}

/** Log in an existing user, persist token + current user pointer. */
export async function loginFlow(
  opts: { username: string; password: string },
  deps: AuthDeps,
): Promise<{ userId: string; deviceId: string }> {
  const { baseUrl } = await deps.startConduit();
  const client = deps.createMatrixClient({ baseUrl });

  const raw: unknown = await client.login('m.login.password', {
    user: opts.username,
    password: opts.password,
    initial_device_display_name: 'AgentPlatform Desktop',
  });
  const response = pickAuthFields(raw);

  await deps.setSecret(tokenKey(response.user_id), response.access_token);
  deps.dbRun(
    'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
    CURRENT_USER_KEY,
    JSON.stringify(response.user_id),
  );

  logger.info('User logged in', { userId: response.user_id });
  return { userId: response.user_id, deviceId: response.device_id };
}

/**
 * Resolve the current user from DB + keychain. Returns null in three cases:
 *  - no `current_user_id` row in kv_store (never logged in / logged out)
 *  - row exists but the keychain token was wiped (treat as logged out)
 *  - row exists and token present -> return user
 */
export async function getCurrentUserFlow(
  deps: AuthDeps,
): Promise<{ userId: string; accessToken: string } | null> {
  const stored = deps.dbGet<{ value: string }>(
    'SELECT value FROM kv_store WHERE key = ?',
    CURRENT_USER_KEY,
  );
  if (!stored) return null;
  const userId: string = JSON.parse(stored.value);
  const accessToken = await deps.getSecret(tokenKey(userId));
  if (!accessToken) return null;
  return { userId, accessToken };
}

/** Forget the current user: delete the token + DB pointer. Idempotent. */
export async function logoutFlow(deps: AuthDeps): Promise<void> {
  const current = await getCurrentUserFlow(deps);
  if (!current) return;
  await deps.deleteSecret(tokenKey(current.userId));
  deps.dbRun('DELETE FROM kv_store WHERE key = ?', CURRENT_USER_KEY);
  logger.info('User logged out', { userId: current.userId });
}
