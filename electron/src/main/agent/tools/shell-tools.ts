// electron/src/main/agent/tools/shell-tools.ts
// Bash 执行工具：workspace 内自由 shell + 黑名单 + 环境变量白名单 + 截断 + 超时。
//
// 设计要点：
//   - v2.4：OS 沙箱接入（spec §5.2）——spawn 参数经 resolveShellSpawn 三态决策：
//     wrapped（bwrap/sandbox-exec 包裹）/ plain（permissive 降级直跑，结果带
//     unsandboxed 标记）/ blocked（strict 且不可用，spawn 前抛错含安装指引）。
//   - cwd 锁定 ctx.workspaceDir：spawn 直接传 cwd，LLM 无法靠 `cd` 越界；
//     每条命令独立 shell（`bash -c '<cmd>'`），cd 不持久。
//   - 命令黑名单在 spawn 前拦截：rm -rf 根/家目录、mkfs、dd 写设备、fork bomb、
//     改写 /etc/passwd|shadow|sudoers、chmod -R /、关机重启、git commit（强制走
//     git_commit 工具接受 GitPolicy 校验）。命中即抛错，由调用方转成 tool result。
//   - 环境变量白名单：只传 PATH/HOME/USER/... 等基础变量，API key/token 一律
//     不传入子进程；额外注入 WORKSPACE_DIR / MOMO_STUDIO_AGENT。
//   - 输出截断：stdout/stderr 各 10KB（OUTPUT_LIMITS），超长追加截断标记。
//   - 超时：默认 30s，最大 120s，超时 SIGKILL 子进程并返回超时标记；
//     退出码非 0 不抛错，让 LLM 看到 stderr 自我纠正。

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import { OUTPUT_LIMITS } from './shared/output-truncate';
import { createUtf8Collector } from './shared/stream-decode';
import { parseStringArg } from './shared/arg-parse';
import { getSandboxState, resolveShellSpawn } from '../../sandbox';
import { buildKillTreeArgs } from '../../sandbox/windows';
import {
  requestEffectiveNetwork,
  type EffectiveNetworkDecision,
} from './net-trust-bridge';
import {
  detectWriteBlocked,
  extractBlockedPaths,
  isDirCovered,
  normalizeGrantDirs,
  WRITE_BLOCKED_HINT,
} from './sandbox-write-hint';
import { waitForWriteGrant, formatWriteDeniedResult, formatWriteTimeoutResult } from './write-grant-wait';

/**
 * 命令黑名单。每条 = 危险模式 + 命中后给 LLM 的理由。
 * 模式按「具体路径 / 设备 / 系统文件」精确匹配，避免误伤 workspace 内的
 * 同名相对路径操作（如 rm -rf ./dist 不应被拦截）。
 */
const BLACKLIST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // rm -rf / 根目录（裸 / 后必须接空白或行尾，避免误伤 /home 等子路径写法已被其他规则覆盖）
  { pattern: /\brm\s+-[rf]+\s+\/\s*($|\s)/, reason: '禁止 rm -rf / 根目录' },
  // rm -rf /* 通配根下所有
  { pattern: /\brm\s+-[rf]+\s+\/\*/, reason: '禁止 rm -rf /*' },
  // rm -rf ~ / ~/... 家目录
  { pattern: /\brm\s+-[rf]+\s+~/, reason: '禁止 rm -rf 家目录' },
  // mkfs 任意文件系统格式化
  { pattern: /\bmkfs\b/, reason: '禁止 mkfs 格式化' },
  // dd 写块设备（if=... 任意，of=/dev/... 才拦截——读设备不危险）
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: '禁止 dd 写设备' },
  // fork bomb 经典模式 :(){ :|:& };:
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&/, reason: '禁止 fork bomb' },
  // 改写系统账号 / 鉴权文件（> /etc/passwd|shadow|sudoers）
  { pattern: />\s*\/etc\/(passwd|shadow|sudoers)/, reason: '禁止改写系统账号文件' },
  // chmod -R 递归改根权限
  { pattern: /\bchmod\s+-R\s+[0-7]+\s+\/$/, reason: '禁止递归改根权限' },
  // 关机 / 重启
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '禁止关机重启' },
  // git commit 必须走专用 git_commit 工具（走 GitPolicy 校验 + 审计）
  { pattern: /\bgit\s+commit\b/, reason: '禁止 bash 直接 git commit，请用 git_commit 工具（走 GitPolicy 校验）' },
  // ── Windows 危险命令（v2.4，spec §5.5；regex 大小写不敏感场景用 i flag）──
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: '禁止格式化磁盘卷' },
  // 双向语序：flag 在路径前（-Recurse C:\）或路径后（-Path C:\ -Recurse）均拦截；
  // [^|;&]* 限定单条命令内匹配，避免跨命令拼接误伤
  { pattern: /\b(remove-item|rm)\s+(?:[^|;&]*-recurse[^|;&]*[a-z]:\\|[^|;&]*[a-z]:\\[^|;&]*-recurse)/i, reason: '禁止递归删除盘根' },
  { pattern: /\bbcdedit\b/i, reason: '禁止修改启动配置' },
  { pattern: /\bvssadmin\s+delete\s+shadows/i, reason: '禁止删除卷影副本' },
  { pattern: /\breg\s+add\b.*\\run\b/i, reason: '禁止写自启动注册表项' },
];

/**
 * 检查命令是否被黑名单拦截。命中即抛错（错误信息含理由 + 命令前 200 字符预览）。
 * 命令在 spawn 前过此函数，避免危险命令真的进入子进程。
 */
export function assertCommandAllowed(command: string): void {
  for (const { pattern, reason } of BLACKLIST_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`命令被黑名单拦截: ${reason}（命令前 200 字符: ${command.slice(0, 200)}）`);
    }
  }
}

/**
 * posix 白名单（v2.4 原清单，**大小写敏感**比对——语义不许变）。
 * 进程运行必需的 PATH/HOME/USER/... 与本地化相关变量。
 */
const POSIX_ALLOWED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'USERPROFILE',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SHELL', 'TERM',
  'TMPDIR', 'TMP', 'TEMP',
  'SYSTEMROOT', 'WINDIR',
]);

/**
 * win32 白名单（spec 2026-11-02 §5.1）。Windows 环境变量名大小写不敏感，
 * 实际环境里是 `Path` / `SystemRoot`——旧实现按大写比对等于把 PATH 整条丢掉，
 * 子进程解析不到 node / python / npm / git。`PATHEXT` 是 PowerShell 解析外部
 * 程序的必需项，旧清单同样缺失。
 */
const WIN32_ALLOWED_ENV: readonly string[] = [
  'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'PSModulePath', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'PUBLIC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

/** win32 白名单的小写形态（比对用；复制时保留输入环境里的原始大小写） */
const WIN32_ALLOWED_ENV_LOWER = new Set(WIN32_ALLOWED_ENV.map((k) => k.toLowerCase()));

/**
 * win32 固定注入：控制台代码页无关的 UTF-8 输出（Python 默认按 locale 写 cp936
 * 字节 → 按 UTF-8 解码即乱码）。属工具行为设定，非用户可见配置。
 */
const WIN32_FIXED_ENV: NodeJS.ProcessEnv = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
};

/**
 * 构造沙箱环境变量。白名单外的一律不传入子进程——这是
 * 「LLM 看不到主机 API key/token」的核心防线。
 *
 * posix 与 win32 用两份清单：posix 保持大小写敏感（逐字不变），win32 大小写
 * 不敏感且额外注入 UTF-8 变量。两分支末尾都注入 WORKSPACE_DIR（让脚本感知
 * 沙箱根）+ MOMO_STUDIO_AGENT（标记来源）。
 *
 * @param env 源环境，缺省 process.env（测试注入用）
 * @param platform 目标平台，缺省 process.platform（测试注入用）
 */
export function buildSandboxEnv(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      // 大小写不敏感命中；键名按输入的原始大小写复制（Path 仍是 Path）
      if (WIN32_ALLOWED_ENV_LOWER.has(key.toLowerCase())) out[key] = env[key];
    }
    Object.assign(out, WIN32_FIXED_ENV);
  } else {
    for (const key of Object.keys(env)) {
      if (POSIX_ALLOWED_ENV.has(key)) out[key] = env[key];
    }
  }
  out.WORKSPACE_DIR = ctx.workspaceDir;
  out.MOMO_STUDIO_AGENT = '1';
  return out;
}

/** 把 v 钳制到 [min, max] 区间。timeoutMs 越界时归一化到合法范围。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * ShellTools —— bash 工具模块。v1.5 Task 8 引入。
 *
 * 工具名：bash。参数：command（必填）、timeoutMs（可选，默认 30000，最大 120000）。
 * 返回格式：`exit_code: <code>` 开头，后接 stdout / stderr / 超时标记 / 截断标记。
 */
// 类外常量（Tier 划分见 spec §3）：
/** 测试钩子：等待循环替身（spec §12——单测注入受控 covered/timeout 序列） */
type WriteWaitFn = typeof waitForWriteGrant;
let writeWaitOverride: WriteWaitFn | null = null;
export function __setBashWriteWaitForTest(o: { wait?: WriteWaitFn } | null): void {
  writeWaitOverride = o?.wait ?? null;
}

/** 测试钩子：effective 桥替身（非 fork 环境桥不可达——IPC 边界替身非实现替身） */
type NetQueryFn = typeof requestEffectiveNetwork;
let netQueryOverride: NetQueryFn | null = null;
export function __setNetQueryForTest(fn: NetQueryFn | null): void {
  netQueryOverride = fn;
}

/** 等待轮次上限（防病态多目录逐个拦导致 N×120s 拉长；正常两轮内收敛） */
const WRITE_WAIT_MAX_ROUNDS = 3;

const SHELL_CATALOG_META: Record<string, ToolMeta> = {
  bash: { displayName: '终端命令', category: 'Shell', categoryEmoji: '💻', defaultOn: false, riskNote: '任意代码执行' },
};

/**
 * 描述公共部分：参数（command / timeoutMs，见 inputSchema）与返回值格式说明，
 * 逐字沿用原文。平台差异部分由 shellToolDescription 追加在尾部。
 */
const SHELL_DESC_BASE =
  '在 workspace 根目录执行 shell 命令（受 OS 沙箱约束：读全盘但敏感目录不可读、仅可写 workspace 与 /tmp；网络出站按沙箱设置双态——永久允许（默认）/拒绝）。沙箱内无法启动 GUI 应用与系统浏览器（open/LaunchServices 被拒）——需要打开网页时用 browser_navigate 等浏览器工具。30s 超时，stdout+stderr 各截断 10KB。退出码非 0 不抛错。每条命令独立 shell，cd 不持久。后台进程（& 启动）在本回合内可跨命令存活，回合结束时由平台统一回收——不要依赖跨回合的后台服务（下回合需重启）。沙箱内 ps 与 kill 系统调用被拦截（kill -0/pkill 会误报「进程已死/无权限」）：查自己启动的进程用 process_list，判端口占用用 lsof/curl，关闭自己启动的服务用 process_kill（bash 里 kill 必失败）。';

/** 环境变量受限白名单提示（三平台共用，对应 buildSandboxEnv 的白名单实现） */
const SHELL_DESC_ENV_HINT =
  '环境变量是受限白名单：只传 PATH/HOME 等基础变量，不要依赖 PATH 以外的自定义变量（自设的 API key 等取不到，需要时走专用工具）。';

/** win32 写文件标准写法（spec §5.2c 只教不改）——三种 shell 形态共用 */
const WIN32_DESC_WRITE_FILE_HINT =
  '写文本文件（HTML/JSON/CSV/脚本）用无 BOM 的 UTF-8：[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))；不要用 > / Out-File 写文件——不同 PowerShell 版本默认编码不同（PS 5.1 会写成带 BOM 的 UTF-8 或 UTF-16LE），下游工具可能读不了。';

/**
 * win32 的 shell 事实段：按实测 shell 分支，避免对 pwsh 7 硬写「不支持 &&」
 *（sandbox/windows.ts 的 detectWindowsShell 优先 pwsh.exe，pwsh 7 支持 &&）。
 * 探测态为 null（子进程尚未探测）或未知值时给中性文案 + 版本自检指引。
 */
function win32ShellSection(detectedShell: string | null): string {
  if (detectedShell === 'pwsh.exe') {
    return '运行环境是 PowerShell 7（pwsh.exe），不是 bash：支持 && 串联；路径分隔符 \\，反引号是转义符；输出已按 UTF-8 解码；node / python / npm / git 可直接调用。';
  }
  if (detectedShell === 'powershell.exe') {
    return '运行环境是 Windows PowerShell 5.1（不是 bash、不是 pwsh）：串联用 ;，不支持 &&；路径分隔符 \\，反引号是转义符；输出已按 UTF-8 解码；node / python / npm / git 可直接调用。';
  }
  return '运行环境是 Windows PowerShell（不是 bash；具体版本尚未探测）：先跑 $PSVersionTable.PSVersion 确认 shell 版本——主版本 ≥ 7 支持 && 串联，5.1 只能用 ; 串联。路径分隔符 \\，反引号是转义符；输出已按 UTF-8 解码。';
}

/**
 * 按平台 + 实测 shell 生成 bash 工具描述（spec 2026-11-02 §5.5）。
 * 纯函数（平台经参数进入，不读 process.platform）——单测直接锁三分支文案。
 *
 * @param platform 目标平台
 * @param detectedShell 探测到的 win32 shell（'pwsh.exe' / 'powershell.exe' / null=未探测）
 */
export function shellToolDescription(
  platform: NodeJS.Platform,
  detectedShell: string | null,
): string {
  if (platform !== 'win32') {
    return `${SHELL_DESC_BASE}支持 && 串联；外部程序从 PATH 解析。${SHELL_DESC_ENV_HINT}`;
  }
  return `${SHELL_DESC_BASE}${win32ShellSection(detectedShell)}${WIN32_DESC_WRITE_FILE_HINT}${SHELL_DESC_ENV_HINT}`;
}

export class ShellTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [{
      name: 'bash',
      description: shellToolDescription(process.platform, getSandboxState()?.windowsShell ?? null),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整 shell 命令' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000' },
        },
        required: ['command'],
      },
    }];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), SHELL_CATALOG_META);
  }

  handles(name: string): boolean {
    return name === 'bash';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name !== 'bash') throw new Error(`未知 shell 工具: ${name}`);

    const command = parseStringArg(args.command, 'command');
    // timeoutMs：未传或非 number 走默认 30s；越界时 clamp 到 [1s, 120s]。
    const timeoutMs = clamp(typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000, 1000, 120000);

    // 黑名单拦截先于 spawn，命中即抛错（调用方转成 tool result 反馈给 LLM）。
    assertCommandAllowed(command);

    // spec hard-gate §5 硬门控等待：首轮被拦 → 上报主进程（弹授权卡）→ 无限等待
    // （covered 原地重执行 / denied 即时返回 / aborted 随停止按钮）。
    // queryNet 每轮现解析 override（等待回调里可能翻转替身——模拟授权落地）
    let last = await this.bashOnce(command, timeoutMs, ctx);
    for (let round = 0; last.blocked && round < WRITE_WAIT_MAX_ROUNDS; round += 1) {
      // fire-and-forget 上报（proc-group:register 同形态；哨兵门外 no-op——见 internal-event.ts）
      if (process.env.MOMO_RUNTIME_CHILD === '1') {
        process.send?.({
          type: 'write-blocked-report',
          streamSessionId: ctx.streamSessionId,
          workspaceId: ctx.workspaceId,
          dirs: last.dirs,
          command,
        });
      }
      const queryNet = netQueryOverride ?? requestEffectiveNetwork;
      const doWait = writeWaitOverride ?? waitForWriteGrant;
      const wait = await doWait({
        dirs: last.dirs,
        signal: ctx.abortSignal,
        isCovered: async () => {
          try {
            const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
            // spec hard-gate §4.2：toolchainOn 与被拦目录是否放行无关；
            // P1-3：子路径包含（授权父目录覆盖其下路径，与 OS 沙箱 subpath 语义对齐）
            return last.dirs.some((d) => isDirCovered(d, eff.extraDirs));
          } catch {
            return false;
          }
        },
      });
      if (wait.kind === 'aborted') {
        const e = new Error('bash 被中断');
        e.name = 'AbortError';
        throw e;
      }
      if (wait.kind === 'denied') return formatWriteDeniedResult(last.dirs);
      if (wait.kind === 'timeout') return formatWriteTimeoutResult(last.dirs);
      last = await this.bashOnce(command, timeoutMs, ctx);
    }
    return last.text;
  }

  /** 单次执行（spec §12 提取）：查询授权态 → spawn → 收集 → 拼装文本。
   * blocked 时 dirs 为归一授权候选（供上报与覆盖判定）。abort 抛 AbortError 穿透。 */
  private async bashOnce(
    command: string,
    timeoutMs: number,
    ctx: ToolContext,
  ): Promise<{ text: string; blocked: boolean; dirs: string[] }> {
    const queryNet = netQueryOverride ?? requestEffectiveNetwork;
    // v2.4.x 网络态查询（2026-09-13 修订 B 双态化）：spawn 前经 IPC 桥问主进程
    // 有效策略 netOn = (networkPolicy === 'allow')——设置读取在主进程 DB 单例，
    // 子进程不可见。桥不可用（非 fork 环境直跑单测 / 主进程超时）回退
    // resolveShellSpawn 的设置双态推导，bash 主路径绝不因查询故障挂死。
    let net: EffectiveNetworkDecision | null = null;
    try {
      net = await queryNet(ctx.streamSessionId, ctx.workspaceId);
    } catch {
      net = null;
    }
    // v2.4：OS 沙箱接入（spec §5.2）——三态决策替换平台硬编码。
    // blocked（strict 且沙箱不可用）必须在 spawn 之前抛错：
    // 错误信息含安装指引，由调用方转成 tool result 反馈给 LLM 自行处理。
    const plan = resolveShellSpawn(
      ctx.workspaceDir,
      command,
      net === null ? undefined : {
        networkEnabled: net.netOn,
        // 动态授权目录（extraDirs，两层合成）——授权卡放行后下一次 spawn 立即生效
        extraDirs: net.extraDirs,
      },
    );
    if (plan.kind === 'blocked') throw new Error(plan.reason);
    // wrapped 模式叠加沙箱 env 增量（npm/pip 缓存重定向到 tmp，写剖面自洽）
    const env = { ...buildSandboxEnv(ctx), ...(plan.kind === 'wrapped' ? plan.envAdditions : {}) };
    const isWin = process.platform === 'win32';

    return await new Promise<{ text: string; blocked: boolean; dirs: string[] }>((resolve, reject) => {
      const child = spawn(plan.shell, plan.args, {
        cwd: ctx.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX：detached 使 bash 成为进程组长，kill(-pid) 杀全组（v1.5.6 语义保留）。
        // win32 无进程组语义：detached=false + 杀树走 taskkill /T /F（spec §5.5）。
        detached: !isWin,
        windowsHide: true,
      });
      // 进程组登记（2026-09-25 生命周期立项）：pgid 经 child IPC 上报主进程——
      // 回合收尾（finalizeActiveTask）由主进程统一收割。本工具运行在 runtime
      // 子进程内，主进程登记是唯一真相源；非 fork 环境（单测/直跑）send 为
      // undefined，?. 即 no-op。POSIX 下 detached spawn 的 child.pid 即 pgid。
      if (child.pid) {
        process.send?.({ type: 'proc-group:register', streamSessionId: ctx.streamSessionId, pgid: child.pid });
      }

      // 流式 UTF-8 收集器（shared/stream-decode）：多字节字符可被 pipe 边界切开，
      // 逐 chunk toString 会解出 U+FFFD（中文乱码）。按字符累计到上限即截断。
      const outCol = createUtf8Collector(OUTPUT_LIMITS.bash_stdout);
      const errCol = createUtf8Collector(OUTPUT_LIMITS.bash_stderr);
      let killed = false;
      // v1.5.6: 防重复 resolve/reject——close 事件 + 兜底 timer 可能竞争
      let settled = false;
      const guard = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      // 输出按 OUTPUT_LIMITS.bash_stdout / bash_stderr 截断——截断判定与标记
      // 由收集器承担：配额满后 write 不再累加并置 truncated（见 stream-decode.ts）。
      child.stdout.on('data', (chunk: Buffer) => {
        outCol.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errCol.write(chunk);
      });

      // v1.5.6: 杀整个进程组（bash + 所有子进程）。SIGKILL 不可被捕获/忽略。
      const killProcessGroup = (): void => {
        if (!child.pid) return;
        if (isWin) {
          // Windows：taskkill 树杀（process.kill(-pid) 在 win32 会抛 EINVAL）
          spawn('taskkill', buildKillTreeArgs(child.pid), { stdio: 'ignore' });
          return;
        }
        // detached 模式下 child.pid 就是 pgid；process.kill(-pid) 给全组发 SIGKILL。
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 进程组杀失败（已退出/权限），降级杀 child 自身
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }
      };

      // v1.5.6: 兜底 resolve——进程组 SIGKILL 后 close 事件可能仍不触发
      //（极端 hang / 子进程脱离了进程组 / stdio 未关）。
      // timeout 和 abort 两个路径共用此兜底，防 Promise 永久卡住。
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const armFallback = (reason: string): void => {
        if (fallbackTimer) return; // 已在倒计时
        fallbackTimer = setTimeout(() => {
          guard(() => {
            // 兜底路径（进程被强杀、close 未触发）：不冲尾字节——半个汉字
            // 冲出来只会是 U+FFFD 噪声，直接取已解码部分。
            const stdout = outCol.text;
            const stderr = errCol.text;
            const truncated = outCol.truncated || errCol.truncated;
            const parts = [`exit_code: null`, `(${reason}，进程组已杀 + 2s 兜底结束)`];
            if (stdout) parts.push(`stdout:\n${stdout}${truncated ? '\n…(已截断)' : ''}`);
            if (stderr) parts.push(`stderr:\n${stderr}${truncated ? '\n…(已截断)' : ''}`);
            resolve({ text: parts.join('\n\n'), blocked: false, dirs: [] });
          });
        }, 2000);
      };

      // 超时定时器：到点 SIGKILL 整个进程组 + 启动 2s 兜底。
      const timer = setTimeout(() => {
        killed = true;
        killProcessGroup();
        armFallback(`超时 ${timeoutMs}ms`);
      }, timeoutMs);

      // v1.5.1：监听外部 abortSignal（chat loop 中断）。被 abort 时立即 SIGKILL + 兜底。
      let aborted = false;
      const onAbort = (): void => {
        if (aborted || killed || settled) return;
        aborted = true;
        killProcessGroup();
        // v1.5.6: abort 也要启动兜底 timer——跟 timeout 路径一样，
        // 进程组 SIGKILL 后 close 可能不触发（子进程持有 stdio），不兜底会卡住。
        armFallback('用户中断');
      };
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) onAbort();
        else ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('close', (code) => {
        guard(() => {
          clearTimeout(timer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (ctx.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
          // v1.5.2: 外部中断时抛 AbortError，chat loop 据此跳出整个循环（不推 tool_result 给 LLM）。
          // 不抛的话 LLM 看到 "(用户中断)" 结果仍会重试，形成死循环。
          if (aborted) {
            const e = new Error('bash 被中断');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          // 先 end() 冲出不完整尾字节，再取文本（多字节安全的完整输出）。
          outCol.end();
          errCol.end();
          const stdout = outCol.text;
          const stderr = errCol.text;
          const truncated = outCol.truncated || errCol.truncated;
          // v2.4：sandbox 行紧跟 exit_code 行——LLM 与调用方据此感知本次执行
          // 是否落在 OS 沙箱内（unsandboxed:* = permissive 降级直跑）。
          const parts: string[] = [`exit_code: ${code ?? 'null'}`, `sandbox: ${plan.tag}`];
          // wrapped 模式清理临时 profile 文件（darwin seatbelt .sb 等）——best-effort
          for (const f of plan.kind === 'wrapped' ? plan.cleanupFiles : []) {
            try { fs.unlinkSync(f); } catch { /* best-effort */ }
          }
          if (killed) parts.push(`(超时 ${timeoutMs}ms，已强杀)`);
          if (stdout) parts.push(`stdout:\n${stdout}${truncated ? '\n…(stdout 已截断)' : ''}`);
          if (stderr) parts.push(`stderr:\n${stderr}${truncated ? '\n…(stderr 已截断)' : ''}`);
          if (!stdout && !stderr && code === 0 && !killed) parts.push('(无输出)');
          // 写拦截检测（spec §12）：命中则返回 blocked + 归一 dirs（execute 外层
          // 负责上报与有界等待；hint 仍置尾——等待超时路径的 LLM 行动指引不变）
          const blocked = detectWriteBlocked(plan.tag, command, stderr, stdout);
          if (blocked) {
            parts.push(WRITE_BLOCKED_HINT);
          }
          const text = parts.join('\n\n');
          // 永远 resolve——退出码非 0 不抛错，让 LLM 看到 stderr 自我纠正。
          resolve({
            text,
            blocked,
            dirs: blocked
              ? normalizeGrantDirs(
                  extractBlockedPaths(command, `${stderr}\n${stdout}`, '', ctx.workspaceDir),
                  os.homedir(),
                )
              : [],
          });
        });
      });

      // spawn 本身失败（如 shell 不存在）：转成文本结果而非抛错。
      child.on('error', (err) => {
        guard(() => {
          clearTimeout(timer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (ctx.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
          resolve({ text: `shell 启动失败: ${err.message}`, blocked: false, dirs: [] });
        });
      });
    });
  }
}
