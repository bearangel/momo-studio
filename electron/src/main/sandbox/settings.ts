// electron/src/main/sandbox/settings.ts
// 沙箱设置读取（单一真相源：GlobalSettings kv JSON）。测试钩子优先于 DB——
// shell-tools 单测无 DB fixture 时经 __setSandboxSettingsForTest 注入。
//
// v2.4.x（spec 2026-09-13 §4）：networkEnabled 布尔升级 networkPolicy 三态
// （deny / ask / allow，默认 ask）。迁移策略 = 读时懒迁移：新键缺位时从旧布尔键
// 推导（true→allow，false/缺省→ask）并写回新键，旧键留存不删（回滚安全）。
import { getGlobalSettings, updateGlobalSettings } from '../settings/crud';
import type { SandboxMode } from './types';

/** 网络出站三态策略（spec §2）：deny 全断网 / ask 命中网络拒绝后阻塞询问（默认）/ allow 全放行 */
export type NetworkPolicy = 'deny' | 'ask' | 'allow';

export interface SandboxSettings {
  mode: SandboxMode;
  networkPolicy: NetworkPolicy;
}

const POLICIES: readonly NetworkPolicy[] = ['deny', 'ask', 'allow'];

let testOverride: SandboxSettings | null = null;

export function __setSandboxSettingsForTest(s: SandboxSettings | null): void {
  testOverride = s;
}

/** 枚举收窄：非法/缺省值回退 ask（缺省语义见 spec §4「false/缺省→ask」） */
function parsePolicy(raw: unknown): NetworkPolicy {
  if (typeof raw === 'string' && (POLICIES as readonly string[]).includes(raw)) {
    return raw as NetworkPolicy;
  }
  return 'ask';
}

export function getSandboxSettings(): SandboxSettings {
  if (testOverride) return { ...testOverride };
  const g = getGlobalSettings();
  const mode: SandboxMode = g.sandboxMode === 'permissive' ? 'permissive' : 'strict';
  if (g.sandboxNetworkPolicy !== undefined) {
    return { mode, networkPolicy: parsePolicy(g.sandboxNetworkPolicy) };
  }
  // 懒迁移（spec §4）：旧布尔键 → 三态（true→allow；false/缺省→ask），写回新键、
  // 旧键留存（回滚安全）。写失败不阻断读取——下次读取再试，绝不因迁移抛错。
  const migrated: NetworkPolicy = g.sandboxNetwork === true ? 'allow' : 'ask';
  try {
    updateGlobalSettings({ sandboxNetworkPolicy: migrated });
  } catch {
    // 迁移写失败（DB 异常等）：按推导值继续返回
  }
  return { mode, networkPolicy: migrated };
}
