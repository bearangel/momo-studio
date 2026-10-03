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
  /** 存在于磁盘的敏感路径（~/.ssh 目录、~/.netrc 文件等）；linux 按类型遮盖
   * （目录 --tmpfs / 文件 --ro-bind /dev/null），darwin 用 file-read* deny 规则 */
  sensitiveDirs: string[];
  networkEnabled: boolean;
  /** 写授权目录（spec 2026-10-03 §6.2）：预置清单 ∪ 动态授权并集——展开归一
   * 后的绝对路径；空数组 = 仅工作空间/tmp 可写（默认安全方向） */
  extraWriteDirs: string[];
}

/** resolveShellSpawn 产物：wrapped=OS 隔离 / plain=直跑（带原因 tag）/ blocked=strict 拒绝 */
export type SpawnPlan =
  | { kind: 'wrapped'; shell: string; args: string[]; tag: string; envAdditions: Record<string, string>; cleanupFiles: string[] }
  | { kind: 'plain'; shell: string; args: string[]; tag: string }
  | { kind: 'blocked'; reason: string };
