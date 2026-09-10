// electron/src/main/sandbox/ipc.handlers.ts
// sandbox 命名空间 IPC（spec §6.5）：状态/重探测/装 bwrap/关提示卡。
// 设置读写走既有 settings:getGlobal/updateGlobal（不新增通道）。
import { spawn } from 'node:child_process';
import { ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import {
  getSandboxState,
  reprobeSandbox,
  type SandboxProbeState,
  type CmdRunner,
} from './probe';
import { getSandboxSettings } from './settings';
import { detectPackageManager } from './windows';
import type { SandboxMode } from './types';

export interface SandboxInfo {
  state: SandboxProbeState | null;
  settings: { mode: SandboxMode; networkEnabled: boolean };
  installCommand: string | null;
  bwrapPromptDismissed: boolean;
  winPolicyPromptDismissed: boolean;
}

const KV_BWRAP = 'sandbox_bwrap_prompt_dismissed';
const KV_WINPOLICY = 'sandbox_win_policy_prompt_dismissed';

function readKvFlag(key: string): boolean {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

function buildInfo(): SandboxInfo {
  return {
    state: getSandboxState(),
    settings: getSandboxSettings(),
    installCommand: detectPackageManager().installCommand,
    bwrapPromptDismissed: readKvFlag(KV_BWRAP),
    winPolicyPromptDismissed: readKvFlag(KV_WINPOLICY),
  };
}

/**
 * 装包专用 runner：pkexec 含 polkit 密码弹窗 + 包下载，秒~分钟级——120s 超时（探测用的
 * defaultRunner 是 2s，语义不同不可复用——否则首启一键安装必然被 2s SIGKILL 杀掉）。
 * 形态照抄 probe.ts 的 defaultRunner（spawn + 超时 SIGKILL + 4KB 截断），仅超时改为 120_000。
 */
const installRunner: CmdRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 120_000);
    child.stdout?.on('data', (c: Buffer) => { if (out.length < 4096) out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { if (err.length < 4096) err += c.toString('utf-8'); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout: out, stderr: e.message }); });
  });

/**
 * pkexec 安装流（spec §6.3）：探测包管理器 → pkexec 装包。pkexec 缺失返回 ok:false。
 * 缺省 runner 用装包专用 installRunner（120s 超时，与 2s 探测语义分离）。
 * 签名保留可选注入参数——测试继续注入 fake runner。
 */
export async function installBwrapViaPkexec(
  runner: CmdRunner = installRunner,
): Promise<{ ok: boolean; output: string }> {
  const { manager } = detectPackageManager();
  if (!manager) {
    return { ok: false, output: '未识别的包管理器（支持 apt/dnf/pacman/zypper），请手动安装 bubblewrap' };
  }
  const installArgs =
    manager === 'apt' ? ['apt-get', 'install', '-y', 'bubblewrap']
    : manager === 'dnf' ? ['dnf', 'install', '-y', 'bubblewrap']
    : manager === 'pacman' ? ['pacman', '-S', '--noconfirm', 'bubblewrap']
    : ['zypper', '--non-interactive', 'install', 'bubblewrap'];
  const r = await runner('pkexec', installArgs);
  const ok = r.code === 0;
  logger.info('bwrap 安装流程结束', { manager, ok });
  return {
    ok,
    output: (r.stdout + '\n' + r.stderr).trim().slice(0, 2000) || (ok ? '安装成功' : '安装失败'),
  };
}

export function registerSandboxIpc(): void {
  ipcMain.handle('sandbox:getState', () => buildInfo());
  ipcMain.handle('sandbox:reprobe', async () => {
    await reprobeSandbox();
    return buildInfo();
  });
  ipcMain.handle('sandbox:installBwrap', () => installBwrapViaPkexec());
  ipcMain.handle('sandbox:dismissPrompt', (_e, kind: 'bwrap' | 'winPolicy') => {
    const key = kind === 'bwrap' ? KV_BWRAP : KV_WINPOLICY;
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, '1', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
      )
      .run(key);
  });
  logger.info('Sandbox IPC handlers 已注册');
}
