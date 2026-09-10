// electron/src/main/sandbox/policy.ts
// platform 无关策略构造。所有路径 realpathSync 解析：符号链接归一后注入
// Seatbelt/bwrap 参数才不会被「路径别名」绕过（如 /var → /private/var）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellSandboxPolicy } from './types';

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** 敏感目录清单（spec §5.3/§5.4）：读 deny / tmpfs 覆盖隐藏。 */
function sensitiveCandidates(home: string): string[] {
  const base = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.config', 'gcloud'),
  ];
  if (process.platform === 'darwin') base.push(path.join(home, 'Library', 'Keychains'));
  return base;
}

export function buildPolicy(workspaceDir: string, networkEnabled: boolean): ShellSandboxPolicy {
  const home = realpath(os.homedir());
  return {
    workspaceDir: realpath(workspaceDir),
    homeDir: home,
    tmpDir: realpath(os.tmpdir()),
    // 只保留真实存在的目录：bwrap --tmpfs 挂不存在路径会直接报错
    sensitiveDirs: sensitiveCandidates(home).filter((d) => fs.existsSync(d)),
    networkEnabled,
  };
}
