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
 * 归一（spec §5.2 显示即所授）：HOME 下路径归并到 HOME 第一级（授权粒度 =
 * ~/.cargo 这样的工具链根目录）；非 HOME 路径取最近存在祖先（fs 逐级上溯，
 * /tmp、/opt 等必命中）。卡上展示的就是最终授权目录。
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
          fs.statSync(cur);
          dir = cur;
          break;
        } catch {
          const next = path.dirname(cur);
          if (next === cur) break;
          cur = next;
        }
      }
    }
    if (dir !== null && dir !== '' && !out.includes(dir)) out.push(dir);
    if (out.length >= 3) break;
  }
  return out;
}

export const WRITE_BLOCKED_HINT =
  '⚠ 工作空间外路径写入被沙箱拦截。请暂停后续重试并告知用户：用户界面会弹出授权卡（选择本会话或本工作空间放行具体目录），用户操作完成后重试同一命令即可。不要用临时目录或缓存重定向绕过。';
