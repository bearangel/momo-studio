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
      args: ['-p', profilePath, '/bin/bash', '-c', command],
      tag: 'seatbelt', envAdditions: cacheEnvAdditions(policy.tmpDir), cleanupFiles: [profilePath],
    };
  }

  const reason = state?.unavailableReason ?? '沙箱未探测';
  if (settings.mode === 'strict') {
    return {
      kind: 'blocked',
      reason: `OS 沙箱不可用（${reason}）。Linux 安装：sudo apt install bubblewrap（或对应发行版包管理器）；也可在 设置→安全沙箱 切换 permissive 模式（无 OS 隔离，不推荐）`,
    };
  }
  return { kind: 'plain', shell: '/bin/bash', args: ['-c', command], tag: `unsandboxed:${reason}` };
}

export { __setSandboxStateForTest, getSandboxState, reprobeSandbox } from './probe';
export type { SandboxProbeState, CmdRunner } from './probe';
export { __setSandboxSettingsForTest, getSandboxSettings } from './settings';
export type { SpawnPlan, ShellSandboxPolicy, SandboxMode } from './types';
