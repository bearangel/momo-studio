// electron/src/main/sandbox/windows.ts
// Windows 辅助（spec §5.5）：shell 探测（pwsh 优先）/ 执行策略读取 / 杀树参数 / 包管理器探测。
import { existsSync } from 'node:fs';
import type { CmdRunner } from './probe';

export async function detectWindowsShell(runner: CmdRunner): Promise<'pwsh.exe' | 'powershell.exe'> {
  const r = await runner('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  return r.code === 0 ? 'pwsh.exe' : 'powershell.exe';
}

export async function getExecutionPolicy(shell: string, runner: CmdRunner): Promise<string> {
  const r = await runner(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy']);
  return r.code === 0 ? r.stdout.trim().split('\n')[0] || 'Unknown' : 'Unknown';
}

/** Windows 无进程组语义：taskkill /PID <pid> /T /F 杀整树 */
export function buildKillTreeArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

const PKG_MGR: { manager: 'apt' | 'dnf' | 'pacman' | 'zypper'; probe: string; install: string }[] = [
  { manager: 'apt', probe: '/usr/bin/apt-get', install: 'sudo apt install bubblewrap' },
  { manager: 'dnf', probe: '/usr/bin/dnf', install: 'sudo dnf install bubblewrap' },
  { manager: 'pacman', probe: '/usr/bin/pacman', install: 'sudo pacman -S bubblewrap' },
  { manager: 'zypper', probe: '/usr/bin/zypper', install: 'sudo zypper install bubblewrap' },
];

export function detectPackageManager(): { manager: 'apt' | 'dnf' | 'pacman' | 'zypper' | null; installCommand: string | null } {
  for (const m of PKG_MGR) {
    if (existsSync(m.probe)) return { manager: m.manager, installCommand: m.install };
  }
  return { manager: null, installCommand: null };
}
