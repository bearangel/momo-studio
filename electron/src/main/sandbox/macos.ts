// electron/src/main/sandbox/macos.ts
// Seatbelt profile 渲染（spec §5.3）。容器无法实测 macOS——profile 从
// Claude Code 已知可用形态起步，快照锁字符串，主机验收迭代。
import type { ShellSandboxPolicy } from './types';

/** Seatbelt 字符串字面量转义（反斜杠 + 双引号） */
export function escapeSeatbeltString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderSeatbeltProfile(policy: ShellSandboxPolicy): string {
  // deny 后置覆盖前置 allow（Seatbelt 后匹配优先）
  const denyRules = policy.sensitiveDirs
    .map((d) => `(deny file-read* (subpath ${escapeSeatbeltString(d)}))`)
    .join('\n');
  const networkRule = policy.networkEnabled ? '(allow network-outbound)\n' : '';
  // 已知边界（审查 F4 文档化，不改动行为）：下方 mach-lookup 为全放行——macOS
  // 关键服务（securityd / keychaind 等）经 Mach 端口而非文件系统访问 Keychain，
  // 上方 sensitiveDirs 的 file-deny 只挡文件系统直读、挡不住服务侧路径。收敛到
  // 服务白名单需逐服务真机验证 deny 影响面，暂以文档记录——详见 README v2.4
  // 已知边界节「Seatbelt mach-lookup 未收敛到服务白名单」。
  return `(version 1)
(deny default)
(allow file-read* (subpath ${escapeSeatbeltString('/')}))
${denyRules}
(allow file-write* (subpath ${escapeSeatbeltString(policy.workspaceDir)}) (subpath ${escapeSeatbeltString(policy.tmpDir)}) (subpath "/private/tmp"))
(allow process-exec process-fork)
(allow signal (target self))
(allow file-ioctl sysctl-read mach-lookup)
${networkRule}`;
}
