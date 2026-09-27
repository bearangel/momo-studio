// electron/src/main/electron-access.ts
//
// 主进程专用 electron API 的惰性访问（单一真相源）。
//
// 背景（v2.1.0-alpha.9 mac 打包验收 P0）：runtime 子进程以 ELECTRON_RUN_AS_NODE
// 运行——该模式下 'electron' 不是内建模块，打包产物 asar 内也没有 electron npm
// 包；dev 环境下子进程虽能解析到 electron npm 包，但其导出是二进制路径字符串
// 而非 API。因此凡 runtime-entry 静态依赖图可达的共享模块（agent/tools/*、
// stream-relay、git-policy 等），顶层 import 'electron' 都会让子进程 boot 即崩
// （MODULE_NOT_FOUND）或拿到 undefined API。
//
// 规则：主进程专属模块（ipc.handlers / window 等子进程不可达者）不受限；
// 子进程可达的共享模块禁止顶层 import 'electron'，须经 loadElectronApis()
// 惰性取用并处理不可用降级。回归锁：tests/agent/runtime-child-electron-isolation.test.ts。

import type { App } from 'electron';

/** webContents 的结构性子集（browser/ipc.ts WebContentsLike 同型——注入友好） */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

/** BrowserWindow 的结构性子集：真实 electron 类与测试假件都满足 */
export interface BrowserWindowLike {
  getAllWindows(): Array<{ isDestroyed(): boolean; webContents: WebContentsLike }>;
}

/** ipcMain 的结构性子集（browser/ipc.ts IpcMainLike 同型；泛型 handle 保留调用点的参数类型） */
export interface IpcMainLike {
  handle<A extends unknown[]>(channel: string, listener: (event: unknown, ...args: A) => unknown): void;
}

/** app 的结构性子集（消费方只用 getPath；真实 App 满足） */
export type AppLike = Pick<App, 'getPath'>;

/** electron 主进程 API 子集（结构性类型——生产真件与测试假件共用同一契约） */
export interface ElectronApis {
  app: AppLike;
  BrowserWindow: BrowserWindowLike;
  ipcMain: IpcMainLike;
}

/** 缓存结果：require 同步且模块级缓存，但避免每条 stream chunk 重复走 try/catch */
let cached: Partial<ElectronApis> | undefined;

/**
 * 测试注入端：vi.mock 只拦截 transformed import、不拦 raw require()，故测试
 * 不能靠 vi.mock('electron') 喂给本模块——用显式注入替代（进程边界 DI，
 * mock 收窄原则）。传 null 还原真实探测。
 */
let testOverride: Partial<ElectronApis> | null = null;

/** 测试用：注入/清除 electron API 假件（生产禁用） */
export function __setElectronApisForTest(apis: Partial<ElectronApis> | null): void {
  testOverride = apis;
}

/**
 * 惰性加载 electron API。
 *
 * 返回 Partial：调用方按需解构并自行判空降级（`const { BrowserWindow } =
 * loadElectronApis(); if (!BrowserWindow) return;`）。三种环境语义：
 * - 主进程（真实 Electron）：返回内建模块，三 API 齐备
 * - dev 子进程：electron npm 包导出二进制路径字符串 → 判非对象 → 空 Partial
 * - 打包子进程 / 测试未注入：require 抛 MODULE_NOT_FOUND → 空 Partial
 */
export function loadElectronApis(): Partial<ElectronApis> {
  if (testOverride !== null) return testOverride;
  if (cached !== undefined) return cached;
  try {
    // CJS 同步 require；此模块仅被主进程/子进程共享层使用，且 import type
    // 不产生运行时依赖（子进程加载本文件不会触发对 electron 的解析）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod: unknown = require('electron');
    cached =
      typeof mod === 'object' && mod !== null
        ? (mod as Partial<ElectronApis>)
        : {};
  } catch {
    cached = {};
  }
  return cached;
}

/** 测试用：清缓存（切换 mock 形态后重新探测） */
export function __resetElectronApisCacheForTest(): void {
  cached = undefined;
}
