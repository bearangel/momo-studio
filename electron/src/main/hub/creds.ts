// device token 凭证——keychain 专用通道（测试经 setKeychainImpl 注入，keychain.ts 既有钩子）。
//
// D2（M2 Task 1）：实例作用域键。同机多实例（隔离 userData 目录，如验收/开发并行
// profile）共享同一 OS keychain——固定裸键会让 A 实例读到 B 实例的 token（节点身份
// 错乱，M1 验收 D5 根因）。修法：token 键加由 userData 目录名稳定派生的后缀；
// 默认单实例后缀为空 = 裸键（既有凭证向后兼容）。作用域注入参照 keychain.ts 的
// setKeychainImpl 形态（本模块不 import Electron——派生是纯函数，接线在 hub/index.ts
// wireHubCredsScope，app ready 后任何 hub 读写前调用）。
//
// 迁移裁定（简化，报告注明）：不做跨键迁移。非默认实例视为新身份重新 enroll——
// 启动取 token 时若作用域键缺失而旧裸键存在，只 warn 一次引导重新接入（不自动
// 迁移/吞读，避免他实例误占默认实例凭证）；默认实例（后缀空）直接沿用裸键。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';
import { logger } from '../logger';

const TOKEN_KEY_BASE = 'hub.deviceToken';

/**
 * userData 路径 → token 键作用域后缀（纯函数，可测）。
 * 与默认 userData 全路径（<appData>/<app.name>）相等（path.normalize 后）→ ''
 * （单实例常态，裸键向后兼容）；其余（隔离实例）→ sha256(完整路径) 前 8 位 hex。
 * hash 全路径而非 basename（fix round 1）：验收启动线固定
 * --user-data-dir=$RUN_DIR/profile——basename 同为 profile 的多隔离实例会共享
 * 同一作用域键互撞（后 enroll 覆盖前者）；边角：隔离目录恰与默认目录同名时
 * basename 判定还会误得空后缀直读裸键。
 */
export function deriveDeviceTokenScopeSuffix(userDataPath: string, defaultUserDataPath: string): string {
  const dir = path.normalize(userDataPath);
  if (dir === path.normalize(defaultUserDataPath)) return '';
  return createHash('sha256').update(dir).digest('hex').slice(0, 8);
}

/** 生效中的作用域后缀解析器（生产经 wireHubCredsScope 注入；缺省 '' = 裸键） */
let scopeResolver: () => string = () => '';

/** 注入/复位作用域解析器（null 复位为默认裸键形态） */
export function setDeviceTokenScopeResolver(resolver: (() => string) | null): void {
  scopeResolver = resolver ?? (() => '');
}

function tokenKey(): string {
  const suffix = scopeResolver();
  return suffix ? `${TOKEN_KEY_BASE}.${suffix}` : TOKEN_KEY_BASE;
}

/** 旧裸键 warn-once 标记（避免每次目录拉取都刷屏） */
let legacyBareKeyWarned = false;

export async function getDeviceToken(): Promise<string | null> {
  const key = tokenKey();
  const token = await getSecret(key);
  if (token !== null || key === TOKEN_KEY_BASE) return token;
  // 隔离实例自身无凭证：旧裸键（默认实例的 token）在场也不吞读——只 warn 一次
  // 引导重新接入（迁移裁定见文件头）
  if ((await getSecret(TOKEN_KEY_BASE)) !== null && !legacyBareKeyWarned) {
    legacyBareKeyWarned = true;
    logger.warn(
      '本实例为隔离实例（userData 目录非默认），keychain 中检测到默认实例的 hub 凭证——不自动迁移，请在「设置 → 节点互联」重新接入',
      { scopeKey: key },
    );
  }
  return null;
}

export async function setDeviceToken(token: string): Promise<void> { await setSecret(tokenKey(), token); }
export async function clearDeviceToken(): Promise<void> { await deleteSecret(tokenKey()); }

/** 测试用：复位作用域解析器与 warn-once 标记（隔离用例间状态） */
export function __resetDeviceTokenScopeForTest(): void {
  scopeResolver = () => '';
  legacyBareKeyWarned = false;
}
