// electron/src/main/agent/tools/sandbox-write-hint.ts
// 沙箱写拦截检测 + 提示 + 路径提取（spec 2026-10-03 §5.2）——纯函数，子进程
// （shell 结果 append 提示段）与主进程（writeBlocked 事件检测）双端复用。
// 通用化：HOME 特征从触发必要条件降级为提取辅助（任何工作空间外写拒绝都触发）；
// 新增路径提取器与「显示即所授」归一规则。
import fs from 'node:fs';
import path from 'node:path';

/** 写拒绝签名（合并扫描 stderr+stdout——cargo 家族错误打 stdout，实录教训） */
const WRITE_DENY_SIGNATURES: readonly RegExp[] = [
  /EPERM/i,
  /Operation not permitted/i,
  /Permission denied/i,
  /Read-only file system/i,
];

/** 沙箱化 tag 前缀（seatbelt/bwrap；win/plain/unsandboxed 不检） */
const SANDBOXED_TAG = /^(?:seatbelt|bwrap)\//;

/** 路径 token：绝对路径（负向后顾防 ~/x、URL、变量拼接形态误吞） */
const PATH_TOKEN = /(?<![\w~])(\/[^\s'"`:,;|<>()[\]]+)/g;

/** 只从「错误相关行」提路径：签名/失败动词所在行 */
const ERROR_LINE = /(error|caused by|failed|cannot|denied|not permitted|permission)/i;

export function detectWriteBlocked(tag: string, command: string, stderr: string, stdout = ''): boolean {
  if (!SANDBOXED_TAG.test(tag)) return false;
  const combined = `${stderr}\n${stdout}`;
  return WRITE_DENY_SIGNATURES.some((re) => re.test(combined));
}

export function extractBlockedPaths(command: string, stderr: string, stdout = ''): string[] {
  const combined = `${stderr}\n${stdout}`;
  if (!WRITE_DENY_SIGNATURES.some((re) => re.test(combined))) return [];
  const out: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) {
      if (!ERROR_LINE.test(line)) continue;
      for (const m of line.matchAll(PATH_TOKEN)) {
        const p = m[1];
        if (p === undefined) continue;
        if (!out.includes(p)) out.push(p);
        if (out.length >= 3) return;
      }
    }
  };
  collect(stderr);
  collect(stdout);
  if (out.length < 3) collect(command); // 命令参数兜底（写命令目标）
  return out.slice(0, 3);
}

/**
 * 永不接受为授权目录的系统根（精确命中；子路径不受限——/opt/homebrew 合法）。
 * 终审 I4：错误行里的工具路径（/usr/bin/cc 等）上溯会到这些根——拒绝展示。
 */
const SYSTEM_ROOT_DENYLIST: ReadonlySet<string> = new Set([
  '/', '/bin', '/sbin', '/etc', '/var', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib',
  '/opt', '/System', '/Library', '/private/etc', '/private/var',
]);

/** realpath 优先、resolve 兜底（与授权存储侧 toolchain-grant.realpathOrResolve 同一归一） */
function normalizeRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p); // 词法消解 ..（不存在路径的真实语义）
  }
}

/**
 * 归一（spec §5.2 显示即所授）：HOME 下路径归并到 HOME 第一级；非 HOME 取最近
 * 存在的**目录**祖先。产出统一走 realpath/resolve 归一——保证「卡上显示 ==
 * KV 存储 == profile 生效」三者同一字符串（终审 C1：symlink/.. 伪装下显示 A
 * 实授 realpath(A) 的欺骗面必须在此消灭）。系统根目录拒绝（终审 I4）。
 */
export function normalizeGrantDirs(paths: string[], home: string): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let dir: string | null = null;
    if (raw.startsWith(`${home}/`)) {
      const firstSeg = raw.slice(home.length + 1).split('/')[0];
      if (firstSeg !== undefined) dir = path.join(home, firstSeg);
    } else {
      let cur = raw;
      while (cur !== '/' && cur !== '') {
        try {
          const st = fs.statSync(cur);
          if (st.isDirectory()) {
            dir = cur; // 只接受目录（文件命中继续上溯——终审 I4）
            break;
          }
        } catch {
          // 不存在 → 继续上溯
        }
        const next = path.dirname(cur);
        if (next === cur) break;
        cur = next;
      }
    }
    if (dir === null || dir === '') continue;
    const normalized = normalizeRealPath(dir);
    if (SYSTEM_ROOT_DENYLIST.has(normalized)) continue;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= 3) break;
  }
  return out;
}

export const WRITE_BLOCKED_HINT =
  '⚠ 工作空间外路径写入被沙箱拦截。系统已弹出授权卡并暂停等待用户处置：用户放行后本命令会自动重试；用户拒绝时你会收到明确的拒绝结果。请勿用临时目录或缓存重定向绕过，也勿在等待期间尝试其他写入路径。';
