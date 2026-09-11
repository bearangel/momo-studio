// electron/tests/browser/boot-wiring.test.ts
//
// boot 组装模块测试（v2.7 McpBrowser Task 10）。
//
// SUT = browser/boot.ts（纯依赖注入，零 electron import）：
//   - 组装序（T7 契约）：createBrowserPushHooks 先于 new BrowserManager；
//     pushState 包装层在每次推送后按 takeover 施加鼠标穿透（DoD 17 映射锁）
//   - initBrowserTools 以同一 policy/manager 实例接线（vi.mock 捕获）
//   - screenshotDir = <userData>/browser-screenshots（构造注入 manager + protocol 共享）
//   - attachToWindow：推送面定标到窗口 webContents + 14 通道注册 + 二次 attach 重定标不重注册
//   - switchWorkspace：激活/切走收口（deactivated/activated 语义经 getState 锁定）
//   - bindLifecycle：before-quit 注册 → disposeAll 销毁视图
//
// mock 收窄（momo-test-rules）：browser-tools（模块级 setter 捕获）+ createFactory
// （Electron 视图边界 spy）；其余全真实——真 SQLite + 真 store/policy/manager/协议 handler。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/main/agent/tools/browser-tools', () => ({
  initBrowserTools: vi.fn(),
  __resetBrowserToolsForTest: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { assembleBrowserSubsystem } from '../../src/main/browser/boot';
import type { BrowserBootDeps, BrowserBootHandle } from '../../src/main/browser/boot';
import { initBrowserTools } from '../../src/main/agent/tools/browser-tools';
import { BrowserManager } from '../../src/main/browser/manager';
import type { ManagedView, ManagedWebContents, ViewFactory } from '../../src/main/browser/manager';
import type { IpcMainLike, WebContentsLike } from '../../src/main/browser/ipc';
import type { ProtocolLike } from '../../src/main/browser/protocol';
import type { Mock } from 'vitest';

// =================================================================================
// mock 视图工厂（照抄 manager.test.ts 形态——事件参数序与真实 Electron 一致）
// =================================================================================

function mkMockWc(): ManagedWebContents {
  let url = '';
  const title = '';
  return {
    loadURL: vi.fn(async (u: string) => {
      url = u;
    }),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('boot-png') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => url,
    getTitle: () => title,
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
}

function mkCreateFactory() {
  const created: ManagedView[] = [];
  const factory = {
    created,
    create: vi.fn((_wsId: string) => {
      const view: ManagedView = { webContents: mkMockWc(), bounds: { setBounds: vi.fn() } };
      created.push(view);
      return view;
    }),
    destroy: vi.fn(),
    clearData: vi.fn(async () => undefined),
    setIgnoreMouseEvents: vi.fn(),
    setMountTarget: vi.fn(),
  };
  return factory;
}
type MockFactory = ReturnType<typeof mkCreateFactory> & ViewFactory & { setIgnoreMouseEvents: Mock };

// =================================================================================
// 捕获桩：ipcMain / webContents / protocol / app
// =================================================================================

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const ipcMainLike: IpcMainLike = {
  handle: (channel, fn) => {
    handlers.set(channel, fn);
  },
};

function mkWebContents() {
  const sends: Array<{ channel: string; args: unknown[] }> = [];
  const wc: WebContentsLike = {
    send: (channel, ...args) => {
      sends.push({ channel, args });
    },
  };
  return { wc, sends };
}

const protocolHandlers = new Map<string, (req: { url: string }) => Response | Promise<Response>>();
const protocolLike: ProtocolLike = {
  handle: (scheme, fn) => {
    protocolHandlers.set(scheme, fn);
  },
};

const lifecycleListeners = new Map<string, () => void>();

// =================================================================================
// SUT 组装
// =================================================================================

const tmpRoot = path.join(os.tmpdir(), `ap-browser-boot-${process.pid}-${Date.now()}`);
let factory: MockFactory;
let handle: BrowserBootHandle;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS1', '', '/tmp/ws-1', 0, '@owner:s', '📁')`,
  ).run();
  handlers.clear();
  protocolHandlers.clear();
  lifecycleListeners.clear();
  factory = mkCreateFactory() as MockFactory;

  const deps: BrowserBootDeps = {
    userDataDir: tmpRoot,
    createFactory: () => factory,
    protocol: protocolLike,
  };
  handle = assembleBrowserSubsystem(deps);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('assembleBrowserSubsystem 组装', () => {
  it('initBrowserTools 以同一 policy/manager 实例接线（工具层依赖注入）', () => {
    expect(initBrowserTools).toHaveBeenCalledTimes(1);
    const [policyArg, managerArg] = (initBrowserTools as Mock).mock.calls[0]!;
    expect(managerArg).toBeInstanceOf(BrowserManager);
    expect(policyArg).toBe(handle.policy);
    expect(managerArg).toBe(handle.manager);
  });

  it('screenshotDir = <userData>/browser-screenshots：screenshot 落注入目录', async () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    await handle.manager.navigate('ws-1', 'http://localhost:5173/');
    const res = await handle.manager.screenshot('ws-1', 'a.png');
    expect(res.path.startsWith(path.join(tmpRoot, 'browser-screenshots', 'ws-1') + path.sep)).toBe(true);
    expect(fs.readFileSync(res.path).toString()).toBe('boot-png');
  });

  it('browser-shot 协议注册共享同一 screenshotDir（截图经协议可回读）', async () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    await handle.manager.navigate('ws-1', 'http://localhost:5173/');
    const shot = await handle.manager.screenshot('ws-1', 'b.png');
    const handler = protocolHandlers.get('browser-shot');
    expect(handler).toBeTypeOf('function');
    const res = await handler!({ url: 'browser-shot://ws-1/b.png' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('boot-png');
    expect(shot.path).toContain('b.png');
  });
});

describe('DoD 17：pushState 包装层鼠标穿透映射', () => {
  it('agent 态推送 → setIgnoreMouseEvents(wsId, true)；接管 user → false', async () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    await handle.manager.navigate('ws-1', 'http://localhost:5173/');
    expect(factory.setIgnoreMouseEvents).toHaveBeenLastCalledWith('ws-1', true);
    handle.manager.userTakeover('ws-1');
    expect(factory.setIgnoreMouseEvents).toHaveBeenLastCalledWith('ws-1', false);
    handle.manager.releaseTakeover('ws-1');
    expect(factory.setIgnoreMouseEvents).toHaveBeenLastCalledWith('ws-1', true);
  });

  it('窗口 attach 前推送不炸（lazy sender 静默）且穿透仍生效', () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    expect(factory.setIgnoreMouseEvents).toHaveBeenCalledWith('ws-1', true);
  });
});

describe('attachToWindow', () => {
  it('注册 14 个 browser: 通道（集合相等锁）', () => {
    const { wc } = mkWebContents();
    handle.attachToWindow(ipcMainLike, wc);
    expect(new Set(handlers.keys())).toEqual(
      new Set([
        'browser:getState',
        'browser:userNavigate',
        'browser:takeover',
        'browser:releaseTakeover',
        'browser:openTab',
        'browser:closeTab',
        'browser:switchTab',
        'browser:setSidebarBounds',
        'browser:setSidebarCollapsed',
        'browser:answerTrust',
        'browser:listDevServers',
        'browser:updateSettings',
        'browser:getSettings',
        'browser:clearBrowsingData',
      ]),
    );
  });

  it('attach 后推送路由到窗口 webContents（lazy sender 定标）', async () => {
    const { wc, sends } = mkWebContents();
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    expect(sends).toHaveLength(0); // attach 前静默
    handle.attachToWindow(ipcMainLike, wc);
    handle.manager.userTakeover('ws-1'); // 触发一次推送
    const stateSends = sends.filter((s) => s.channel === 'browser:state');
    expect(stateSends.length).toBeGreaterThan(0);
    expect((stateSends.at(-1)!.args[0] as { takeover: string }).takeover).toBe('user');
  });

  it('二次 attach（窗口重建）重定标 sender 且不重复注册通道', () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1'); // userTakeover 需活跃 ws 才产生推送
    const a = mkWebContents();
    const b = mkWebContents();
    handle.attachToWindow(ipcMainLike, a.wc);
    const count = handlers.size;
    handle.attachToWindow(ipcMainLike, b.wc);
    expect(handlers.size).toBe(count);
    handle.manager.userTakeover('ws-1');
    expect(b.sends.some((s) => s.channel === 'browser:state')).toBe(true);
  });
});

describe('switchWorkspace（workspace 切换收口）', () => {
  it('激活 ws-1 → 切 ws-2：旧 ws 视图销毁、getState 空壳；新 ws 活跃', async () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    await handle.manager.navigate('ws-1', 'http://localhost:5173/');
    expect(factory.create).toHaveBeenCalledTimes(1);
    handle.switchWorkspace('ws-2', '/tmp/ws-2');
    expect(factory.destroy).toHaveBeenCalledTimes(1); // 旧视图销毁（stash urls 保留）
    expect(handle.manager.getState('ws-1').tabs).toEqual([]); // 旧 ws 空壳
    expect(handle.manager.getState('ws-2').workspaceId).toBe('ws-2'); // 新 ws 活跃
  });
});

describe('bindLifecycle（before-quit）', () => {
  it('注册 before-quit → disposeAll 销毁活跃视图', async () => {
    handle.switchWorkspace('ws-1', '/tmp/ws-1');
    await handle.manager.navigate('ws-1', 'http://localhost:5173/');
    handle.bindLifecycle({ on: (event, listener) => lifecycleListeners.set(event, listener) });
    const quit = lifecycleListeners.get('before-quit');
    expect(quit).toBeTypeOf('function');
    quit!();
    expect(factory.destroy).toHaveBeenCalledTimes(1);
  });
});
