// electron/src/main/sandbox/linux.ts
// bubblewrap 参数构造（spec §5.4）。纯函数：策略 → bwrap argv 前缀。
// 敏感目录用空 tmpfs 覆盖隐藏（bwrap 无法 deny ro-bind 子路径的标准技巧）。
import type { ShellSandboxPolicy } from './types';

export function buildBwrapArgs(policy: ShellSandboxPolicy): string[] {
  const args: string[] = ['--ro-bind', '/', '/'];
  for (const dir of policy.sensitiveDirs) {
    args.push('--tmpfs', dir);
  }
  args.push('--bind', policy.workspaceDir, policy.workspaceDir);
  // tmp 用真实主机 tmp（bind RW）：npm 大构建中间产物落盘而非吃 RAM
  args.push('--bind', '/tmp', '/tmp');
  args.push('--dev', '/dev', '--proc', '/proc');
  if (!policy.networkEnabled) args.push('--unshare-net');
  // --new-session 防 TIOCSTI 终端注入；--die-with-parent 主进程死则沙箱死
  args.push('--new-session', '--die-with-parent');
  return args;
}