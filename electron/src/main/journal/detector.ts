// electron/src/main/journal/detector.ts
//
// git 探测管道件（v2.5 变更账本 Task 5 建立；2026-09-30 scan IPC 退役后仅存
// 共享管道）：spawn 型 git runner + porcelain v1 解析 + 文件内容 hash。
// 现行唯一消费方 = baseline.ts（任务起点基线捕获，starter/lifecycle 调用）。
//
// 多仓发现（discoverRepos + mtime 缓存）在共享模块 ../git/repos.ts
// （v2.9 多仓 git Task 1 自本模块上提，git 工具层与 baseline 双方引用）。
//
// 铁律：只读不写、绝不产生 commit；git 不可用 / 执行失败 / 输出截断由
// 消费方降级处理（baseline 写 degraded 基线）。runGit 形态参照 v2.4
// sandbox/probe.ts defaultRunner（spawn + 超时 + 输出截断 + 可注入），
// 本模块自持、不 import sandbox。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { hashContent } from './recorder';

/** 单次 git 命令执行结果。errCode 承载 spawn error event 的底层错误码
 *  （'ENOENT' = 本机无 git），避免从 stderr 字符串猜测 */
export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  errCode: string | null;
  /** 输出是否触顶截断——截断的 porcelain 不完整，消费方必须降级 */
  truncated: boolean;
}

/** 可注入的 git 执行器（测试注入 fake；生产 defaultGitRunner） */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** 默认 runner：spawn git + 10s 超时 SIGKILL + 1MB 输出截断（标记 truncated）。
 *  win32 shell 豁免（v2.10 spawn 审计）：git 是真 PE（git.exe），无 shell 的
 *  spawn 走 CreateProcess 直寻 .exe 可执行——不经过 .cmd shim 解析、不会
 *  ENOENT，故不加 shell 分支（对照 mcp/client.ts 的裸命令 npx 问题）。 */
export const defaultGitRunner: GitRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const CAP = 1_048_576;
    let out = '';
    let err = '';
    let outTruncated = false;
    let errTruncated = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 10_000);
    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      if (out.length >= CAP) {
        outTruncated = true;
        return;
      }
      if (out.length + s.length > CAP) outTruncated = true;
      out += s.slice(0, CAP - out.length);
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      if (err.length >= CAP) {
        errTruncated = true;
        return;
      }
      if (err.length + s.length > CAP) errTruncated = true;
      err += s.slice(0, CAP - err.length);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, errCode: null, truncated: outTruncated });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      resolve({
        code: null,
        stdout: out,
        stderr: e.message,
        errCode: code ?? 'SPAWN_ERROR',
        truncated: outTruncated || errTruncated,
      });
    });
  });

/** 读工作区文件当前内容并算 sha256 hex——基线捕获（baseline.ts）消费。
 *  不可读（已删除 / 权限等）返回 null（null = 不可读 ≠ 空内容，空文件有
 *  确定 sha256）。Buffer 直读，二进制文件保真（hashContent v2.1 契约）。 */
export function hashFileOrNull(absPath: string): string | null {
  try {
    return hashContent(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}

/**
 * 解析 porcelain v1 输出 → 相对 repo 根的路径列表。
 * 行形态 `XY <path>`（X=index 列、Y=worktree 列）：
 *   - rename/copy（R/C）行带 `旧 -> 新` 尾巴，取新路径（现行存在位）
 *   - 非_ascii 路径被引号包裹 + 八进制转义（core.quotePath 默认），需还原
 */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const x = line.charAt(0);
    const y = line.charAt(1);
    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && p.includes(' -> ')) {
      p = p.slice(p.lastIndexOf(' -> ') + 4);
    }
    paths.push(unquotePath(p));
  }
  return paths;
}

/** 引号路径还原：剥离首尾 `"`、还原 `\"` `\\` 与 `\NNN` 八进制字节转义。
 *  八进制转义按字节还原后经 latin1→utf-8 重组（git 对非 ASCII 的转义形态）；
 *  仅出现过八进制转义才重组，避免污染未经转义的原始 UTF-8 路径 */
function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  let acc = '';
  let sawOctal = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch !== '\\') {
      acc += ch;
      continue;
    }
    const next = inner.charAt(i + 1);
    if (next === '"' || next === '\\') {
      acc += next;
      i++;
      continue;
    }
    const oct = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) {
      acc += String.fromCharCode(parseInt(oct, 8));
      sawOctal = true;
      i += 3;
      continue;
    }
    acc += next;
    i++;
  }
  return sawOctal ? Buffer.from(acc, 'latin1').toString('utf-8') : acc;
}
