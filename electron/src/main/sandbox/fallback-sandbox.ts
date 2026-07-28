// electron/src/main/sandbox/fallback-sandbox.ts
//
// 兜底沙箱实现：不做任何 OS 级隔离，仅依赖应用层 WorkspaceFS 防御。
// 用于不支持的平台（如 Windows）或测试环境。
//
// 行为等价于直接 fork 一个 node 子进程，与 LinuxSandbox 的 M3 简化版一致，
// 但 platformName='fallback-none' 使审计能区分"预期有隔离但退化了"与"无平台实现"。

import { spawn } from 'node:child_process';
import { logger } from '../logger';
import type { SandboxProvider, SandboxSpawnOpts, SandboxProcess } from './types';
import { wrapChild } from './wrap-child';

export class FallbackSandbox implements SandboxProvider {
  readonly platformName = 'fallback-none';

  spawn(opts: SandboxSpawnOpts): SandboxProcess {
    logger.warn('使用 FallbackSandbox（无 OS 级隔离），仅依赖应用层 WorkspaceFS 防御', {
      workspaceDir: opts.workspaceDir,
    });
    const child = spawn('node', [opts.entry], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    return wrapChild(child);
  }
}
