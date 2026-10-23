// device token 凭证——keychain 专用通道（测试经 setKeychainImpl 注入，keychain.ts 既有钩子）。
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';

const TOKEN_KEY = 'hub.deviceToken';

export async function getDeviceToken(): Promise<string | null> { return getSecret(TOKEN_KEY); }
export async function setDeviceToken(token: string): Promise<void> { await setSecret(TOKEN_KEY, token); }
export async function clearDeviceToken(): Promise<void> { await deleteSecret(TOKEN_KEY); }
