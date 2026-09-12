// electron/tests/single-instance.test.ts
//
// 单实例锁 boot 接线测试（v2.10 Windows 全平台化 Task 4）。
//
// SUT = src/main/index.ts（模块顶层副作用即 boot 编排）——经 vi.resetModules +
// 动态 import 逐用例重放模块加载。mock 面刻意全量收窄在「进程边界 + boot 依赖」：
//   - electron：app / BrowserWindow 静态 / ipcMain / protocol 全捕获桩
//   - index.ts 的 19 个 boot 依赖模块：vi.fn() 桩（本测试锁的是接线，不是子系统行为）
//
// 锁定契约（摘掉任一分支必红）：
//   1. 无锁（requestSingleInstanceLock → false）：app.quit() 被调 + boot 链零进入
//      （whenReady 即便已 resolve，runMigrations / registerIpcHandlers /
//       initTaskRuntime / createMainWindow / initP2p 等一律零调用）
//   2. 有锁：app.on('second-instance', cb) 注册；quit 零调用
//   3. second-instance 回调 → 取第一个可见窗口：最小化 → show + focus（恢复）；
//      未最小化 → 仅 focus（不重复 show）；无可见窗口 → 安静返回不抛错
//
// whenReady mock 语义（momo-test-rules 铁律 1）：
//   - 无锁用例返回已 resolve 的 Promise——真实 Electron 里无锁进程会在 ready 前
//     退出，whenReady 永不 resolve；此处故意 resolve 以暴露「摘掉 else 守卫后 boot
//     仍然进入」的接线回归（守卫缺失必红，这正是本测试要锁的分支）。
//   - 有锁用例返回永不 resolve 的 Promise——boot body 不执行，测试只关注模块
//     顶层同步完成的锁注册与 second-instance 回调行为。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  // app.on 捕获（真实语义：同步注册、可多次、事件名字符串）
  const onCalls: Array<{ event: string; cb: () => void }> = [];
  const appMock = {
    requestSingleInstanceLock: vi.fn((): boolean => true),
    quit: vi.fn(),
    whenReady: vi.fn((): Promise<void> => new Promise(() => {})),
    on: vi.fn((event: string, cb: () => void) => {
      onCalls.push({ event, cb });
    }),
    getVersion: vi.fn((): string => '0.0.0-test'),
    getPath: vi.fn((): string => '/tmp/ap-fake-userData'),
  };
  // BrowserWindow 静态面：getAllWindows 返回数组（真实返回 BrowserWindow[]）
  const getAllWindows = vi.fn((): unknown[] => []);
  const browserWindowMock = { getAllWindows };
  return { onCalls, appMock, getAllWindows, browserWindowMock };
});

vi.mock('electron', () => ({
  app: h.appMock,
  BrowserWindow: h.browserWindowMock,
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

// ---- index.ts boot 依赖全量桩（接线测试不触达真实子系统）--------------------

const b = vi.hoisted(() => ({
  createMainWindow: vi.fn(),
  registerIpcHandlers: vi.fn(),
  runMigrations: vi.fn(),
  runLegacyUpgradeIfNeeded: vi.fn(async (): Promise<string | null> => null),
  writeLegacyUpgradeNotice: vi.fn(),
  setSessionMainWindow: vi.fn(),
  broadcastRuntimeChanged: vi.fn(),
  initP2p: vi.fn(async (): Promise<void> => undefined),
  stopP2p: vi.fn(async (): Promise<void> => undefined),
  initTaskRuntime: vi.fn(),
  stopTaskRuntime: vi.fn(),
  destroyAllTaskDrivenRuntimes: vi.fn(),
  initTaskDrivenRuntime: vi.fn(async (): Promise<void> => undefined),
  destroyRouterService: vi.fn(),
  tokenizeForIndex: vi.fn(),
  reprobeSandbox: vi.fn(async (): Promise<void> => undefined),
  enforceQuota: vi.fn(),
  listWorkspaces: vi.fn((): Array<{ id: string; directoryPath: string }> => []),
  sweepStaleStreaming: vi.fn((): number => 0),
  assembleBrowserSubsystem: vi.fn(() => ({
    switchWorkspace: vi.fn(),
    factory: { setMountTarget: vi.fn() },
    attachToWindow: vi.fn(),
    bindLifecycle: vi.fn(),
  })),
  initRealViewFactory: vi.fn(),
}));

vi.mock('../src/main/window', () => ({ createMainWindow: b.createMainWindow }));
vi.mock('../src/main/ipc', () => ({ registerIpcHandlers: b.registerIpcHandlers }));
vi.mock('../src/main/storage/db', () => ({ runMigrations: b.runMigrations }));
vi.mock('../src/main/upgrade/legacy-upgrade', () => ({
  runLegacyUpgradeIfNeeded: b.runLegacyUpgradeIfNeeded,
  writeLegacyUpgradeNotice: b.writeLegacyUpgradeNotice,
}));
vi.mock('../src/main/im/session-service', () => ({
  setSessionMainWindow: b.setSessionMainWindow,
  broadcastRuntimeChanged: b.broadcastRuntimeChanged,
}));
vi.mock('../src/main/p2p', () => ({ initP2p: b.initP2p, stopP2p: b.stopP2p }));
vi.mock('../src/main/task/runtime-init', () => ({
  initTaskRuntime: b.initTaskRuntime,
  stopTaskRuntime: b.stopTaskRuntime,
}));
vi.mock('../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/main/agent/runtime-registry', () => ({
  destroyAllTaskDrivenRuntimes: b.destroyAllTaskDrivenRuntimes,
}));
vi.mock('../src/main/agent/init-runtime', () => ({
  initTaskDrivenRuntime: b.initTaskDrivenRuntime,
}));
vi.mock('../src/main/agent/router-bootstrap', () => ({
  destroyRouterService: b.destroyRouterService,
}));
vi.mock('../src/main/storage/memories/tokenize', () => ({
  tokenizeForIndex: b.tokenizeForIndex,
}));
vi.mock('../src/main/sandbox/probe', () => ({ reprobeSandbox: b.reprobeSandbox }));
vi.mock('../src/main/journal/quota', () => ({ enforceQuota: b.enforceQuota }));
vi.mock('../src/main/workspace/crud', () => ({ listWorkspaces: b.listWorkspaces }));
vi.mock('../src/main/task/resume', () => ({ sweepStaleStreaming: b.sweepStaleStreaming }));
vi.mock('../src/main/browser/boot', () => ({
  assembleBrowserSubsystem: b.assembleBrowserSubsystem,
}));
vi.mock('../src/main/browser/view-factory', () => ({
  initRealViewFactory: b.initRealViewFactory,
}));
vi.mock('../src/main/browser/protocol', () => ({ BROWSER_SHOT_SCHEME: 'browser-shot' }));

// =================================================================================
// 工具
// =================================================================================

/** 每用例重放 index.ts 模块加载（顶层副作用 = boot 编排） */
async function loadMain(): Promise<void> {
  vi.resetModules();
  h.onCalls.length = 0;
  await import('../src/main/index');
}

/** 刷新微任务 + 宏任务各一轮，让已 resolve 的 whenReady boot body 跑完 */
async function flushBoot(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** 结构仿真实 BrowserWindow 实例子集（second-instance 回调消费的面） */
function mkWindow(opts: { visible: boolean; minimized: boolean }) {
  return {
    isVisible: vi.fn((): boolean => opts.visible),
    isMinimized: vi.fn((): boolean => opts.minimized),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

/** 从 app.on 捕获里取 second-instance 回调 */
function getSecondInstanceCb(): () => void {
  const hit = h.onCalls.find((c) => c.event === 'second-instance');
  if (!hit) throw new Error('second-instance 未注册');
  return hit.cb;
}

// =================================================================================
// 用例
// =================================================================================

beforeEach(() => {
  vi.clearAllMocks();
  h.onCalls.length = 0;
  // 默认位：有锁 + whenReady 永不 resolve（各用例按需覆写）
  h.appMock.requestSingleInstanceLock.mockReturnValue(true);
  h.appMock.whenReady.mockReturnValue(new Promise<void>(() => {}));
});

describe('单实例锁：无锁分支', () => {
  it('app.quit() 被调一次，且 boot 链零进入（whenReady 已 resolve 也不进）', async () => {
    h.appMock.requestSingleInstanceLock.mockReturnValue(false);
    // 故意 resolve：真实 Electron 无锁进程会在 ready 前退出；resolve 使「守卫缺失」
    // 的回归（boot 仍然进入）在本测试可见（摘掉 else 守卫 → 本用例必红）
    h.appMock.whenReady.mockReturnValue(Promise.resolve());

    await loadMain();
    await flushBoot();

    expect(h.appMock.quit).toHaveBeenCalledTimes(1);
    expect(b.runMigrations).not.toHaveBeenCalled();
    expect(b.registerIpcHandlers).not.toHaveBeenCalled();
    expect(b.initTaskRuntime).not.toHaveBeenCalled();
    expect(b.createMainWindow).not.toHaveBeenCalled();
    expect(b.initTaskDrivenRuntime).not.toHaveBeenCalled();
    expect(b.initP2p).not.toHaveBeenCalled();
    expect(b.assembleBrowserSubsystem).not.toHaveBeenCalled();
  });

  it('无锁时不注册 second-instance（次实例无窗口可聚焦）', async () => {
    h.appMock.requestSingleInstanceLock.mockReturnValue(false);
    h.appMock.whenReady.mockReturnValue(Promise.resolve());

    await loadMain();

    expect(h.onCalls.find((c) => c.event === 'second-instance')).toBeUndefined();
  });
});

describe('单实例锁：有锁分支', () => {
  it('注册 second-instance 且不 quit', async () => {
    await loadMain();

    expect(h.appMock.quit).not.toHaveBeenCalled();
    expect(getSecondInstanceCb()).toBeTypeOf('function');
  });

  it('最小化可见窗口 → show（恢复）+ focus', async () => {
    const win = mkWindow({ visible: true, minimized: true });
    h.getAllWindows.mockReturnValue([win]);
    await loadMain();

    getSecondInstanceCb()();

    // 摘掉 win.show() 或 win.focus() 的任一调用 → 此处必红（接线锁）
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('未最小化可见窗口 → 仅 focus，不重复 show', async () => {
    const win = mkWindow({ visible: true, minimized: false });
    h.getAllWindows.mockReturnValue([win]);
    await loadMain();

    getSecondInstanceCb()();

    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('多窗口时只聚焦第一个可见窗口（隐藏窗口不受影响）', async () => {
    const hidden = mkWindow({ visible: false, minimized: false });
    const target = mkWindow({ visible: true, minimized: true });
    h.getAllWindows.mockReturnValue([hidden, target]);
    await loadMain();

    getSecondInstanceCb()();

    expect(hidden.show).not.toHaveBeenCalled();
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(target.show).toHaveBeenCalledTimes(1);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('无任何可见窗口 → 安静返回不抛错', async () => {
    h.getAllWindows.mockReturnValue([mkWindow({ visible: false, minimized: false })]);
    await loadMain();

    expect(() => getSecondInstanceCb()()).not.toThrow();
  });
});
