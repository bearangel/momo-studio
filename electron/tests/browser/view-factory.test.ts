// electron/tests/browser/view-factory.test.ts
//
// view-factory 真实现的单测（v2.7 McpBrowser Task 10 + DoD 17 修正）。
//
// 本文件 import 的 SUT 依赖 'electron'（session / WebContentsView）——按仓库既有
// 模式（agent-start-stop.test.ts）vi.mock('electron') 提供结构性假件：
//   - WebContentsView：可实例化类，实例带 webContents（各方法 vi.fn）+ setBounds/
//     setBackgroundColor 记录
//   - session.fromPartition：返回带 on / clearStorageData 的假 session
//
// 覆盖：DoD 17 原生 overlay 方案（三态挂载锁 / 命中 IPC 链 / bounds 跟随 / 栈顶
// 纪律 / 随 tab 全灭销毁 / 页面注入契约 / webPreferences 硬化）+ CDP
// Input.setIgnoreInputEvents 移除回归锁（键盘接管复活前提）+ 视图挂载
// （setMountTarget → create addChildView / destroy removeChildView）+ partition 去重。

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface DbgMock {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
}
type WcMock = {
  loadURL: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  debugger: DbgMock;
  insertCSS: ReturnType<typeof vi.fn>;
  /** 仿真 Electron webContents.ipc（IpcMain 面——overlay 命中通道注册） */
  ipc: { on: ReturnType<typeof vi.fn> };
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** createdViews 条目——断言所需的全部假件面 */
interface CreatedView {
  partition: string;
  wc: WcMock;
  view: unknown;
  webPreferences: Record<string, unknown>;
  getBounds: () => Rect | undefined;
  getBackgroundColor: () => string | undefined;
}

const createdViews: CreatedView[] = [];
const hookedPartitions: string[] = [];

vi.mock('electron', () => {
  class FakeWebContentsView {
    readonly webContents: WcMock;
    private bounds: Rect | undefined;
    private bgColor: string | undefined;
    constructor(opts: { webPreferences: { session: { partitionTag: string } } }) {
      this.webContents = {
        partitionTag: opts.webPreferences.session.partitionTag,
        loadURL: vi.fn(async () => undefined),
        on: vi.fn(),
        executeJavaScript: vi.fn(async () => null),
        insertCSS: vi.fn(async () => 'css-key'),
        sendInputEvent: vi.fn(),
        capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
        setWindowOpenHandler: vi.fn(),
        reload: vi.fn(),
        getURL: vi.fn(() => 'about:blank'),
        getTitle: vi.fn(() => ''),
        close: vi.fn(),
        debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
        ipc: { on: vi.fn() },
      } as unknown as WcMock;
      createdViews.push({
        partition: opts.webPreferences.session.partitionTag,
        wc: this.webContents,
        view: this,
        webPreferences: opts.webPreferences as Record<string, unknown>,
        getBounds: () => this.bounds,
        getBackgroundColor: () => this.bgColor,
      });
    }
    setBounds(b: Rect): void {
      this.bounds = b;
    }
    setBackgroundColor(color: string): void {
      this.bgColor = color;
    }
  }
  return {
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: (partition: string) => ({
        partitionTag: partition,
        on: (event: string) => {
          hookedPartitions.push(`${partition}:${event}`);
        },
        clearStorageData: vi.fn(async () => undefined),
      }),
    },
  };
});

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initRealViewFactory } from '../../src/main/browser/view-factory';
import type { RealFactoryHooks } from '../../src/main/browser/view-factory';
import type { Mock } from 'vitest';

const hooks: RealFactoryHooks = { pushNotice: vi.fn(), onOverlayHit: vi.fn() };

/** 从 createdViews 里取指定 partition 的第一个视图（overlay 用 'browser-overlay'） */
function findView(partition: string): CreatedView {
  const v = createdViews.find((c) => c.partition === partition);
  if (!v) throw new Error(`未找到 partition=${partition} 的视图`);
  return v;
}

function mkMount(): { addChildView: Mock; removeChildView: Mock } {
  return { addChildView: vi.fn(), removeChildView: vi.fn() };
}

/** 冲刷 overlay 页面注入链（loadURL → insertCSS → executeJavaScript 均为立即 resolve 的 mock） */
async function flushInjections(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  createdViews.length = 0;
  hookedPartitions.length = 0;
  vi.mocked(hooks.onOverlayHit).mockClear();
});

describe('initRealViewFactory（tab 视图基础面）', () => {
  it('create 使用 persist:browser-<wsId> partition + will-download 每 ws 仅挂一次', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    factory.create('ws-1');
    factory.create('ws-2');
    expect(createdViews.map((v) => v.partition)).toEqual([
      'persist:browser-ws-1',
      'persist:browser-ws-1',
      'persist:browser-ws-2',
    ]);
    // 3 个视图但 will-download 只挂 2 次（per-partition 去重）
    const downloads = hookedPartitions.filter((p) => p.endsWith(':will-download'));
    expect(downloads).toEqual(['persist:browser-ws-1:will-download', 'persist:browser-ws-2:will-download']);
  });

  it('setMountTarget：create → addChildView；destroy → removeChildView + close', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    const v = factory.create('ws-1');
    expect(mount.addChildView).toHaveBeenCalledTimes(1);
    expect(mount.addChildView).toHaveBeenCalledWith(createdViews[0]!.view);
    factory.destroy(v);
    expect(mount.removeChildView).toHaveBeenCalledWith(createdViews[0]!.view);
    expect(createdViews[0]!.wc.close).toHaveBeenCalledTimes(1);
  });

  it('未设挂载目标时 create 不挂载（boot 窗口创建前的懒建视图安全）', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    // 无挂载目标分支——不抛错即通过
  });
});

describe('showOverlay（DoD 17 原生 overlay——三态锁）', () => {
  it('agent 态 → overlay 挂载且在浏览器视图之上；user 态 → 摘除；再 agent → 重挂', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    // addChildView 附加序即 z 序：browser 先挂、overlay 后挂 = overlay 在上
    const browserView = createdViews[0]!.view;
    const overlay = findView('browser-overlay');
    expect(mount.addChildView).toHaveBeenNthCalledWith(1, browserView);
    expect(mount.addChildView).toHaveBeenNthCalledWith(2, overlay.view);
    factory.showOverlay('ws-1', 'user');
    expect(mount.removeChildView).toHaveBeenCalledWith(overlay.view);
    expect(mount.removeChildView).not.toHaveBeenCalledWith(browserView);
    factory.showOverlay('ws-1', 'agent');
    expect(mount.addChildView).toHaveBeenLastCalledWith(overlay.view);
  });

  it('重复 agent 态调用幂等（pushState 每次推送都会调）——不重复挂载', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    expect(mount.addChildView.mock.calls.filter((c) => c[0] === overlay.view)).toHaveLength(1);
  });

  it('agent 态但 ws 无 tab 视图（空 ws / 折叠 / 切走）→ 不建 overlay', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    factory.showOverlay('ws-1', 'agent');
    expect(createdViews).toHaveLength(0);
  });

  it('无 overlay 时 user 态 no-op 不抛错', () => {
    const factory = initRealViewFactory(hooks);
    expect(() => factory.showOverlay('ws-404', 'user')).not.toThrow();
  });

  it('agent 态新 tab 挂载 → overlay 重挂栈顶（z 序恒在浏览器视图之上）', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    factory.create('ws-1'); // agent 期间 browser_tabs open 新视图——挂到了 overlay 之上
    const newTab = createdViews.at(-1)!;
    expect(mount.addChildView).toHaveBeenNthCalledWith(3, newTab.view);
    // overlay 摘下重挂——恢复末位（栈顶）
    expect(mount.removeChildView).toHaveBeenCalledWith(overlay.view);
    expect(mount.addChildView).toHaveBeenLastCalledWith(overlay.view);
  });
});

describe('overlay 命中链（页内点击 → userTakeover）', () => {
  it('overlay 页面注入：about:blank + 透明 CSS + mousedown 监听（preload 桥契约）', async () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    await flushInjections();
    expect(overlay.wc.loadURL).toHaveBeenCalledWith('about:blank');
    expect(overlay.wc.insertCSS).toHaveBeenCalledWith(
      expect.stringContaining('background: transparent'),
    );
    expect(overlay.wc.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("window.momoOverlay?.hit()"),
    );
  });

  it('overlay webPreferences 硬化：in-memory session + sandbox + contextIsolation + preload + 透明底', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    expect(overlay.webPreferences.nodeIntegration).toBe(false);
    expect(overlay.webPreferences.contextIsolation).toBe(true);
    expect(overlay.webPreferences.sandbox).toBe(true);
    expect(String(overlay.webPreferences.preload)).toContain('overlay-preload.js');
    expect(overlay.getBackgroundColor()).toBe('#00000000');
  });

  it('momo-overlay-hit IPC → onOverlayHit(wsId)（boot 侧接 manager.userTakeover）', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    // 捕获 webContents.ipc.on 注册（模拟真实 IPC 命中到达）
    const ipcOn = overlay.wc.ipc.on;
    expect(ipcOn).toHaveBeenCalledWith('momo-overlay-hit', expect.any(Function));
    const handler = (ipcOn.mock.calls[0]![1] as () => void);
    handler();
    expect(hooks.onOverlayHit).toHaveBeenCalledWith('ws-1');
  });
});

describe('CDP Input.setIgnoreInputEvents 移除（键盘接管回归锁）', () => {
  it('overlay 三态循环 + tab 视图操作全程——任何视图零 debugger 调用', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    factory.create('ws-1');
    factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    factory.showOverlay('ws-1', 'user');
    factory.showOverlay('ws-1', 'agent');
    const v = factory.create('ws-1');
    factory.destroy(v);
    for (const cv of createdViews) {
      expect(cv.wc.debugger.attach).not.toHaveBeenCalled();
      expect(cv.wc.debugger.detach).not.toHaveBeenCalled();
      expect(cv.wc.debugger.sendCommand).not.toHaveBeenCalled();
    }
  });
});

describe('overlay bounds 跟随（与浏览器视图同 rect）', () => {
  it('tab 视图 setBounds → overlay 同 rect；新建 overlay 补套最近 rect', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    const v = factory.create('ws-1');
    v.bounds.setBounds({ x: 10, y: 20, width: 300, height: 200 });
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    expect(overlay.getBounds()).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    // overlay 已存在：后续 rect 变更直接同步
    v.bounds.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    expect(overlay.getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    // 零 rect 卸载路径（BrowserSidebar 卸载上报 {0,0,0,0}）同样跟随
    v.bounds.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    expect(overlay.getBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('user 态摘除期间 rect 变更仍缓存——重挂即最新 rect', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    const v = factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    factory.showOverlay('ws-1', 'user');
    v.bounds.setBounds({ x: 5, y: 6, width: 100, height: 50 });
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    expect(overlay.getBounds()).toEqual({ x: 5, y: 6, width: 100, height: 50 });
  });
});

describe('overlay 生命周期（随 tab 视图全灭销毁）', () => {
  it('关最后一个 tab → overlay 摘除 + close（deactivate/collapse/closeBrowser/disposeAll 共用路径）', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    const v1 = factory.create('ws-1');
    const v2 = factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const overlay = findView('browser-overlay');
    factory.destroy(v1); // 还剩一个 tab——overlay 存活
    expect(overlay.wc.close).not.toHaveBeenCalled();
    factory.destroy(v2); // tab 全灭——overlay 随之销毁
    expect(mount.removeChildView).toHaveBeenCalledWith(overlay.view);
    expect(overlay.wc.close).toHaveBeenCalledTimes(1);
  });

  it('销毁后 agent 态再推送 → overlay 懒重建（重新激活/展开场景）', () => {
    const factory = initRealViewFactory(hooks);
    factory.setMountTarget(mkMount());
    const v = factory.create('ws-1');
    factory.showOverlay('ws-1', 'agent');
    const first = findView('browser-overlay');
    factory.destroy(v); // tab 全灭 + overlay 销毁
    factory.create('ws-1'); // tab 重建（restoreTabs）
    factory.showOverlay('ws-1', 'agent'); // pushState 再到达
    const second = createdViews.filter((c) => c.partition === 'browser-overlay').at(-1)!;
    expect(second.view).not.toBe(first.view); // 新实例——懒重建
    expect(second.wc.close).not.toHaveBeenCalled();
  });

  it('不同 ws overlay 互不干扰（只操作目标 ws）', () => {
    const factory = initRealViewFactory(hooks);
    const mount = mkMount();
    factory.setMountTarget(mount);
    factory.create('ws-1');
    factory.create('ws-2');
    factory.showOverlay('ws-1', 'agent');
    factory.showOverlay('ws-2', 'agent');
    const ov1 = createdViews.find((c) => c.partition === 'browser-overlay')!;
    factory.showOverlay('ws-1', 'user');
    expect(mount.removeChildView).toHaveBeenCalledWith(ov1.view);
    // ws-2 overlay 不受影响（未摘除）
    expect(mount.removeChildView).toHaveBeenCalledTimes(1);
  });
});
