// electron/src/main/matrix/auth.ts
import type { MatrixClient } from 'matrix-js-sdk';
import { logger } from '../logger';

export interface AuthResult {
  userId: string;
  accessToken: string;
  deviceId: string;
}

/** Subset of Matrix register/login response that we consume. */
interface MatrixAuthResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

function pickAuthFields(raw: unknown): MatrixAuthResponse {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('user_id' in raw) ||
    !('access_token' in raw) ||
    !('device_id' in raw)
  ) {
    throw new Error('Matrix auth response missing required fields');
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.user_id !== 'string' ||
    typeof r.access_token !== 'string' ||
    typeof r.device_id !== 'string'
  ) {
    throw new Error('Matrix auth response fields have wrong type');
  }
  return {
    user_id: r.user_id,
    access_token: r.access_token,
    device_id: r.device_id,
  };
}

export async function registerAdmin(
  client: MatrixClient,
  username: string,
  password: string,
): Promise<AuthResult> {
  logger.info('Registering user', { username });
  const raw: unknown = await client.register(username, password, null, {
    type: 'm.login.dummy',
  });
  const response = pickAuthFields(raw);
  return {
    userId: response.user_id,
    accessToken: response.access_token,
    deviceId: response.device_id,
  };
}

export async function login(
  client: MatrixClient,
  username: string,
  password: string,
): Promise<AuthResult> {
  logger.info('Logging in user', { username });
  const raw: unknown = await client.login('m.login.password', {
    user: username,
    password,
    initial_device_display_name: 'AgentPlatform Desktop',
  });
  const response = pickAuthFields(raw);
  return {
    userId: response.user_id,
    accessToken: response.access_token,
    deviceId: response.device_id,
  };
}

export async function logout(client: MatrixClient): Promise<void> {
  logger.info('Logging out');
  await client.logout();
  await client.stopClient();
}
