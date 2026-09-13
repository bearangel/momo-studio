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

export function buildPolicy(workspaceDir: string, networkEnabled: boolean): ShellSandboxPolicy {
  const home = realpath(os.homedir());
  return {
    workspaceDir: realpath(workspaceDir),
    homeDir: home,
    tmpDir: realpath(os.tmpdir()),
    // 只保留磁盘上真实存在的条目（目录或文件）：bwrap 对不存在路径挂 tmpfs
    // 会直接报错；Windows 段（PowerShell 黑名单）不消费本清单，不受影响
    sensitiveDirs: sensitiveCandidates(home).filter((d) => fs.existsSync(d)),
    networkEnabled,
  };
}
