// electron/src/main/files/file-io/file-io-settings.ts
//
// fileIo 设置解析（spec §5.6）。纯函数 + 可注入探测，零 DB / electron 依赖。
import fs from 'node:fs';
import type { EffectiveFileIoMode, FileIoMode } from './types';

/** kv_store global_settings.fileIo 的原始形状（settings/crud.ts GlobalSettings.fileIo 同构） */
export interface FileIoConfig {
  mode?: FileIoMode;
  nodePath?: string;
  strictCipherCheck?: boolean;
}

export interface ResolvedFileIoSettings {
  mode: FileIoMode;
  nodePath: string | null;
  strictCipherCheck: boolean;
}

/** 加密客户端安装目录（auto 探测依据；上游 PoC §1.2 实测） */
export const ESAFENET_CLIENT_DIRS = ['C:\\Program Files\\EsafeNet\\Cobra DocGuard Client'];

/**
 * 探测加密客户端是否安装；exists 可注入（测试）。try/catch 包在 some 回调层，
 * 使默认实现与注入实现抛错一律视为未安装（不崩）。
 */
export function detectClientInstalled(exists: (p: string) => boolean = (p) => fs.existsSync(p)): boolean {
  return ESAFENET_CLIENT_DIRS.some((d) => {
    try {
      return exists(d);
    } catch {
      return false;
    }
  });
}

export function resolveFileIoSettings(raw?: FileIoConfig): ResolvedFileIoSettings {
  const mode: FileIoMode =
    raw?.mode === 'proxy' || raw?.mode === 'auto' || raw?.mode === 'direct'
      ? raw.mode
      : 'direct';
  const nodePath =
    typeof raw?.nodePath === 'string' && raw.nodePath.trim().length > 0 ? raw.nodePath : null;
  return { mode, nodePath, strictCipherCheck: raw?.strictCipherCheck !== false };
}

/** auto：客户端已装 → proxy，否则 direct；显式模式原样返回 */
export function resolveEffectiveMode(
  s: ResolvedFileIoSettings,
  clientInstalled: boolean,
): EffectiveFileIoMode {
  if (s.mode === 'proxy') return 'proxy';
  if (s.mode === 'auto') return clientInstalled ? 'proxy' : 'direct';
  return 'direct';
}
