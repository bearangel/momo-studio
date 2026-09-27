// electron/tests/agent/runtime-child-electron-isolation.test.ts
//
// 回归锁（v2.1.0-alpha.9 mac 打包验收实测 P0）：
// runtime 子进程以 ELECTRON_RUN_AS_NODE 运行——该模式下 'electron' 不是内建模块，
// 打包产物 asar 内也没有 electron npm 包。凡 runtime-entry 静态依赖图可达的共享模块
// （tools/* / stream-relay / git-policy 等），顶层 import 'electron' 都会让子进程
// boot 即 MODULE_NOT_FOUND 崩溃 → WarmPool 预热全灭 → agent 恒不可用。
//
// 本文件模拟「electron 不可解析」的打包子进程环境（mock 工厂直接抛错 = require 失败），
// 断言涉事模块仍可正常加载。新增共享模块若需 electron API，一律走
// src/main/electron-access.ts 的 loadElectronApis() 惰性取用并做不可用降级。

import { describe, it, expect, vi } from 'vitest';

// 模拟打包子进程：require('electron') 抛 MODULE_NOT_FOUND（工厂抛错会在被测模块
// 顶层 require 'electron' 时向上传播——正是打包产物的真实失败形态）
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron'");
});

describe('runtime 子进程 electron 隔离（打包回归锁）', () => {
  it('apply-patch-tools 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/agent/tools/apply-patch-tools');
    expect(mod.ApplyPatchTools).toBeDefined();
  });

  it('stream-relay 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/agent/stream-relay');
    expect(mod.handleStreamChunk).toBeDefined();
  });

  it('git-policy 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/workspace/git-policy');
    expect(mod.getGitPolicy).toBeDefined();
  });

  it('loadElectronApis 降级为空 Partial（不抛、无 API）', async () => {
    const { loadElectronApis } = await import('../../src/main/electron-access');
    const apis = loadElectronApis();
    expect(apis.BrowserWindow).toBeUndefined();
    expect(apis.ipcMain).toBeUndefined();
    expect(apis.app).toBeUndefined();
  });

  it('loadElectronApis 重复调用返回稳定缓存（require 不重试）', async () => {
    const { loadElectronApis } = await import('../../src/main/electron-access');
    expect(loadElectronApis()).toBe(loadElectronApis());
  });
});
