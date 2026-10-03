// electron/src/main/sandbox/policy.ts
// platform 无关策略构造。所有路径 realpathSync 解析：符号链接归一后注入
// Seatbelt/bwrap 参数才不会被「路径别名」绕过（如 /var → /private/var）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellSandboxPolicy } from './types';

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * 敏感目录/文件清单（spec §5.3/§5.4）：读 deny（seatbelt）/ tmpfs 或
 * /dev/null 遮盖（bwrap，按条目磁盘类型分派——见 linux.ts）。
 * 审查 F4 扩充：kube（集群凭据）/ docker（registry 凭据）/ netrc（FTP 凭据，
 * 普通文件形态）与 ssh/gpg/aws/gcloud 同为高价值凭据面。
 * 导出供单测直接断言清单形态（DEFAULT_MAX_DEPTH 先例）。
 */
export function sensitiveCandidates(home: string): string[] {
  const base = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.netrc'),
  ];
  if (process.platform === 'darwin') base.push(path.join(home, 'Library', 'Keychains'));
  return base;
}

export function buildPolicy(workspaceDir: string, networkEnabled: boolean, extraWriteDirs: string[] = []): ShellSandboxPolicy {
  const home = realpath(os.homedir());
  return {
    workspaceDir: realpath(workspaceDir),
    homeDir: home,
    tmpDir: realpath(os.tmpdir()),
    // 只保留磁盘上真实存在的条目（目录或文件）：bwrap 对不存在路径挂 tmpfs
    // 会直接报错；Windows 段（PowerShell 黑名单）不消费本清单，不受影响
    sensitiveDirs: sensitiveCandidates(home).filter((d) => fs.existsSync(d)),
    networkEnabled,
    // 工具链目录（v2.5 spec §9）：调用方（resolveShellSpawn）已在授权态完成
    // 展开；此处仅 Set 去重后原样透传——刻意不做磁盘存在性过滤（终审 F1）。
    // 过滤的理由（bwrap 对不存在路径 --bind 硬失败）是 Linux 特定顾虑，已下沉
    // 到 linux.ts 消费点；macOS Seatbelt 对不存在路径的 allow 规则无害且必须
    // 保留——pip:user（~/Library/Python 首装前不存在）等场景依赖「授权即生效」
    //（spec §9：安装动作会创建它），全局过滤会让 grant 后写入仍 EPERM
    extraWriteDirs: [...new Set(extraWriteDirs)],
  };
}
