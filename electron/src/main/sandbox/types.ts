// electron/src/main/sandbox/types.ts
//
// OS 沙箱抽象接口。Agent runtime 子进程通过 SandboxProvider 启动，由各平台
// 实现决定具体的隔离手段（Linux namespace / macOS Seatbelt / 无隔离回退）。
//
// 设计要点：
//   - SandboxSpawnOpts 携带子进程启动所需的全部信息（入口、env、workspace 目录、
//     网络白名单、资源限额）。各平台实现可选择性地应用这些约束。
//   - SandboxProcess 对 Node 的 ChildProcess 做薄封装，只暴露 runtime-manager
//     需要的字段（pid / stdio / IPC / kill），便于用 fake provider 做单测。
//   - platformName 用于日志和审计，标识当前实际生效的隔离策略。

/** 子进程启动参数（传给 SandboxProvider.spawn） */
export interface SandboxSpawnOpts {
  /** 子进程入口 JS 文件（runtime-entry.js 的绝对路径） */
  entry: string;
  /** 环境变量（含 AGENT_CONFIG 序列化配置） */
  env: Record<string, string>;
  /** bind-mount 源：agent 可读写的 workspace 根目录 */
  workspaceDir: string;
  /** 允许访问的网络域名白名单（LLM API 等）；空数组表示按平台默认策略 */
  networkAllowDomains: string[];
  /** 内存上限（MB）；0 表示不限制 */
  memoryLimitMB: number;
  /** CPU 百分比（0-100）；0 表示不限制 */
  cpuPercent: number;
}

/**
 * 沙箱进程句柄。对 Node ChildProcess 的子集封装，只暴露 runtime-manager
 * 实际依赖的字段，避免把整个 ChildProcess 类型泄漏到接口里（也方便测试 mock）。
 */
export interface SandboxProcess {
  pid: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(
    event: 'exit',
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: 'message', cb: (msg: unknown) => void): void;
  send(msg: unknown): boolean;
  kill(signal?: string): void;
  connected: boolean;
}

/**
 * 平台沙箱提供者。每个目标 OS 一个实现类。
 * runtime-manager 通过 getSandboxProvider() 获取当前平台的实例。
 */
export interface SandboxProvider {
  /** 按 opts 启动一个沙箱子进程并返回句柄 */
  spawn(opts: SandboxSpawnOpts): SandboxProcess;
  /** 当前实际生效的隔离策略名（如 'linux-namespace' / 'macos-seatbelt' / 'fallback-none'） */
  readonly platformName: string;
}
