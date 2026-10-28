// electron/tests/util/profile-scope.test.ts
//
// deriveProfileScopeSuffix 纯函数契约（D2 用例随 M3.0 T5 上提迁移，原
// tests/hub/creds.test.ts 的 deriveDeviceTokenScopeSuffix describe 更名而来，
// 断言逐条等价）：默认路径 → ''（裸服务名向后兼容）；隔离路径 → sha256
// 完整规范化路径前 8 位 hex（全路径 hash 防 basename 碰撞）。
import { describe, it, expect } from 'vitest';
import { deriveProfileScopeSuffix } from '../../src/main/util/profile-scope';

describe('deriveProfileScopeSuffix（作用域派生纯函数，D2 + fix round 1 全路径派生）', () => {
  // 默认 userData 全路径形态（<appData>/<app.name>）——第二参即默认全路径
  const DEFAULT_UD = '/Users/tom/Library/Application Support/Momo Studio';

  it('默认 userData 全路径 → 空后缀（单实例常态，裸服务名向后兼容）', () => {
    expect(deriveProfileScopeSuffix(DEFAULT_UD, DEFAULT_UD)).toBe('');
  });

  it('非默认路径 → sha256 前 8 位 hex，同路径稳定可复现', () => {
    const a = deriveProfileScopeSuffix('/tmp/qa-run-A/profile', DEFAULT_UD);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(deriveProfileScopeSuffix('/tmp/qa-run-A/profile', DEFAULT_UD)).toBe(a);
  });

  it('验收形态（--user-data-dir=$RUN_DIR/profile）：同 basename 不同父目录 → 不同后缀（同名隔离目录互撞回归锁）', () => {
    // fix 前：hash basename → 两实例同得后缀 hash('profile')，共享同一作用域，
    // 后 enroll 覆盖前者（D5 复发于隔离实例间——M2 多节点验收正是此形态）
    const a = deriveProfileScopeSuffix('/tmp/qa-run-A/profile', DEFAULT_UD);
    const b = deriveProfileScopeSuffix('/tmp/qa-run-B/profile', DEFAULT_UD);
    expect(a).not.toBe(b);
  });

  it('边角：隔离目录恰名「Momo Studio」（非默认父目录）→ 仍得非空后缀（不直读默认裸服务名）', () => {
    // fix 前（basename 判定）：与默认目录同名 → '' 空后缀，直读默认实例凭证且无 warn
    const s = deriveProfileScopeSuffix('/tmp/qa-run-A/Momo Studio', DEFAULT_UD);
    expect(s).toMatch(/^[0-9a-f]{8}$/);
  });
});
