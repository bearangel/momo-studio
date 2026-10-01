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
import { DEFAULT_TOOLCHAIN_DIRS } from './toolchain-grant';

/** 网络出站双态策略（修订 B）：deny 一律禁网 / allow 全放行（默认） */
export type NetworkPolicy = 'deny' | 'allow';

/** 工具链目录写入双态（v2.5）：deny 默认 / allow 永久允许 */
export type ToolchainPolicy = 'deny' | 'allow';

export interface SandboxSettings {
  mode: SandboxMode;
  networkPolicy: NetworkPolicy;
  /** 工具链目录写入双态（本设计）：deny 默认 / allow 永久 */
  toolchainPolicy: ToolchainPolicy;
  /** 可授权目录清单（字面形态，展开归一在消费侧 expandToolchainDirs） */
  toolchainDirs: string[];
}

let testOverride: SandboxSettings | null = null;

export function __setSandboxSettingsForTest(s: SandboxSettings | null): void {
  testOverride = s;
}

export function getSandboxSettings(): SandboxSettings {
  if (testOverride) return { ...testOverride };
  const g = getGlobalSettings();
  const mode: SandboxMode = g.sandboxMode === 'permissive' ? 'permissive' : 'strict';
  // 工具链策略：默认安全方向 deny——非法值/缺省一律 deny，不做懒迁移写回
  // （deny 即期望值，无需回写污染 JSON）。字面允许值才透传 allow。
  const toolchainPolicy: ToolchainPolicy =
    g.sandboxToolchainPolicy === 'allow' ? 'allow' : 'deny';
  // 目录清单：合法数组才透传；非数组/空数组一律用默认五项兜底（用户清空
  // 也视为「用默认」——保持最小授权集存在）。
  const toolchainDirs: string[] = Array.isArray(g.sandboxToolchainDirs) && g.sandboxToolchainDirs.length > 0
    ? g.sandboxToolchainDirs
    : [...DEFAULT_TOOLCHAIN_DIRS];
  if (g.sandboxNetworkPolicy === 'deny') {
    return { mode, networkPolicy: 'deny', toolchainPolicy, toolchainDirs };
  }
  if (g.sandboxNetworkPolicy === 'allow') {
    return { mode, networkPolicy: 'allow', toolchainPolicy, toolchainDirs };
  }
  // 懒迁移（修订 B）：遗留 'ask'（三态时代值）/ 非法脏值 / 旧布尔键（true 与
  // false 均同向——旧语义 false→ask，而 ask 已并入 allow，故布尔两值殊途同归）/
  // 全缺省（新装）一律收敛 'allow'，写回新键、旧键留存（回滚安全）。写失败
  // 不阻断读取——下次读取再试，绝不因迁移抛错。
  try {
    updateGlobalSettings({ sandboxNetworkPolicy: 'allow' });
  } catch {
    // 迁移写失败（DB 异常等）：按推导值继续返回
  }
  return { mode, networkPolicy: 'allow', toolchainPolicy, toolchainDirs };
}
