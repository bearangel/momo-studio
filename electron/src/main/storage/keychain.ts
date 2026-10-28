// electron/src/main/storage/keychain.ts
//
// keychain 门面：全仓凭证（provider key / agent 覆盖 key / plugin 配置 /
// hub deviceToken）唯一咽喉。M3.0 T5 起门面统一实例作用域——后缀加在
// **服务名**而非账户键（keytar 命名空间 = service + account，服务名分域即
// 五族账户键全量隔离）：默认 profile（Electron userData 等于默认全路径）→
// 服务名 'Momo Studio' 完全不变（既有用户凭证零变化）；隔离实例 →
// 'Momo Studio-<hash8>'（deriveProfileScopeSuffix，util/profile-scope.ts）。
// 接线在 main/index.ts boot（wireKeychainScope，任何凭证读写前）。
import type * as Keytar from 'keytar';
import { deriveProfileScopeSuffix } from '../util/profile-scope';
import { logger } from '../logger';

const SERVICE_NAME = 'Momo Studio';

/** keytar 最小消费面形状（服务名 + 账户键 + 值）——测试缝注入点同此形状 */
export type KeytarLike = Pick<typeof Keytar, 'setPassword' | 'getPassword' | 'deletePassword'>;

export interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}

/** 实例作用域后缀（默认 '' = 裸服务名；boot 经 wireKeychainScope 注入） */
let scopeSuffix = '';

/**
 * T5：keychain 实例作用域接线（app ready 后、任何凭证读写前调用一次）。
 * 入参取值而非 app 对象——本模块保持可测（派生纯函数在 util/profile-scope）。
 * 身份源取 Electron `app.getPath('userData')`（跟 --user-data-dir，与实例
 * 实际看到的身份一致）；默认路径 → 空后缀 = 裸服务名（单实例向后兼容）。
 */
export function wireKeychainScope(userDataPath: string, defaultUserDataPath: string): void {
  scopeSuffix = deriveProfileScopeSuffix(userDataPath, defaultUserDataPath);
}

/** 当前生效服务名（作用域后缀在场 = 分域服务名） */
export function keychainServiceName(): string {
  return scopeSuffix ? `${SERVICE_NAME}-${scopeSuffix}` : SERVICE_NAME;
}

/** 测试用：复位作用域后缀为默认裸服务名形态（隔离用例间状态） */
export function __resetKeychainScopeForTest(): void {
  scopeSuffix = '';
}

/** keytar 后端：生产 = lazy require native binding；测试可注入同形状 fake
 *  （fake 收到的 service 参数即作用域后的服务名——T5 分域断言的消费点） */
let keytarBackend: KeytarLike | null = null;

/** 测试缝：注入/复位 keytar 后端（null 复位回 lazy require 生产路径） */
export function setKeytarBackendForTest(backend: KeytarLike | null): void {
  keytarBackend = backend;
}

function loadKeytar(): KeytarLike {
  if (keytarBackend) return keytarBackend;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('keytar') as KeytarLike;
}

class ProductionKeychainImpl implements KeychainImpl {
  // Lazy-loaded: keytar's native binding (libsecret on Linux, Keychain on macOS,
  // CredMan on Windows) may be absent in CI. Defer the require until first use so
  // the module can be imported and the mock-injection hook can be exercised in tests.
  async setSecret(key: string, value: string): Promise<void> {
    await loadKeytar().setPassword(keychainServiceName(), key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return await loadKeytar().getPassword(keychainServiceName(), key);
  }
  async deleteSecret(key: string): Promise<void> {
    await loadKeytar().deletePassword(keychainServiceName(), key);
  }
}

let impl: KeychainImpl = new ProductionKeychainImpl();

export function setKeychainImpl(newImpl: KeychainImpl): void {
  impl = newImpl;
}

/** 测试用：门面实现复位回生产实现（T5 分域用例走真实门面 + fake keytar 后端） */
export function __resetKeychainImplForTest(): void {
  impl = new ProductionKeychainImpl();
}

export async function setSecret(key: string, value: string): Promise<void> {
  logger.debug('setSecret', { key });
  await impl.setSecret(key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  return await impl.getSecret(key);
}

export async function deleteSecret(key: string): Promise<void> {
  logger.debug('deleteSecret', { key });
  await impl.deleteSecret(key);
}
