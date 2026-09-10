// electron/src/main/sandbox/settings.ts
// 沙箱设置读取（单一真相源：GlobalSettings kv JSON）。测试钩子优先于 DB——
// shell-tools 单测无 DB fixture 时经 __setSandboxSettingsForTest 注入。
import { getGlobalSettings } from '../settings/crud';
import type { SandboxMode } from './types';

export interface SandboxSettings {
  mode: SandboxMode;
  networkEnabled: boolean;
}

let testOverride: SandboxSettings | null = null;

export function __setSandboxSettingsForTest(s: SandboxSettings | null): void {
  testOverride = s;
}

export function getSandboxSettings(): SandboxSettings {
  if (testOverride) return { ...testOverride };
  const g = getGlobalSettings();
  return {
    mode: g.sandboxMode === 'permissive' ? 'permissive' : 'strict',
    networkEnabled: g.sandboxNetwork === true,
  };
}
