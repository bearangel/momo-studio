// electron/src/main/sandbox/macos.ts
// Seatbelt profile 渲染（spec §5.3）。容器无法实测 macOS——profile 从
// Claude Code 已知可用形态起步，快照锁字符串，主机验收迭代。
import { FULL_DISK_WRITE_DENY_DARWIN, FULL_DISK_WRITE_REALLOW } from './policy';
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
  // 网络开关语义 = 全网络（bind/inbound/outbound）——仅 outbound 时 agent 起不了
  // dev server（listen EPERM，macOS 主机实测）；关闭 = deny default 全禁
  const networkRule = policy.networkEnabled ? '(allow network*)\n' : '';
  // 写剖面两态（spec 2026-11-05 §5.4）：confined = 现行 workspace/tmp + 授权目录
  // 逐条 allow；full-disk = 全盘 allow → 核心目录 deny 逐条后置 → /usr/local
  // re-allow 殿后（后匹配优先，次序即正确性——快照测试锁次序非仅集合）。
  // join('\n') 形态刻意：confined 空 extraDirs 时与既有模板逐字节等价（原模板
  // `${toolchainSection}(allow …)` 行内拼接——字符串拼接尾部会双换行炸快照）。
  const writeSection = policy.writeScope === 'full-disk'
    ? [
        `(allow file-write* (subpath ${escapeSeatbeltString('/')}))`,
        ...FULL_DISK_WRITE_DENY_DARWIN.map((d) => `(deny file-write* (subpath ${escapeSeatbeltString(d)}))`),
        `(allow file-write* (subpath ${escapeSeatbeltString(FULL_DISK_WRITE_REALLOW)}))`,
        '(allow file-write* (literal "/dev/null"))',
      ].join('\n')
    : [
        `(allow file-write* (subpath ${escapeSeatbeltString(policy.workspaceDir)}) (subpath ${escapeSeatbeltString(policy.tmpDir)}) (subpath "/private/tmp"))`,
        '(allow file-write* (literal "/dev/null"))',
        // 工具链目录授权（v2.5 spec §9）：每目录单独 allow file-write*。deny
        // default 与 sensitiveDirs deny 的后置覆盖语义不变——授权只扩写维度，
        // 不动读遮蔽；full-disk 态不渲染（全盘 allow 已覆盖，spec §5.4 省略）
        ...policy.extraWriteDirs.map((d) => `(allow file-write* (subpath ${escapeSeatbeltString(d)}))`),
      ].join('\n');
  // 已知边界（审查 F4 文档化，不改动行为）：下方 mach-lookup 为全放行——macOS
  // 关键服务（securityd / keychaind 等）经 Mach 端口而非文件系统访问 Keychain，
  // 上方 sensitiveDirs 的 file-deny 只挡文件系统直读、挡不住服务侧路径。收敛到
  // 服务白名单需逐服务真机验证 deny 影响面，暂以文档记录——详见 README v2.4
  // 已知边界节「Seatbelt mach-lookup 未收敛到服务白名单」。
  return `(version 1)
(deny default)
(allow file-read* (subpath ${escapeSeatbeltString('/')}))
${denyRules}
${writeSection}
(allow process-exec process-fork)
(allow signal (target self))
(allow file-ioctl sysctl-read mach-lookup)
${networkRule}`;
}
