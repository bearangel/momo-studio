// electron/src/main/oauth/keys.ts
//
// OAuth 密钥键族（spec §6.4）。全部经 storage/keychain 门面，绝不落 SQLite。
// 前缀 oauth. 供 findSecretKeysByPrefix('oauth.') 做整域清理。
// 过期/范围等元数据在 SQLite 行上——本层只存密文。
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';
import type { OAuthTokenSet } from './types';

export function accessTokenKey(connectionId: string): string {
  return `oauth.${connectionId}.access_token`;
}
export function refreshTokenKey(connectionId: string): string {
  return `oauth.${connectionId}.refresh_token`;
}
export function clientSecretKey(connectionId: string): string {
  return `oauth.${connectionId}.client_secret`;
}

export async function saveTokenSet(connectionId: string, set: OAuthTokenSet): Promise<void> {
  await setSecret(accessTokenKey(connectionId), set.accessToken);
  if (set.refreshToken) {
    await setSecret(refreshTokenKey(connectionId), set.refreshToken);
  } else {
    await deleteSecret(refreshTokenKey(connectionId));
  }
}

export async function loadTokenSet(connectionId: string): Promise<OAuthTokenSet | null> {
  const accessToken = await getSecret(accessTokenKey(connectionId));
  if (!accessToken) return null;
  const refreshToken = await getSecret(refreshTokenKey(connectionId));
  return {
    accessToken,
    refreshToken,
    expiresAt: null, // 权威过期时间在 SQLite 行
    tokenType: 'Bearer',
    scope: null,
  };
}

export async function clearTokenSet(connectionId: string): Promise<void> {
  await deleteSecret(accessTokenKey(connectionId));
  await deleteSecret(refreshTokenKey(connectionId));
  await deleteSecret(clientSecretKey(connectionId));
}
