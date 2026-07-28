// electron/src/main/sandbox/macos-sandbox.ts
//
// macOS 平台沙箱实现：基于 sandbox-exec + Seatbelt profile。
//
// 工作原理：
//   sandbox-exec 是 macOS 自带的命令行工具，读取一个 .sb profile（Scheme 风格 DSL）
//   后用 sandbox_seatbelt 包裹目标进程，按 profile 规则放行/拒绝文件、网络、进程操作。
//   不需要 root 权限即可限制自己 spawn 的子进程。
//
// M3 简化版生成的最小 profile：
//   - 允许 workspace 目录读写（agent 工作区）
//   - 允许 443 出站（LLM API；按域名精确过滤需要 sandbox seatbelt 的 network-outbound
//     带正则规则，M3 先放开所有 443，后续按 networkAllowDomains 精细化）
//   - 允许 node 二进制执行 + 系统库读取 + 自身 fork/signal
//
// profile 文件写在 os.tmpdir()，子进程退出后自动清理。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../logger';
import type { SandboxProvider, SandboxSpawnOpts, SandboxProcess } from './types';
import { wrapChild } from './wrap-child';

export class MacSandbox implements SandboxProvider {
  readonly platformName = 'macos-seatbelt';

  spawn(opts: SandboxSpawnOpts): SandboxProcess {
    const profilePath = path.join(os.tmpdir(), `ap-sandbox-${Date.now()}.sb`);
    const profile = generateSeatbeltProfile(opts);
    fs.writeFileSync(profilePath, profile, 'utf-8');

    // sandbox-exec -p <profile> -- node <entry>
    const child = spawn('sandbox-exec', ['-p', profilePath, 'node', opts.entry], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    // 子进程退出后清理 profile 文件（best-effort）
    child.on('exit', () => {
      try {
        fs.unlinkSync(profilePath);
      } catch {
        // 文件可能已被清理或不存在，忽略
      }
    });

    logger.info('macOS Seatbelt 沙箱已启动', {
      workspaceDir: opts.workspaceDir,
      profilePath,
    });
    return wrapChild(child);
  }
}

/**
 * 生成最小 Seatbelt profile。
 * 规则集：(deny default) 起步，逐条 allow 放行必要操作。
 */
function generateSeatbeltProfile(opts: SandboxSpawnOpts): string {
  // 允许 workspace 目录读写
  const workspaceRule = `(allow file-read* file-write* (subpath "${opts.workspaceDir}"))`;
  // 允许 LLM API 网络（M3 简化：允许所有 443 出站；精确域名过滤留给 v2）
  const networkRule =
    opts.networkAllowDomains.length > 0
      ? '(allow network-outbound (remote tcp "*:443"))'
      : '';
  // 允许 Node.js 二进制执行（覆盖常见安装路径）
  const nodeRule =
    '(allow process-exec (literal "/usr/local/bin/node") (literal "/opt/homebrew/bin/node"))';

  return `(version 1)
(deny default)
${nodeRule}
${workspaceRule}
${networkRule}
(allow file-read* (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System"))
(allow process-fork)
(allow signal (target self))
`;
}
