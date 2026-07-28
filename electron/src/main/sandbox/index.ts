// electron/src/main/sandbox/index.ts
//
// 平台分发入口。按 process.platform 选择对应的 SandboxProvider 实现，
// 首次调用后缓存实例（单例），后续 getSandboxProvider() 直接复用。
//
// setSandboxProvider() 供测试注入 fake provider；传 null 清除缓存使下一次
// getSandboxProvider() 重新按平台选择（用于测试间的隔离）。

import { LinuxSandbox } from './linux-sandbox';
import { MacSandbox } from './macos-sandbox';
import { FallbackSandbox } from './fallback-sandbox';
import type { SandboxProvider } from './types';

/** 缓存的 provider 实例（单例） */
let provider: SandboxProvider | null = null;

/**
 * 获取当前平台的沙箱 provider。首次调用按 platform 选择实现并缓存，
 * 后续调用直接返回缓存实例。
 */
export function getSandboxProvider(): SandboxProvider {
  if (provider) return provider;
  if (process.platform === 'linux') {
    provider = new LinuxSandbox();
  } else if (process.platform === 'darwin') {
    provider = new MacSandbox();
  } else {
    provider = new FallbackSandbox();
  }
  return provider;
}

/**
 * 测试钩子：注入自定义 provider（绕过平台分发）。
 * 传 null 清除缓存，使下次 getSandboxProvider() 重新按平台选择。
 */
export function setSandboxProvider(p: SandboxProvider | null): void {
  provider = p;
}

export type { SandboxProvider, SandboxSpawnOpts, SandboxProcess } from './types';
