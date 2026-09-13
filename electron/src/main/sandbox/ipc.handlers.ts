// electron/src/main/sandbox/ipc.handlers.ts
// sandbox 命名空间 IPC（spec §6.5）：状态/重探测/装 bwrap/关提示卡。
// 设置读写走既有 settings:getGlobal/updateGlobal（不新增通道）。
// v2.4.x（spec 2026-09-13 §5）：新增 sandbox:answerNetworkTrust（信任卡三值
// 应答）+ sandbox:notice m→r 推送（net-trust-request 信任卡）；信任门单例经
// initNetworkTrustGate 在此接线（readPolicy/persistAlways 走设置真实现）。
import { spawn } from 'node:child_process';
import { BrowserWindow, ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { updateGlobalSettings } from '../settings/crud';
import {
  getSandboxState,
  reprobeSandbox,
  type SandboxProbeState,
  type CmdRunner,
} from './probe';
import { getSandboxSettings, type NetworkPolicy } from './settings';
import { detectPackageManager } from './windows';
import {
  initNetworkTrustGate,
  getNetworkTrustGate,
  type NetworkTrustNotice,
} from './network-trust';
import type { SandboxMode } from './types';

export interface SandboxInfo {
  state: SandboxProbeState | null;
  settings: { mode: SandboxMode; networkPolicy: NetworkPolicy };
  installCommand: string | null;
  bwrapPromptDismissed: boolean;
  winPolicyPromptDismissed: boolean;
  /** net-off 拦截提示卡是否已关闭（v2.4.x：agent bash 命令被沙箱断网拦截时的引导卡） */
  netPromptDismissed: boolean;
}

const KV_BWRAP = 'sandbox_bwrap_prompt_dismissed';
const KV_WINPOLICY = 'sandbox_win_policy_prompt_dismissed';
const KV_NETOFF = 'sandbox_net_prompt_dismissed';

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
    netPromptDismissed: readKvFlag(KV_NETOFF),
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

/**
 * 信任卡 m→r 推送：懒查首个窗口（注册先于窗口创建的 boot 顺序无关性——
 * window-ipc getWin 同款模式）。窗口不在场时静默丢弃（等待侧 180s 超时兜底收敛）。
 */
function sendNetworkTrustNotice(n: NetworkTrustNotice): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents?.send('sandbox:notice', n);
}

export function registerSandboxIpc(): void {
  // 信任门接线（重复调用=替换单例——boot 幂等）：读策略走设置真实现（含懒迁移），
  // always 持久化落 settings kv（新键 sandboxNetworkPolicy）
  initNetworkTrustGate({
    readPolicy: () => getSandboxSettings().networkPolicy,
    persistAlways: () => {
      updateGlobalSettings({ sandboxNetworkPolicy: 'allow' });
    },
    pushNotice: sendNetworkTrustNotice,
  });
  ipcMain.handle('sandbox:getState', () => buildInfo());
  ipcMain.handle('sandbox:reprobe', async () => {
    await reprobeSandbox();
    return buildInfo();
  });
  ipcMain.handle('sandbox:installBwrap', () => installBwrapViaPkexec());
  ipcMain.handle('sandbox:dismissPrompt', (_e, kind: 'bwrap' | 'winPolicy' | 'netOff') => {
    const key =
      kind === 'bwrap' ? KV_BWRAP : kind === 'winPolicy' ? KV_WINPOLICY : KV_NETOFF;
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, '1', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
      )
      .run(key);
  });
  // 信任卡三值应答（镜像 browser:answerTrust，spec §5 IPC）：迟到应答（无 pending
  // 等待）在 gate.answer 内 no-op——此处不重复判定。入参做最小运行时校验（IPC
  // 无类型边界），非法值抛中文 Error（invoke 拒绝，UI 直接呈现）。
  ipcMain.handle(
    'sandbox:answerNetworkTrust',
    (_e, streamSessionId: unknown, answer: unknown) => {
      if (typeof streamSessionId !== 'string' || streamSessionId === '') {
        throw new Error('sandbox:answerNetworkTrust 参数 streamSessionId 必须为非空字符串');
      }
      if (answer !== 'session' && answer !== 'always' && answer !== 'deny') {
        throw new Error('sandbox:answerNetworkTrust 应答必须是 session / always / deny');
      }
      getNetworkTrustGate()?.answer(streamSessionId, answer);
    },
  );
  logger.info('Sandbox IPC handlers 已注册');
}
