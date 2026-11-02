// electron/src/main/sandbox/windows.ts
// Windows 辅助（spec §5.5）：shell 探测（pwsh 优先）/ 执行策略读取 / 命令序言 / 杀树参数 / 包管理器探测。
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

/**
 * PowerShell 命令序言（spec §5.2a）：把控制台输出编码（[Console]::OutputEncoding）
 * 与管道编码（$OutputEncoding）一并钉成 UTF-8，再接原命令；原命令一字不改，
 * 分隔用 '\n' 以便多行命令在报错定位时行号仍可读。
 *
 * 为什么必须钉：Windows PowerShell 5.1 的控制台输出默认跟随系统 ANSI 代码页
 * （zh-CN 即 GBK / CP936），子进程 stdout 因此吐 GBK 字节；而 Momo 侧按 UTF-8
 * 解码（shell-tools 流式解码器），中文内容与 PowerShell 自身报错（如
 * CommandNotFoundException）全成乱码，模型据此误判环境、进而几十轮无效试探。
 * 实测（PS 5.1.19041）：加序言后 PS 自身中文、node 输出中文、
 * CommandNotFoundException 报错三者均正常。
 *
 * 刻意不做的事：不改 `>` / `Out-File` / `Set-Content` 的写文件编码（PS 5.1
 * 只能写带 BOM 的 UTF-8，会炸下游 JSON 解析），写文件规范由工具描述告知模型。
 */
export function buildWindowsCommandLine(command: string): string {
  return `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n${command}`;
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
