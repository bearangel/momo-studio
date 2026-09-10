// electron/src/main/sandbox/probe.ts
// 平台探测 + SandboxState 单例。boot 时 fire-and-forget 调 reprobeSandbox()；
// 探测失败不影响 app 启动，只影响 bash 可用性（spec §6.1）。
import { spawn } from 'node:child_process';
import { logger } from '../logger';
import { detectWindowsShell, getExecutionPolicy } from './windows';

export interface SandboxProbeState {
  platform: NodeJS.Platform;
  sandboxTool: 'seatbelt' | 'bwrap' | null;
  toolVersion: string | null;
  available: boolean;
  unavailableReason: string | null;
  windowsShell: string | null;
  executionPolicy: string | null;
  probedAt: number;
}

export type CmdRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** 默认 runner：spawn + 2s 超时 SIGKILL + 输出 4KB 截断 */
export const defaultRunner: CmdRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
    child.stdout?.on('data', (c: Buffer) => { if (out.length < 4096) out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { if (err.length < 4096) err += c.toString('utf-8'); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout: out, stderr: e.message }); });
  });

let cached: SandboxProbeState | null = null;

export function getSandboxState(): SandboxProbeState | null { return cached; }

/** 测试钩子：注入 fake 状态（对齐 memory provider 测试模式）；null 恢复 */
export function __setSandboxStateForTest(s: SandboxProbeState | null): void { cached = s; }

export async function reprobeSandbox(runner: CmdRunner = defaultRunner): Promise<SandboxProbeState> {
  const state: SandboxProbeState = {
    platform: process.platform, sandboxTool: null, toolVersion: null,
    available: false, unavailableReason: null, windowsShell: null,
    executionPolicy: null, probedAt: Date.now(),
  };
  if (process.platform === 'linux') {
    const r = await runner('bwrap', ['--version']);
    if (r.code === 0) {
      state.sandboxTool = 'bwrap';
      state.toolVersion = r.stdout.trim().split('\n')[0] || 'bwrap';
      state.available = true;
    } else {
      state.unavailableReason = 'bwrap 未安装';
    }
  } else if (process.platform === 'darwin') {
    // sandbox-exec 冒烟：跑一个最小 profile 的 true。无 --version 参数。
    const r = await runner('sandbox-exec', ['-p', '(version 1)(allow file-read*)', '/usr/bin/true']);
    if (r.code === 0) {
      state.sandboxTool = 'seatbelt';
      state.available = true;
    } else {
      state.unavailableReason = `sandbox-exec 不可用: ${r.stderr.slice(0, 120)}`;
    }
  } else if (process.platform === 'win32') {
    // Windows 无 OS 沙箱：available=false 是常态（win32 走 plain 路径，不 block）
    state.windowsShell = await detectWindowsShell(runner);
    state.executionPolicy = await getExecutionPolicy(state.windowsShell, runner);
  } else {
    state.unavailableReason = `平台不支持 OS 沙箱: ${process.platform}`;
  }
  cached = state;
  logger.info('沙箱探测完成', { platform: state.platform, tool: state.sandboxTool, available: state.available });
  return state;
}
