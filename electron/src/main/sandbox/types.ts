// electron/src/main/sandbox/types.ts
// OS 沙箱类型定义（v2.4 重建）。ShellSandboxPolicy 是 platform 无关的策略对象，
// 由 macos.ts / linux.ts 各自渲染成实际隔离参数；SpawnPlan 是 resolveShellSpawn
// 的三态产物，shell-tools.ts 是唯一消费者。

export type SandboxMode = 'strict' | 'permissive';

/** platform 无关沙箱策略（buildPolicy 产出；所有路径均为 realpath 解析后的绝对路径） */
export interface ShellSandboxPolicy {
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
  /** 存在于磁盘的敏感目录（~/.ssh 等）；linux 用 --tmpfs 覆盖隐藏，darwin 用 deny 规则 */
  sensitiveDirs: string[];
  networkEnabled: boolean;
}

/** resolveShellSpawn 产物：wrapped=OS 隔离 / plain=直跑（带原因 tag）/ blocked=strict 拒绝 */
export type SpawnPlan =
  | { kind: 'wrapped'; shell: string; args: string[]; tag: string; envAdditions: Record<string, string>; cleanupFiles: string[] }
  | { kind: 'plain'; shell: string; args: string[]; tag: string }
  | { kind: 'blocked'; reason: string };
