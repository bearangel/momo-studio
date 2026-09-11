// electron/tests/browser/manager.test.ts
//
// BrowserManager 编排语义测试——mock 收窄在 Electron 视图边界（ViewFactory / webContents
// 对象），policy 用真实实现（mock 仅替换 Electron 面，momo-test-rules）。mock 视图的事件
// 注册/触发参数序与真实 Electron 一致（console-message: (event, level, message, line,
// sourceId）；render-process-gone: (event, details)；before-input-event: (event, input)）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ABOUT_BLANK, BrowserManager } from '../../src/main/browser/manager';
import type { ManagedView, ManagedWebContents, ViewFactory } from '../../src/main/browser/manager';
import { BrowserPolicy } from '../../src/main/browser/policy';
import {
  BrowserNavigationError,
  BrowserNoViewError,
  BrowserProtocolError,
  BrowserSelectorError,
  BrowserSnapshotError,
  BrowserTakenOverError,
  EvaluateDisabledError,
} from '../../src/main/browser/errors';
import type { BrowserState, WorkspaceBrowserSettings } from '../../src/main/browser/types';

// =================================================================================
// mock 视图（仿真 Electron webContents 事件面）
// =================================================================================

type Handler = (...args: unknown[]) => void;

interface MockView {
  view: ManagedView;
  handlers: Map<string, Handler>;
  inputEvents: Array<Record<string, unknown>>;
  emit: (ev: string, ...args: unknown[]) => void;
  /** 触发 window-open 收编 handler 并返回其结果（真实面：details 对象） */
  emitWindowOpen: (url: string) => unknown;
  setUrl: (u: string) => void;
  setTitle: (t: string) => void;
  readonly url: string;
}

function mkMockView(): MockView {
  const handlers = new Map<string, Handler>();
  let currentUrl = '';
  let currentTitle = '';
  const inputEvents: Array<Record<string, unknown>> = [];

  const webContents: ManagedWebContents = {
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    on: vi.fn((ev: string, fn: Handler) => {
      handlers.set(ev, fn);
    }),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn((e: unknown) => {
      if (typeof e === 'object' && e !== null) inputEvents.push(e as Record<string, unknown>);
    }),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('fake-png') })),
    setWindowOpenHandler: vi.fn((fn: Handler) => {
      handlers.set('--window-open', fn);
    }),
    reload: vi.fn(),
    getURL: () => currentUrl,
    getTitle: () => currentTitle,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({ nodes: [] })),
    },
  };

  const view: ManagedView = {
    webContents,
    bounds: { setBounds: vi.fn() },
  };

  return {
    view,
    handlers,
    inputEvents,
    emit: (ev, ...args) => handlers.get(ev)?.(...args),
    emitWindowOpen: (url) => handlers.get('--window-open')?.({ url }),
    setUrl: (u) => {
      currentUrl = u;
    },
    setTitle: (t) => {
      currentTitle = t;
    },
    get url() {
      return currentUrl;
    },
  };
}

// =================================================================================
// mock ViewFactory
// =================================================================================

interface MockFactory extends ViewFactory {
  views: MockView[];
  /** 已被 destroy 的 view 集合（set 中以 view 对象为键） */
  destroyed: WeakSet<ManagedView>;
  clearData: Mock;
}

function mkFactory(createView: () => MockView = () => mkMockView()): MockFactory {
  const views: MockView[] = [];
  const destroyed = new WeakSet<ManagedView>();
  return {
    views,
    destroyed,
    create: vi.fn((_wsId: string) => {
      const h = createView();
      views.push(h);
      return h.view;
    }) as unknown as ViewFactory['create'],
    destroy: vi.fn((v: ManagedView) => {
      destroyed.add(v);
    }) as unknown as ViewFactory['destroy'],
    clearData: vi.fn(async (_wsId: string) => undefined),
  };
}

// =================================================================================
// manager 构造助手
// =================================================================================

const baseSettings: WorkspaceBrowserSettings = {
  trust: 'always',
  evaluateEnabled: false,
  blacklist: ['evil.com'],
  whitelist: [],
};

interface Sut {
  manager: BrowserManager;
  factory: MockFactory;
  policy: BrowserPolicy;
  pushState: Mock;
  pushNotice: Mock;
}

function mkManager(over: Partial<WorkspaceBrowserSettings> = {}): Sut {
  const factory = mkFactory();
  const policy = new BrowserPolicy(() => ({ ...baseSettings, ...over }), '/ws/root');
  const pushState = vi.fn();
  const pushNotice = vi.fn();
  const manager = new BrowserManager(factory, policy, { pushState, pushNotice });
  return { manager, factory, policy, pushState, pushNotice };
}

function lastState(pushState: Mock): BrowserState | undefined {
  const last = pushState.mock.calls.at(-1);
  if (!last || !last[0]) return undefined;
  return last[0] as BrowserState;
}

// =================================================================================
// navigate
// =================================================================================

describe('navigate', () => {
  it('无视图时懒建首 tab；loadURL 后 pushState 携带 tabs/url/title', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    const res = await manager.navigate('ws1', 'http://localhost:5173/');
    expect(factory.create).toHaveBeenCalledTimes(1);
    const v0 = factory.views[0]!;
    expect(v0.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
    expect(res).toEqual({ url: 'http://localhost:5173/', title: '' });
    const st = lastState(pushState);
    expect(st?.tabs).toEqual([{ index: 0, url: 'http://localhost:5173/', title: '' }]);
    expect(st?.url).toBe('http://localhost:5173/');
    expect(st?.current).toBe(0);
    expect(st?.takeover).toBe('agent');
    expect(st?.workspaceId).toBe('ws1');
  });

  it('policy.assertUrl 被 spy 调用；越界 URL 抛错且不建视图', async () => {
    const { manager, factory, policy, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    // 清除 activate 触发的 pushState——本用例断言 navigate 失败路径不推 state
    pushState.mockClear();
    const spy = vi.spyOn(policy, 'assertUrl');
    await expect(manager.navigate('ws1', 'ftp://example.com/f')).rejects.toThrow(BrowserProtocolError);
    expect(spy).toHaveBeenCalledWith('ws1', 'ftp://example.com/f');
    expect(factory.create).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('已有视图时 navigate 复用当前 tab（不新建视图）', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.navigate('ws1', 'http://localhost:3000/');
    expect(factory.create).toHaveBeenCalledTimes(1);
    const v0 = factory.views[0]!;
    expect(v0.view.webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(v0.view.webContents.loadURL).toHaveBeenNthCalledWith(2, 'http://localhost:3000/');
  });

  it('loadURL 失败 → BrowserNavigationError（description 透传）', async () => {
    const bad = mkMockView();
    (bad.view.webContents.loadURL as Mock).mockRejectedValue(new Error('ERR_CONNECTION_REFUSED'));
    const factory = mkFactory(() => bad);
    const policy = new BrowserPolicy(() => baseSettings, '/ws/root');
    const manager = new BrowserManager(factory, policy, { pushState: vi.fn(), pushNotice: vi.fn() });
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await expect(manager.navigate('ws1', 'http://localhost:9999/')).rejects.toThrow(BrowserNavigationError);
    await expect(manager.navigate('ws1', 'http://localhost:9999/')).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  });
});

// =================================================================================
// tabsAction
// =================================================================================

describe('tabsAction', () => {
  it('list 返回 TabInfo 快照，无副作用（不推 state）', async () => {
    const { manager, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const callsBefore = pushState.mock.calls.length;
    const tabs = await manager.tabsAction('ws1', 'list');
    expect(tabs).toEqual([{ index: 0, url: 'http://localhost:5173/', title: '' }]);
    expect(pushState).toHaveBeenCalledTimes(callsBefore);
  });

  it('open 建视图，新 tab 成为 current；pushState 携带全部 tabs', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const tabs = await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/');
    expect(factory.create).toHaveBeenCalledTimes(2);
    const st = lastState(pushState);
    expect(st?.tabs).toHaveLength(2);
    expect(st?.current).toBe(1);
    expect(st?.tabs[1]).toMatchObject({ index: 1, url: 'http://localhost:3000/' });
    expect(tabs.map((t) => t.url)).toEqual(['http://localhost:5173/', 'http://localhost:3000/']);
  });

  it('open 无 url → ABOUT_BLANK 初始页，不经 policy.assertUrl', async () => {
    const { manager, factory, policy, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const spy = vi.spyOn(policy, 'assertUrl');
    await manager.tabsAction('ws1', 'open');
    expect(spy).not.toHaveBeenCalled();
    const v1 = factory.views[1]!;
    expect(v1.view.webContents.loadURL).toHaveBeenCalledWith(ABOUT_BLANK);
    expect(lastState(pushState)?.tabs[1]).toMatchObject({ url: 'about:blank' });
  });

  it('switch 只改 current 并 pushState；不动视图（不重建、不重载）', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/');
    const before = factory.create.mock.calls.length;
    const v0 = factory.views[0]!;
    const v0LoadCount = (v0.view.webContents.loadURL as Mock).mock.calls.length;
    await manager.tabsAction('ws1', 'switch', 0);
    expect(factory.create).toHaveBeenCalledTimes(before);
    expect(v0.view.webContents.loadURL).toHaveBeenCalledTimes(v0LoadCount);
    expect(lastState(pushState)?.current).toBe(0);
  });

  it('close 当前唯一 tab → 等同 closeBrowser（销毁视图 + 清 stash + 空态）', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    await manager.tabsAction('ws1', 'close');
    expect(factory.destroyed.has(v0.view)).toBe(true);
    const st = lastState(pushState);
    expect(st?.tabs).toEqual([]);
    expect(st?.current).toBe(0);
    // stash 已清：再 deactivate/activate 仍是空态（不重建视图）
    manager.onWorkspaceDeactivated('ws1');
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(lastState(pushState)?.tabs).toEqual([]);
  });

  it('close 多 tab 中的非当前 → 销毁视图 + current 调整', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // idx 0
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // idx 1, current=1
    const v0 = factory.views[0]!;
    await manager.tabsAction('ws1', 'close', 0);
    expect(factory.destroyed.has(v0.view)).toBe(true);
    const st = lastState(pushState);
    expect(st?.tabs).toHaveLength(1);
    expect(st?.current).toBe(0);
  });

  it('index 越界（close / switch）→ RangeError，中文信息', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await expect(manager.tabsAction('ws1', 'close', 9)).rejects.toThrow(/越界|不存在/);
    await expect(manager.tabsAction('ws1', 'switch', 9)).rejects.toThrow(/越界|不存在/);
  });
});

// =================================================================================
// takeover 状态机
// =================================================================================

describe('takeover', () => {
  it('三入口收敛 userTakeover：显式按钮 / userNavigate / before-input-event → 均置 user', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;

    // 入口 1：显式按钮（IPC 调用 manager.userTakeover）
    manager.userTakeover('ws1');
    expect(lastState(pushState)?.takeover).toBe('user');
    manager.releaseTakeover('ws1');
    expect(lastState(pushState)?.takeover).toBe('agent');

    // 入口 2：地址栏回车（userNavigate 隐式接管）
    await manager.userNavigate('ws1', 'http://localhost:3000/');
    expect(lastState(pushState)?.takeover).toBe('user');
    expect(v0.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000/');
    manager.releaseTakeover('ws1');
    expect(lastState(pushState)?.takeover).toBe('agent');

    // 入口 3：页内键盘输入（before-input-event: char 触发接管）
    v0.emit('before-input-event', undefined, { type: 'char', key: 'a' });
    expect(lastState(pushState)?.takeover).toBe('user');
  });

  it('user 态下 browser_* 工具立即抛 BrowserTakenOverError；release 后恢复', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    manager.userTakeover('ws1');
    await expect(manager.navigate('ws1', 'http://localhost:3000/')).rejects.toThrow(BrowserTakenOverError);
    await expect(manager.consoleMessages('ws1')).rejects.toThrow(BrowserTakenOverError);
    await expect(manager.evaluate('ws1', '1+1')).rejects.toThrow(BrowserTakenOverError);
    await expect(manager.tabsAction('ws1', 'open', undefined, 'http://localhost:4000/')).rejects.toThrow(BrowserTakenOverError);
    await expect(manager.closeBrowser('ws1')).rejects.toThrow(BrowserTakenOverError);
    manager.releaseTakeover('ws1');
    await expect(manager.navigate('ws1', 'http://localhost:3000/')).resolves.toBeTruthy();
  });

  it('before-input-event 修饰键不触发接管（误触发防线）', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    // 单独 Shift / Control 不计接管
    v0.emit('before-input-event', undefined, { type: 'keyDown', key: 'Shift' });
    expect(lastState(pushState)?.takeover).toBe('agent');
    v0.emit('before-input-event', undefined, { type: 'keyDown', key: 'Control' });
    expect(lastState(pushState)?.takeover).toBe('agent');
    // rawKeyDown 非主输入事件，不触发（Chromium auto-repeat 内部用）
    v0.emit('before-input-event', undefined, { type: 'rawKeyDown', key: 'a' });
    expect(lastState(pushState)?.takeover).toBe('agent');
    // 字符型输入触发
    v0.emit('before-input-event', undefined, { type: 'char', key: 'a' });
    expect(lastState(pushState)?.takeover).toBe('user');
  });

  it('agent 自身 sendInputEvent 期间 before-input-event 不翻转 takeover（自锁）', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    // 仿真 sendInputEvent 在真实环境可能回流 before-input-event——压栈自锁
    (v0.view.webContents.sendInputEvent as Mock).mockImplementation((e: unknown) => {
      v0.inputEvents.push((typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>);
      if (typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'keyDown') {
        v0.emit('before-input-event', undefined, { type: 'keyDown', key: String((e as Record<string, unknown>).keyCode) });
      }
    });
    await manager.pressKey('ws1', 'Enter');
    // 自锁守住：agent 动作期间回流的事件不计接管
    expect(manager.getState('ws1').takeover).toBe('agent');
  });

  it('userNavigate：策略越界 URL → 抛 BrowserProtocolError 且未接管', async () => {
    const { manager, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await expect(manager.userNavigate('ws1', 'javascript:alert(1)')).rejects.toThrow(BrowserProtocolError);
    expect(lastState(pushState)?.takeover).toBe('agent');
  });

  it('releaseTakeover 对非接管态 / 非活跃 workspace 幂等 no-op', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    // agent 态释放 no-op
    manager.releaseTakeover('ws1');
    manager.releaseTakeover('ws1');
    // 不活跃 ws 释放 no-op
    manager.releaseTakeover('ws-none');
  });

  it('user 态下 closeBrowser 抛 BrowserTakenOverError（tool 一律被拦）', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    manager.userTakeover('ws1');
    await expect(manager.closeBrowser('ws1')).rejects.toThrow(BrowserTakenOverError);
  });
});

// =================================================================================
// workspace 切换
// =================================================================================

describe('workspace 切换', () => {
  it('deactivate 销毁全部 view 并 stash {urls,current}；activate 按 stash 重建并恢复 current（重建不经策略）', async () => {
    const { manager, factory, policy, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // idx 0
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // current=1
    const v0 = factory.views[0]!;
    const v1 = factory.views[1]!;
    expect(v0.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
    expect(v1.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000/');
    manager.onWorkspaceDeactivated('ws1');
    expect(factory.destroy).toHaveBeenCalledTimes(2);
    expect(factory.destroyed.has(v0.view)).toBe(true);
    expect(factory.destroyed.has(v1.view)).toBe(true);
    const spy = vi.spyOn(policy, 'assertUrl');
    spy.mockClear();
    const createdBefore = factory.create.mock.calls.length;
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    expect(factory.create.mock.calls.length).toBe(createdBefore + 2);
    // 重建视图 loadURL 用 stash urls（火 forget）
    const v2 = factory.views[2]!;
    const v3 = factory.views[3]!;
    expect(v2.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
    expect(v3.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000/');
    // 重建不重过 assertUrl（stash 是内部恢复，非 tool/用户输入）
    expect(spy).not.toHaveBeenCalled();
    const st = lastState(pushState);
    expect(st?.current).toBe(1);
    expect(st?.tabs.map((t) => t.url)).toEqual(['http://localhost:5173/', 'http://localhost:3000/']);
  });

  it('无 stash → activate 推送空态（无视图，地址栏引导）', () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws2', '/ws/ws2');
    expect(factory.create).not.toHaveBeenCalled();
    const st = lastState(pushState);
    expect(st?.workspaceId).toBe('ws2');
    expect(st?.tabs).toEqual([]);
    expect(st?.current).toBe(0);
    expect(st?.url).toBe('');
    expect(st?.title).toBe('');
  });

  it('切走后旧 workspace 的工具调用 → BrowserNoViewError（单活跃不变量）', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    manager.onWorkspaceDeactivated('ws1');
    await expect(manager.navigate('ws1', 'http://localhost:3000/')).rejects.toThrow(BrowserNoViewError);
    await expect(manager.consoleMessages('ws1')).rejects.toThrow(BrowserNoViewError);
  });

  it('onWorkspaceDeactivated 对非活跃 ws 幂等 no-op', () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceDeactivated('ws-none');
    expect(factory.destroy).not.toHaveBeenCalled();
  });

  it('激活接管态 workspace 后 takeover 复位 agent（全新仲裁）', async () => {
    const { manager, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    manager.userTakeover('ws1');
    expect(lastState(pushState)?.takeover).toBe('user');
    manager.onWorkspaceDeactivated('ws1');
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    expect(lastState(pushState)?.takeover).toBe('agent');
    // 重激活按 stash 重建（v0=5173）
    expect(lastState(pushState)?.tabs.map((t) => t.url)).toEqual(['http://localhost:5173/']);
  });
});

// =================================================================================
// 硬化接线锁
// =================================================================================

describe('硬化接线：setWindowOpenHandler / render-process-gone / will-download', () => {
  it('每个新建 view 都注册 setWindowOpenHandler；handler 返回 {action:"deny"} 并触发 openTab 收编', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open');
    for (const h of factory.views) {
      expect(h.view.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    }
    const v0 = factory.views[0]!;
    const ret = v0.emitWindowOpen('https://good.com/x');
    expect(ret).toEqual({ action: 'deny' });
    const st = lastState(pushState);
    expect(st?.tabs).toHaveLength(3);
    expect(st?.current).toBe(2);
    expect(st?.tabs[2]).toMatchObject({ url: 'https://good.com/x' });
  });

  it('popup URL 命中策略 → 拒收编 + notice（防御纵深）', async () => {
    const { manager, factory, pushNotice } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    const ret = v0.emitWindowOpen('http://evil.com/payload');
    expect(ret).toEqual({ action: 'deny' });
    expect(pushNotice).toHaveBeenCalledWith('popup-blocked', expect.stringContaining('evil.com'));
    // 未收编：仍 1 tab
    expect(manager.getState('ws1').tabs).toHaveLength(1);
  });

  it('render-process-gone → reload() 被调 + notice 推送', async () => {
    const { manager, factory, pushNotice } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    v0.emit('render-process-gone', undefined, { reason: 'oom', exitCode: 5 });
    expect(v0.view.webContents.reload).toHaveBeenCalledTimes(1);
    expect(pushNotice).toHaveBeenCalledWith('crash-reloaded', '页面渲染进程崩溃，已自动重载');
  });

  // will-download 由 view-factory 真实现负责（Electron session 级事件，mock 收不到）；
  // view-factory 头注释契约文档化：factory.create 时对 partition session.on('will-download')
  // 注册 preventDefault + pushNotice('download-blocked', ...)；e2e（T11）兜底覆盖。
});

// =================================================================================
// console buffer
// =================================================================================

describe('console buffer 环形 50', () => {
  it('每 tab 独立环形：注入 60 条 → 保留后 50；首条为第 11 条；切 tab 不串', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open');
    const v0 = factory.views[0]!;
    const v1 = factory.views[1]!;
    for (let i = 1; i <= 60; i++) {
      v0.emit('console-message', undefined, i % 4, `msg-${i}`, i, 'src.js');
    }
    v1.emit('console-message', undefined, 0, 'other-tab-line', 1, '');
    await manager.tabsAction('ws1', 'switch', 0);
    const msgs = await manager.consoleMessages('ws1');
    expect(msgs).toHaveLength(50);
    expect(msgs[0]).toContain('msg-11');
    expect(msgs[49]).toContain('msg-60');
    expect(msgs.join('\n')).not.toContain('msg-10');
    expect(msgs[0]).toMatch(/^\[/); // 级别前缀 [info/warning/error/verbose]
    await manager.tabsAction('ws1', 'switch', 1);
    const m1 = await manager.consoleMessages('ws1');
    expect(m1).toHaveLength(1);
    expect(m1[0]).toContain('other-tab-line');
  });

  it('close tab 后其 console buffer 随 serial 键释放（不漂移）', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open');
    const v0 = factory.views[0]!;
    const v1 = factory.views[1]!;
    v0.emit('console-message', undefined, 0, 'tab0-only', 1, '');
    v1.emit('console-message', undefined, 0, 'tab1-only', 1, '');
    // 关闭 tab0，tab1 仍有独立缓冲（serial 键控，无数组索引漂移）
    await manager.tabsAction('ws1', 'close', 0);
    const m = await manager.consoleMessages('ws1');
    expect(m).toEqual([expect.stringContaining('tab1-only')]);
    expect(m.join('\n')).not.toContain('tab0-only');
  });
});

// =================================================================================
// bounds / 折叠 / 生命周期 / clearBrowsingData
// =================================================================================

describe('sidebar bounds / 折叠 / 生命周期', () => {
  it('setSidebarBounds 透传到当前 view 的 setBounds', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open');
    const v0 = factory.views[0]!;
    const v1 = factory.views[1]!;
    const rect = { x: 10, y: 20, width: 380, height: 600 };
    manager.setSidebarBounds(rect);
    expect(v0.view.bounds.setBounds).not.toHaveBeenCalled();
    expect(v1.view.bounds.setBounds).toHaveBeenCalledWith(rect);
  });

  it('setSidebarBounds 无视图 → no-op（不抛错）', () => {
    const { manager } = mkManager();
    expect(() => manager.setSidebarBounds({ x: 0, y: 0, width: 380, height: 600 })).not.toThrow();
  });

  // ---- lastRect 缓存回归锁（review fix：新 current 视图不等 renderer 重报，立即套用缓存 rect）----

  it('lastRect 缓存：setSidebarBounds 后 tabsAction open → 新 current 视图立即收到 setBounds(rect)', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // v0 = current
    const rect = { x: 10, y: 20, width: 380, height: 600 };
    manager.setSidebarBounds(rect);
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // v1 成为 current
    const v1 = factory.views[1]!;
    expect(v1.view.bounds.setBounds).toHaveBeenCalledWith(rect);
    expect(v1.view.bounds.setBounds).toHaveBeenCalledTimes(1);
  });

  it('lastRect 缓存：switch 到另一 tab → 该 tab 视图收到 setBounds(rect)', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // idx 0
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // current=1
    const v0 = factory.views[0]!;
    const rect = { x: 5, y: 6, width: 200, height: 100 };
    manager.setSidebarBounds(rect); // 透传到当前 v1；v0 尚无 bounds
    expect(v0.view.bounds.setBounds).not.toHaveBeenCalled();
    await manager.tabsAction('ws1', 'switch', 0);
    expect(v0.view.bounds.setBounds).toHaveBeenCalledWith(rect);
    expect(v0.view.bounds.setBounds).toHaveBeenCalledTimes(1);
  });

  it('lastRect 缓存：deactivate → activate（stash 恢复）→ 恢复后的 current 视图收到 setBounds(rect)', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // idx 0
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // current=1
    const rect = { x: 1, y: 2, width: 300, height: 400 };
    manager.setSidebarBounds(rect);
    manager.onWorkspaceDeactivated('ws1');
    manager.onWorkspaceActivated('ws1', '/ws/ws1'); // 恢复 → 新建 v2(5173)/v3(3000)，current=1
    const v2 = factory.views[2]!;
    const v3 = factory.views[3]!;
    expect(v3.view.bounds.setBounds).toHaveBeenCalledWith(rect); // current 视图立即套用
    expect(v2.view.bounds.setBounds).not.toHaveBeenCalled(); // 只套用 newly-current——非当前视图不动
  });

  it('从未 setSidebarBounds → 新建/切换/恢复的视图一律不收 setBounds（null 缓存不误用）', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/'); // 懒建
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // open
    await manager.tabsAction('ws1', 'switch', 0); // switch
    manager.onWorkspaceDeactivated('ws1');
    manager.onWorkspaceActivated('ws1', '/ws/ws1'); // stash 恢复
    for (const h of factory.views) {
      expect(h.view.bounds.setBounds).not.toHaveBeenCalled();
    }
  });

  it('setSidebarCollapsed(true) 销毁视图；折叠期间活动先恢复旧清单再作用（不丢 tab）；false 维持已恢复', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    await manager.tabsAction('ws1', 'open', undefined, 'http://localhost:3000/'); // current=1
    const v0 = factory.views[0]!;
    const v1 = factory.views[1]!;
    manager.setSidebarCollapsed('ws1', true);
    expect(factory.destroy).toHaveBeenCalledTimes(2);
    expect(factory.destroyed.has(v0.view)).toBe(true);
    expect(factory.destroyed.has(v1.view)).toBe(true);
    // 折叠期间 agent navigate → 先按折叠前清单恢复（2 个 view），再载入目标到 current
    const before = factory.create.mock.calls.length;
    await manager.navigate('ws1', 'http://localhost:8080/');
    expect(factory.create.mock.calls.length).toBe(before + 2);
    const st = manager.getState('ws1');
    expect(st.tabs.map((t) => t.url)).toEqual(['http://localhost:5173/', 'http://localhost:8080/']);
    expect(st.current).toBe(1);
    // 展开不再重复重建（视图已存在）
    const beforeExpand = factory.create.mock.calls.length;
    manager.setSidebarCollapsed('ws1', false);
    expect(factory.create.mock.calls.length).toBe(beforeExpand);
    expect(manager.getState('ws1').tabs).toHaveLength(2);
  });

  it('clearBrowsingData 委托 factory.clearData(wsId)，不经接管门（设置页路径）', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    // 用户接管态下仍可清除（设置页调用，非 browser_* 工具）
    manager.userTakeover('ws1');
    await manager.clearBrowsingData('ws1');
    expect(factory.clearData).toHaveBeenCalledWith('ws1');
  });

  it('disposeAll 销毁活跃视图；之后 navigate → NoViewError', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    manager.disposeAll();
    expect(factory.destroyed.has(v0.view)).toBe(true);
    await expect(manager.navigate('ws1', 'http://localhost:3000/')).rejects.toThrow(BrowserNoViewError);
  });
});

// =================================================================================
// 动作原语（T3 起委托 actions.ts——selector 四语法 + trusted 事件序列；此处锁
// manager 编排语义：门控 + 输入自锁 + 事件序列。executeJavaScript mock 返回真实页内
// 脚本输出形态——JSON 字符串，见 actions.test.ts）
// =================================================================================

describe('动作原语（委托 actions.ts——T3 四语法接线）', () => {
  it('click：css 命中 → mouseDown/Up 于元素中心；executeJavaScript 注入解析脚本', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    (v0.view.webContents.executeJavaScript as Mock).mockResolvedValue(
      JSON.stringify({
        rect: { x: 100, y: 200, width: 50, height: 20, description: 'button "Go"' },
        hints: [],
      }),
    );
    await manager.click('ws1', '#go');
    expect(v0.view.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('#go'));
    expect(v0.inputEvents[0]).toMatchObject({ type: 'mouseDown', x: 125, y: 210, button: 'left' });
    expect(v0.inputEvents[1]).toMatchObject({ type: 'mouseUp', x: 125, y: 210, button: 'left' });
  });

  it('click：未命中（rect:null）→ BrowserSelectorError，message 含「已匹配 0 个」与页内提示', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    (v0.view.webContents.executeJavaScript as Mock).mockResolvedValue(
      JSON.stringify({ rect: null, hints: ['button "登录" → text=登录'] }),
    );
    await expect(manager.click('ws1', '.missing')).rejects.toThrow(BrowserSelectorError);
    await expect(manager.click('ws1', '.missing')).rejects.toThrow(/已匹配 0 个/);
    await expect(manager.click('ws1', '.missing')).rejects.toThrow(/text=登录/);
  });

  it('type：先 click 聚焦 → char 逐字符 → submit Enter', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    (v0.view.webContents.executeJavaScript as Mock).mockResolvedValue(
      JSON.stringify({
        rect: { x: 0, y: 0, width: 100, height: 24, description: 'input' },
        hints: [],
      }),
    );
    await manager.type('ws1', '#q', 'hi', true);
    // mouseDown/Up 聚焦 + char 'h' + char 'i' + keyDown Enter + keyUp Enter
    const types = v0.inputEvents.map((e) => e['type']);
    expect(types).toEqual(['mouseDown', 'mouseUp', 'char', 'char', 'keyDown', 'keyUp']);
    expect(v0.inputEvents[2]).toMatchObject({ type: 'char', keyCode: 'h' });
    expect(v0.inputEvents[3]).toMatchObject({ type: 'char', keyCode: 'i' });
    expect(v0.inputEvents[4]).toMatchObject({ type: 'keyDown', keyCode: 'Enter' });
  });

  it('pressKey：keyDown + keyUp；scroll：mouseWheel 方向与 amount 缺省', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    await manager.pressKey('ws1', 'Enter');
    expect(v0.inputEvents[0]).toMatchObject({ type: 'keyDown', keyCode: 'Enter' });
    expect(v0.inputEvents[1]).toMatchObject({ type: 'keyUp', keyCode: 'Enter' });
    v0.inputEvents.length = 0;
    await manager.scroll('ws1', 'down');
    expect(v0.inputEvents[0]).toMatchObject({ type: 'mouseWheel', deltaY: 300 }); // 3 格 × 100px
    v0.inputEvents.length = 0;
    await manager.scroll('ws1', 'up', 5);
    expect(v0.inputEvents[0]).toMatchObject({ type: 'mouseWheel', deltaY: -500 });
  });

  it('evaluate：evaluateEnabled false → EvaluateDisabledError；true 透传 executeJavaScript；无视图 NoView', async () => {
    const off = mkManager({ evaluateEnabled: false });
    off.manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await off.manager.navigate('ws1', 'http://localhost:5173/');
    await expect(off.manager.evaluate('ws1', '1+1')).rejects.toThrow(EvaluateDisabledError);

    const on = mkManager({ evaluateEnabled: true });
    on.manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await on.manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = on.factory.views[0]!;
    (v0.view.webContents.executeJavaScript as Mock).mockResolvedValue(42);
    await expect(on.manager.evaluate('ws1', '1+1')).resolves.toBe(42);
    expect(v0.view.webContents.executeJavaScript).toHaveBeenCalledWith('1+1');

    // 无视图 → NoView
    const noView = mkManager({ evaluateEnabled: true });
    await expect(noView.manager.evaluate('ws1', '1+1')).rejects.toThrow(BrowserNoViewError);
  });

  it('snapshot：委托 snapshot.ts——attach("1.3") + getFullAXTree + finally detach；格式化产出提示行；CDP 失败包装 BrowserSnapshotError', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    const dbg = v0.view.webContents.debugger;
    (dbg.sendCommand as Mock).mockResolvedValue({
      nodes: [
        { role: { type: 'role', value: 'button' }, name: { type: 'string', value: '登录' } },
        { role: { type: 'role', value: 'textbox' }, name: { type: 'string', value: '邮箱' } },
      ],
    });
    const out = await manager.snapshot('ws1');
    // 编排契约：懒附加协议版本 + CDP 方法名 + 用完即还；输出含真实格式化器的提示行（委托接线证明）
    expect(dbg.attach).toHaveBeenCalledWith('1.3');
    expect(dbg.sendCommand).toHaveBeenCalledWith('Accessibility.getFullAXTree');
    expect(out).toContain('- button "登录"  → text=登录');
    expect(dbg.detach).toHaveBeenCalledTimes(1);

    // 异常路径：sendCommand reject → BrowserSnapshotError（detail 覆盖见 snapshot.test.ts）+ 仍 detach
    (dbg.sendCommand as Mock).mockRejectedValueOnce(new Error('cdp-fail'));
    await expect(manager.snapshot('ws1')).rejects.toThrow(BrowserSnapshotError);
    expect(dbg.detach).toHaveBeenCalledTimes(2);
  });

  it('snapshot 空树 → 单行引导文案', async () => {
    const { manager, factory } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    (v0.view.webContents.debugger.sendCommand as Mock).mockResolvedValue({ nodes: [] });
    const out = await manager.snapshot('ws1');
    expect(out).toContain('browser_screenshot');
  });

  it('screenshot：capturePage PNG 落盘 + filename 清洗（../../evil.png → evil.png）', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const res = await manager.screenshot('ws1', '../../evil.png');
    expect(res.path).toMatch(/evil\.png$/);
    expect(res.path).not.toContain('..');
    expect(fs.readFileSync(res.path).toString()).toBe('fake-png');
    fs.rmSync(path.dirname(res.path), { recursive: true, force: true });
  });
});

// =================================================================================
// 状态推送（trusted 反映策略；buildState 字段齐）
// =================================================================================

describe('BrowserState 推送', () => {
  it('trusted：trust=always → true；trust=ask 未授权 → false；grantSession 后 → true', () => {
    const { manager, pushState } = mkManager({ trust: 'always' });
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    expect(lastState(pushState)?.trusted).toBe(true);
    pushState.mockClear();
  });

  it('trusted：trust=ask 未授权 → trusted=false；grantSession 后 userTakeover+release 触发 emit → true', async () => {
    const { manager, pushState, policy } = mkManager({ trust: 'ask' });
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    expect(lastState(pushState)?.trusted).toBe(false);
    policy.grantSession('ws1');
    manager.userTakeover('ws1'); // 触发 emit
    manager.releaseTakeover('ws1'); // 触发 emit
    expect(lastState(pushState)?.trusted).toBe(true);
  });

  it('page-title-updated / did-navigate 重新推送 state（地址栏同步）', async () => {
    const { manager, factory, pushState } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const v0 = factory.views[0]!;
    v0.setUrl('http://localhost:5173/sub');
    v0.setTitle('Sub Page');
    v0.emit('did-navigate', undefined, 'http://localhost:5173/sub');
    expect(lastState(pushState)?.url).toBe('http://localhost:5173/sub');
    v0.emit('page-title-updated', undefined, 'Sub Page', true);
    expect(lastState(pushState)?.title).toBe('Sub Page');
  });
});

// =================================================================================
// getState（IPC browser:getState 消费）
// =================================================================================

describe('getState', () => {
  it('活跃 workspace 返回当前 state；非活跃返回空壳（trusted 按策略计算）', async () => {
    const { manager } = mkManager({ trust: 'always' });
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    const st1 = manager.getState('ws1');
    expect(st1.tabs).toHaveLength(1);
    expect(st1.trusted).toBe(true);

    const st2 = manager.getState('ws-other');
    expect(st2.tabs).toEqual([]);
    expect(st2.current).toBe(0);
    expect(st2.trusted).toBe(true);
  });

  it('非活跃 workspace（activate 后 deactivate）getState 返回空壳', async () => {
    const { manager } = mkManager();
    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    await manager.navigate('ws1', 'http://localhost:5173/');
    manager.onWorkspaceDeactivated('ws1');
    const st = manager.getState('ws1');
    expect(st.tabs).toEqual([]);
  });
});

// 兜底：临时文件清理（screenshot 测试产生）
afterEach(() => {
  const tmp = path.join(os.tmpdir(), 'momo-browser-shots');
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});
