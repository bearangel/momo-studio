//
// File IO Proxy 公共类型（spec 2026-11-11 §5）。本文件及同目录其它模块会被
// runtime 子进程加载——禁止 import 'electron'。
export type FileIoMode = 'direct' | 'proxy' | 'auto';
export type EffectiveFileIoMode = 'direct' | 'proxy';

export type FileIoErrorCode =
  | 'EENCRYPTED'
  | 'ENONODE'
  | 'ENOWORKER'
  | 'ESPAWN'
  | 'ECHILD'
  | 'ETIMEOUT'
  | 'EREAD'
  | 'EWRITE'
  | 'EBADMODE';

/** 文件 IO 领域错误：code 沿 IPC / 桥全线透传（错误契约见 spec §5.7） */
export class FileIoError extends Error {
  constructor(readonly code: FileIoErrorCode, message: string) {
    super(message);
    this.name = 'FileIoError';
  }
}

/**
 * 文件内容读写通道（WorkspaceFS 收口注入点，spec §5.3）。
 * absPath 已由 WorkspaceFS.assertInWorkspace 校验为绝对路径。
 */
export interface ContentIo {
  readFile(absPath: string): Promise<Buffer>;
  writeFile(absPath: string, data: Buffer): Promise<void>;
}

// ── 用户可见错误文案（硬性约束：中性化，见 spec §5.6；技术细节只进日志）──
export const MSG_DIRECT_CIPHER =
  '文件为加密格式，无法读取。请在 设置 → 文件访问 切换为 Node 代理模式，或联系管理员。';
export const MSG_PROXY_CIPHER =
  'Node 代理模式下仍读到加密内容。请在 设置 → 文件访问 检查代理进程放行状态，或联系管理员。';
