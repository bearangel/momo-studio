// electron/src/main/util/profile-scope.ts
//
// 实例 profile 作用域派生（M3.0 T5，自 hub/creds.ts 上提共享——原 D2
// deriveDeviceTokenScopeSuffix 更名）：同机多实例（隔离 userData 目录，如
// 验收/开发并行 profile）共享同一 OS keychain，固定服务名会让实例间凭证
// 互串（节点身份错乱，M1 验收 D5 根因）。作用域后缀由 userData 全路径稳定
// 派生，消费点在 keychain.ts 门面（服务名分域，见 wireKeychainScope）。
//
// 纯函数、Electron-free（接线在 storage/keychain.ts，boot 时 main/index.ts
// 调用）——派生可独立单测。

import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * userData 路径 → 实例作用域后缀（'' = 默认实例，裸服务名向后兼容）。
 * 与默认 userData 全路径（<appData>/<app.name>）相等（path.normalize 后）
 * → ''；其余（隔离实例）→ sha256(完整规范化路径) 前 8 位 hex。
 * hash 全路径而非 basename（D2 fix round 1 裁定）：验收启动线固定
 * --user-data-dir=$RUN_DIR/profile——basename 同为 profile 的多隔离实例
 * 会共享同一作用域互撞（后写覆盖前者）；边角：隔离目录恰与默认目录同名时
 * basename 判定还会误得空后缀直读裸服务名。
 */
export function deriveProfileScopeSuffix(userDataPath: string, defaultUserDataPath: string): string {
  const dir = path.normalize(userDataPath);
  if (dir === path.normalize(defaultUserDataPath)) return '';
  return createHash('sha256').update(dir).digest('hex').slice(0, 8);
}
