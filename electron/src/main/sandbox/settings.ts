// electron/src/main/sandbox/settings.ts
// 沙箱设置读取（单一真相源：GlobalSettings kv JSON）。测试钩子优先于 DB——
// shell-tools 单测无 DB fixture 时经 __setSandboxSettingsForTest 注入。
//
// 2026-09-13 修订 B（spec 修订记录）：networkPolicy 三态（deny/ask/allow）收敛
// 双态（deny/allow，默认 allow）。读时懒迁移：遗留 'ask' 值与旧布尔键
// sandboxNetwork（true/false 两值同向——双态新默认即 allow）一律重写为 'allow'
// 并写回新键，旧键留存不删（回滚安全）。
import { getGlobalSettings, updateGlobalSettings } from '../settings/crud';
import type { SandboxMode } from './types';

/** 网络出站双态策略（修订 B）：deny 一律禁网 / allow 全放行（默认） */
export type NetworkPolicy = 'deny' | 'allow';

export interface SandboxSettings {
  mode: SandboxMode;
  networkPolicy: NetworkPolicy;
}

let testOverride: SandboxSettings | null = null;

export function __setSandboxSettingsForTest(s: SandboxSettings | null): void {
  testOverride = s;
}

export function getSandboxSettings(): SandboxSettings {
  if (testOverride) return { ...testOverride };
  const g = getGlobalSettings();
  const mode: SandboxMode = g.sandboxMode === 'permissive' ? 'permissive' : 'strict';
  if (g.sandboxNetworkPolicy === 'deny') return { mode, networkPolicy: 'deny' };
  if (g.sandboxNetworkPolicy === 'allow') return { mode, networkPolicy: 'allow' };
  // 懒迁移（修订 B）：遗留 'ask'（三态时代值）/ 非法脏值 / 旧布尔键（true 与
  // false 均同向——旧语义 false→ask，而 ask 已并入 allow，故布尔两值殊途同归）/
  // 全缺省（新装）一律收敛 'allow'，写回新键、旧键留存（回滚安全）。写失败
  // 不阻断读取——下次读取再试，绝不因迁移抛错。
  try {
    updateGlobalSettings({ sandboxNetworkPolicy: 'allow' });
  } catch {
    // 迁移写失败（DB 异常等）：按推导值继续返回
  }
  return { mode, networkPolicy: 'allow' };
}
