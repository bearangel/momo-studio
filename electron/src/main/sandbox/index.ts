// electron/src/main/sandbox/index.ts
// 命令包裹决策（spec §5.2）——shell-tools.ts 的唯一接入点。
// 同步：状态读单例、设置读 kv（sqlite 同步 API）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSandboxState } from './probe';
import { getSandboxSettings } from './settings';
import { buildPolicy } from './policy';
import { buildBwrapArgs } from './linux';
import { renderSeatbeltProfile } from './macos';
import type { SpawnPlan } from './types';

/** wrapped 模式缓存 env：npm/pip 缓存重定向到 tmp（写剖面自洽，spec §5.7） */
function cacheEnvAdditions(tmpDir: string): Record<string, string> {
  return {
    npm_config_cache: path.join(tmpDir, 'npm-cache'),
    PIP_CACHE_DIR: path.join(tmpDir, 'pip-cache'),
  };
}

/**
 * blocked 文案的平台安装指引（darwin 为系统内置 Seatbelt，指引是排查方向而非
 * 安装命令——主机验收修复：macOS 曾被展示 apt/bubblewrap 指引）。纯函数供单测锁分支。
 */
export function sandboxInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'macOS 沙箱（Seatbelt/sandbox-exec）为系统内置，无需安装；若探测失败请检查系统完整性保护（SIP）与 sandbox-exec 可用性；也可在 设置→安全沙箱 切换 permissive 模式（无 OS 隔离，不推荐）';
  }
  return 'Linux 安装：sudo apt install bubblewrap（或对应发行版包管理器）；也可在 设置→安全沙箱 切换 permissive 模式（无 OS 隔离，不推荐）';
}

export function resolveShellSpawn(workspaceDir: string, command: string): SpawnPlan {
  const settings = getSandboxSettings();
  const policy = buildPolicy(workspaceDir, settings.networkEnabled);

  if (process.platform === 'win32') {
    const shell = getSandboxState()?.windowsShell ?? 'powershell.exe';
    // 刻意不带 -ExecutionPolicy Bypass：保留用户手动授权闸门（spec D5）
    return { kind: 'plain', shell, args: ['-NoProfile', '-NonInteractive', '-Command', command], tag: 'win-powershell' };
  }

  const state = getSandboxState();
  if (process.platform === 'linux' && state?.sandboxTool === 'bwrap') {
    return {
      kind: 'wrapped', shell: 'bwrap',
      args: [...buildBwrapArgs(policy), '/bin/bash', '-c', command],
      tag: 'bwrap', envAdditions: cacheEnvAdditions(policy.tmpDir), cleanupFiles: [],
    };
  }
  if (process.platform === 'darwin' && state?.sandboxTool === 'seatbelt') {
    const profilePath = path.join(os.tmpdir(), `momo-sb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`);
    fs.writeFileSync(profilePath, renderSeatbeltProfile(policy), 'utf-8');
    return {
      kind: 'wrapped', shell: 'sandbox-exec',
      // -f 从文件读 profile（-p 会把参数整串当 SBPL 源码解析——传路径即
      // 「unbound variable」exit 65，macOS 主机实测；probe 冒烟的 -p 是内联字符串，语义不同）
      args: ['-f', profilePath, '/bin/bash', '-c', command],
      tag: 'seatbelt', envAdditions: cacheEnvAdditions(policy.tmpDir), cleanupFiles: [profilePath],
    };
  }

  const reason = state?.unavailableReason ?? '沙箱未探测';
  if (settings.mode === 'strict') {
    return {
      kind: 'blocked',
      reason: `OS 沙箱不可用（${reason}）。${sandboxInstallHint(process.platform)}`,
    };
  }
  return { kind: 'plain', shell: '/bin/bash', args: ['-c', command], tag: `unsandboxed:${reason}` };
}

export { __setSandboxStateForTest, getSandboxState, reprobeSandbox } from './probe';
export type { SandboxProbeState, CmdRunner } from './probe';
export { __setSandboxSettingsForTest, getSandboxSettings } from './settings';
export type { SpawnPlan, ShellSandboxPolicy, SandboxMode } from './types';
