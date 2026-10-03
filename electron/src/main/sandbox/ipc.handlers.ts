// electron/src/main/sandbox/ipc.handlers.ts
// sandbox 命名空间 IPC（spec §6.5）：状态/重探测/装 bwrap/关提示卡。
// 设置读写走既有 settings:getGlobal/updateGlobal（不新增通道）。
// 2026-09-13 修订 B：ask 信任门下线——sandbox:answerNetworkTrust 应答通道与
// sandbox:notice 推送通道一并移除（无生产者也无消费者）。
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
import { getSandboxSettings, type NetworkPolicy } from './settings';
import { detectPackageManager } from './windows';
import { grantWriteDirs, revokeWriteDir, listWorkspaceGrants } from './write-grant';
import { sendUserMessage } from '../im/session-service';
import { broadcastWriteGrantDenied } from '../agent/runtime-registry';
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

/**
 * dismissPrompt 的 kind → kv_store key 映射表。
 * 改用查表保证新加 kind 时编译期友好 + 隔离 case 隔离（双侧契约锁一致）。
 * 2026-10-03：toolchain 键随事件驱动授权卡退役（写拦截卡不再用一次性 KV flag）。
 */
const PROMPT_KV: Record<'bwrap' | 'winPolicy' | 'netOff', string> = {
  bwrap: KV_BWRAP,
  winPolicy: KV_WINPOLICY,
  netOff: KV_NETOFF,
};

function readKvFlag(key: string): boolean {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function buildInfo(): SandboxInfo {
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

export function registerSandboxIpc(): void {
  ipcMain.handle('sandbox:getState', () => buildInfo());
  ipcMain.handle('sandbox:reprobe', async () => {
    await reprobeSandbox();
    return buildInfo();
  });
  ipcMain.handle('sandbox:installBwrap', () => installBwrapViaPkexec());
  ipcMain.handle('sandbox:dismissPrompt', (_e, kind: 'bwrap' | 'winPolicy' | 'netOff') => {
    const key = PROMPT_KV[kind];
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, '1', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
      )
      .run(key);
  });
  /**
   * 通用写授权（spec 2026-10-03 §6.3）：授权卡三按钮的两档写入通道。scope 键控
   * KV 两键（session=单个聊天会话持久 / workspace=工作空间持久）；dirs 为卡上
   * 展示的归一目录（显示即所授）。载荷形状逐字段校验——防 scope 越界 / 空键
   * 串写其他实体。
   * resumeSessionId（GUI 验收 2026-10-03 第四轮）：授权成功后向该会话注入一条
   * owner 身份的系统唤醒消息（kickoff 语义：跳过冲突检测/#T 激活）——经
   * sendUserChat 路由到接待 agent 自动重试被拦命令，用户无需手打「继续」。
   * fire-and-forget：唤醒失败只留日志，不影响授权结果返回。
   */
  ipcMain.handle('sandbox:grantWrite', (_e, arg: unknown) => {
    const a = arg as { scope?: unknown; key?: unknown; dirs?: unknown; resumeSessionId?: unknown };
    if (a.scope !== 'session' && a.scope !== 'workspace') throw new Error('scope 非法');
    if (typeof a.key !== 'string' || a.key === '') throw new Error('key 缺失');
    if (!Array.isArray(a.dirs) || a.dirs.some((d) => typeof d !== 'string')) throw new Error('dirs 非法');
    grantWriteDirs(a.scope, a.key, a.dirs);
    logger.info('写授权已授予', { scope: a.scope, key: a.key, count: a.dirs.length });
    if (typeof a.resumeSessionId === 'string' && a.resumeSessionId !== '') {
      const scopeLabel = a.scope === 'session' ? '本会话' : '本工作空间（持久）';
      void sendUserMessage({
        sessionId: a.resumeSessionId,
        body: `【授权完成】用户已通过授权卡放行以下目录（${scopeLabel}）：\n${a.dirs.map((d) => `- ${d}`).join('\n')}\n请重试此前被沙箱拦截的命令，继续完成任务。`,
        systemKickoff: true,
      }).catch((err: unknown) => {
        logger.warn('授权唤醒消息注入失败（授权本身已生效）', {
          sessionId: a.resumeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  /**
   * 写授权拒绝（spec hard-gate §4.3）：卡「拒绝」/「X 关闭」→ 广播解除等待中的
   * 工具调用。无状态转发（匹配在子进程侧）；载荷校验风格照 grantWrite。
   */
  ipcMain.handle('sandbox:denyWrite', (_e, arg: unknown) => {
    handleDenyWrite(arg, broadcastWriteGrantDenied);
  });

  /** 设置页「已授权目录」列表（spec §8） */
  ipcMain.handle('sandbox:listWriteGrants', () => listWorkspaceGrants());

  /** 撤销单条（spec §8 设置页「已授权目录」） */
  ipcMain.handle('sandbox:revokeWrite', (_e, arg: unknown) => {
    const a = arg as { scope?: unknown; key?: unknown; dir?: unknown };
    if (a.scope !== 'session' && a.scope !== 'workspace') throw new Error('scope 非法');
    if (typeof a.key !== 'string' || a.key === '') throw new Error('key 缺失');
    if (typeof a.dir !== 'string') throw new Error('dir 缺失');
    revokeWriteDir(a.scope, a.key, a.dir);
    logger.info('写授权已撤销', { scope: a.scope, key: a.key });
  });
  logger.info('Sandbox IPC handlers 已注册');
}

/** sandbox:denyWrite 载荷处理（纯函数——ipcMain 壳的测试面） */
export function handleDenyWrite(
  arg: unknown,
  broadcast: (dirs: string[]) => void,
): void {
  const a = arg as { sessionId?: unknown; dirs?: unknown };
  if (a.sessionId !== null && typeof a.sessionId !== 'string') throw new Error('sessionId 非法');
  if (!Array.isArray(a.dirs) || a.dirs.some((d) => typeof d !== 'string')) throw new Error('dirs 非法');
  broadcast(a.dirs as string[]);
  logger.info('写授权已拒绝（广播解除等待）', { sessionId: a.sessionId, count: (a.dirs as string[]).length });
}
