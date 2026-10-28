// device token 凭证——keychain 专用通道（测试经 setKeychainImpl 注入，keychain.ts 既有钩子）。
//
// 实例隔离（M3.0 T5）：作用域已上收到 keychain 门面服务名（wireKeychainScope /
// util/profile-scope.ts）——本模块回归裸 'hub.deviceToken' 账户键，键名不再
// 随实例漂移（D2 的账户键作用域形态 setDeviceTokenScopeResolver /
// deriveDeviceTokenScopeSuffix / wireHubCredsScope 同步退役）。
//
// 迁移裁定（沿用 D2，不做跨键迁移）：隔离实例在旧形态写入的
// 'hub.deviceToken.<suffix>' 键落在默认服务名下，服务名分域后本实例读不到
// → 视为新身份重新 enroll（本就一次 enroll 的事）；默认实例（裸服务名）
// 的既有凭证直接沿用，零变化。
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';

const TOKEN_KEY = 'hub.deviceToken';

export async function getDeviceToken(): Promise<string | null> {
  return await getSecret(TOKEN_KEY);
}

export async function setDeviceToken(token: string): Promise<void> {
  await setSecret(TOKEN_KEY, token);
}

export async function clearDeviceToken(): Promise<void> {
  await deleteSecret(TOKEN_KEY);
}
