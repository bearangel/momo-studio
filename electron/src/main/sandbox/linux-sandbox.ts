// electron/src/main/sandbox/linux-sandbox.ts
//
// Linux 平台沙箱实现。
//
// M3 简化版说明：
//   真正的 OS 级隔离（mount namespace + bind-mount + cgroups 资源限制）需要
//   root 权限或非特权 user namespace 支持（/proc/sys/kernel/unprivileged_userns_clone），
//   在 DevContainer / 桌面环境中往往不可用或需要额外配置。因此 M3 先落地接口骨架，
//   实际退化为普通 fork + 应用层 WorkspaceFS 路径防御，真正的 namespace 隔离
//   留给 v2（或当部署环境确认支持 user namespace 时启用）。
//
//   即便如此仍保留 platformName='linux-namespace'，使审计日志能反映"预期走 namespace"
//   的意图——后续替换为真正的 unshare/cgroup 实现时上层调用方无需改动。

import { spawn } from 'node:child_process';
import { logger } from '../logger';
import type { SandboxProvider, SandboxSpawnOpts, SandboxProcess } from './types';
import { wrapChild } from './wrap-child';

export class LinuxSandbox implements SandboxProvider {
  readonly platformName = 'linux-namespace';

  spawn(opts: SandboxSpawnOpts): SandboxProcess {
    // M3：namespace 隔离未启用（需 root/user namespace 支持），记录告警。
    // 应用层防御（WorkspaceFS 路径校验 + .git 保护）仍生效，文件越界访问会被拒绝。
    logger.warn('Linux namespace 沙箱未完全实现（需 root/user namespace），仅依赖应用层防御', {
      workspaceDir: opts.workspaceDir,
    });

    const child = spawn('node', [opts.entry], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    return wrapChild(child);
  }
}
