// electron/tests/sandbox/index.test.ts
//
// 验证平台分发逻辑（不测具体 spawn 行为——spawn 依赖 OS 工具，放集成测试）：
//   - getSandboxProvider() 在当前平台返回对应 platformName
//   - setSandboxProvider() 可注入 fake provider
//   - setSandboxProvider(null) 清除缓存后重新按平台选择

import { describe, it, expect, afterEach } from 'vitest';
import { getSandboxProvider, setSandboxProvider } from '../../src/main/sandbox';
import type { SandboxProvider, SandboxProcess, SandboxSpawnOpts } from '../../src/main/sandbox';

// 每个 test 后清除缓存，避免相互污染
afterEach(() => {
  setSandboxProvider(null);
});

// 一个最小 fake provider，用于注入测试
function makeFakeProvider(name: string): SandboxProvider {
  return {
    platformName: name,
    spawn(_opts: SandboxSpawnOpts): SandboxProcess {
      return {
        pid: -1,
        stdin: null,
        stdout: null,
        stderr: null,
        on: () => {},
        send: () => false,
        kill: () => {},
        connected: false,
      };
    },
  };
}

describe('sandbox/index 平台分发', () => {
  it('getSandboxProvider() 返回当前平台对应的 provider', () => {
    const p = getSandboxProvider();
    const expected =
      process.platform === 'linux'
        ? 'linux-namespace'
        : process.platform === 'darwin'
          ? 'macos-seatbelt'
          : 'fallback-none';
    expect(p.platformName).toBe(expected);
  });

  it('getSandboxProvider() 单例：多次调用返回同一实例', () => {
    const a = getSandboxProvider();
    const b = getSandboxProvider();
    expect(a).toBe(b);
  });

  it('setSandboxProvider() 注入的 fake 覆盖平台默认', () => {
    const fake = makeFakeProvider('test-fake');
    setSandboxProvider(fake);
    expect(getSandboxProvider()).toBe(fake);
    expect(getSandboxProvider().platformName).toBe('test-fake');
  });

  it('setSandboxProvider(null) 清除缓存后重新按平台选择', () => {
    // 先注入 fake
    const fake = makeFakeProvider('test-fake');
    setSandboxProvider(fake);
    expect(getSandboxProvider().platformName).toBe('test-fake');

    // 清除后再取应回到平台默认
    setSandboxProvider(null);
    const p = getSandboxProvider();
    const expected =
      process.platform === 'linux'
        ? 'linux-namespace'
        : process.platform === 'darwin'
          ? 'macos-seatbelt'
          : 'fallback-none';
    expect(p.platformName).toBe(expected);
  });
});
