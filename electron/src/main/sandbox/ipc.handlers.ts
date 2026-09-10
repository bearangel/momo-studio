// electron/src/main/sandbox/ipc.handlers.ts
// sandbox 命名空间 IPC（spec §6.5）：状态/重探测/装 bwrap/关提示卡。
// 设置读写走既有 settings:getGlobal/updateGlobal（不新增通道）。
import { ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import {
  getSandboxState,
  reprobeSandbox,
  defaultRunner,
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
 * pkexec 安装流（spec §6.3）：探测包管理器 → pkexec 装包。pkexec 缺失返回 ok:false。
 * 缺省 runner 复用 probe.ts 的 defaultRunner（2s 超时 + 4KB 截断，语义一致且有界）。
 */
export async function installBwrapViaPkexec(
  runner: CmdRunner = defaultRunner,
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
