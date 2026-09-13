// electron/src/main/sandbox/linux.ts
// bubblewrap 参数构造（spec §5.4）。纯函数：策略 → bwrap argv 前缀。
// 敏感目录用空 tmpfs 覆盖隐藏（bwrap 无法 deny ro-bind 子路径的标准技巧）。
// 敏感文件（如 ~/.netrc，审查 F4）不能 tmpfs（mount 目标必须是目录——对普通
// 文件挂 tmpfs 会让 bwrap 整体失败），改用 --ro-bind /dev/null 只读遮盖：
// 读取恒为空内容且不可写。
import fs from 'node:fs';
import type { ShellSandboxPolicy } from './types';

export function buildBwrapArgs(policy: ShellSandboxPolicy): string[] {
  const args: string[] = ['--ro-bind', '/', '/'];
  for (const dir of policy.sensitiveDirs) {
    // 按磁盘类型分派遮盖方式：普通文件 → /dev/null 只读遮盖；目录或不存在
    // （快照测试等无磁盘场景）→ 维持 tmpfs 既有行为
    let isFile = false;
    try {
      isFile = fs.statSync(dir).isFile();
    } catch {
      // 条目不存在：tmpfs 自建挂载点，与旧行为一致
    }
    if (isFile) args.push('--ro-bind', '/dev/null', dir);
    else args.push('--tmpfs', dir);
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