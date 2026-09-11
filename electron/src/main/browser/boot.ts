// electron/src/main/browser/boot.ts
//
// 浏览器子系统组装（v2.7 McpBrowser Task 10，spec §7 生命周期）。
//
// index.ts boot 链的浏览器段收口：runMigrations 后、窗口创建前调用
// assembleBrowserSubsystem（manager 构造 + initBrowserTools + 初始激活可先行），
// 窗口创建后 attachToWindow（推送面定标 + 14 通道注册），before-quit 经
// bindLifecycle 注册 disposeAll。
//
// 本模块零 electron import——Electron 边界（视图工厂 / ipcMain / webContents /
// protocol / app）全部注入，单测直驱（boot-wiring.test.ts）。组装序契约（T7）：
// createBrowserPushHooks 先于 new BrowserManager；pushState 包装层在每次推送后
// 按 takeover 施加 overlay 挂载（DoD 17：agent 态 overlay 挂栈顶拦截页内点击 →
// userTakeover，user 态摘除让真实输入直达页面），映射锁在 boot-wiring 测试。

import path from 'node:path';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { initBrowserTools } from '../agent/tools/browser-tools';
import { BrowserManager } from './manager';
import type { BrowserManagerHooks, ViewFactory } from './manager';
import { BrowserPolicy } from './policy';
import { createBrowserPushHooks, registerBrowserIpc } from './ipc';
import type { IpcMainLike, WebContentsLike } from './ipc';
import { createBrowserSettingsStore } from './settings-store';
import { probeDevServers } from './dev-server-probe';
import { registerBrowserShotProtocol } from './protocol';
import type { ProtocolLike } from './protocol';
import type { RealFactoryHooks, TakeoverViewFactory } from './view-factory';

/** screenshot 落盘根目录名（spec §4 工具 3：`<userData>/browser-screenshots`） */
export const BROWSER_SCREENSHOTS_DIR_NAME = 'browser-screenshots';

/** 组装依赖（Electron 边界全注入） */
export interface BrowserBootDeps {
  /** app.getPath('userData')——screenshot 目录与 browser-shot 协议的共同根 */
  userDataDir: string;
  /** 视图工厂创建器（生产传 (hooks) => initRealViewFactory(hooks)；hooks 含 overlay 命中回调） */
  createFactory: (hooks: RealFactoryHooks) => ViewFactory & TakeoverViewFactory;
  /** electron protocol 注入（app ready 后 handle 才可用；测试传捕获桩） */
  protocol: ProtocolLike;
  /** 探活函数（缺省 dev-server-probe 真实现；测试可注入） */
  probeDevServers?: () => Promise<Array<{ port: number; url: string }>>;
}

/** 组装产物：index.ts boot 链各阶段消费的句柄 */
export interface BrowserBootHandle {
  readonly manager: BrowserManager;
  readonly policy: BrowserPolicy;
  /** 视图工厂（含 overlay 控制/挂载目标面——index.ts 窗口创建后 setMountTarget 挂 contentView） */
  readonly factory: ViewFactory & TakeoverViewFactory;
  /** 窗口创建后接线：推送面定标 + IPC 通道注册（重复调用=窗口重建，仅重定标） */
  attachToWindow(ipcMainLike: IpcMainLike, webContents: WebContentsLike): void;
  /** workspace 激活收口（boot 初始激活 + workspace:switch 切换钩子共用；内部自动切走旧 ws） */
  switchWorkspace(wsId: string, workspaceDir: string): void;
  /** 注册 before-quit → disposeAll（app 生命周期对象注入） */
  bindLifecycle(appLike: { on(event: string, listener: () => void): unknown }): void;
  /** app before-quit：销毁活跃视图（partition 数据自动落盘） */
  disposeAll(): void;
}

/**
 * 组装浏览器子系统。依赖注入序（契约级）：
 *   1. lazy sender + createBrowserPushHooks（推送钩子先成型）
 *   2. createFactory(baseHooks)（视图工厂与 manager 共享同一 notice 面）
 *   3. pushState 包装层（推送 + DoD 17 overlay 挂载）
 *   4. store / policy / manager（screenshotDir 注入）
 *   5. initBrowserTools(policy, manager)——T10 起工具层可用
 */
export function assembleBrowserSubsystem(deps: BrowserBootDeps): BrowserBootHandle {
  const screenshotDir = path.join(deps.userDataDir, BROWSER_SCREENSHOTS_DIR_NAME);

  // 延迟定标的推送 sender：manager 构造需要 hooks，但主窗口 webContents 在
  // 窗口创建后才存在；attach 前推送静默（boot 早期激活无渲染面）
  let senderTarget: WebContentsLike | undefined;
  const lazySender: WebContentsLike = {
    send: (channel, ...args) => senderTarget?.send(channel, ...args),
  };

  const baseHooks = createBrowserPushHooks(lazySender);
  // overlay 命中延迟定标：factory 先于 manager 创建（T7 组装序不可倒），命中回调经
  // 持有者对象转发，manager 成型后填充（DoD 17：页内点击 → manager.userTakeover）
  const overlayHit: { target?: BrowserManager } = {};
  const factory = deps.createFactory({
    pushNotice: baseHooks.pushNotice,
    onOverlayHit: (wsId) => overlayHit.target?.userTakeover(wsId),
  });
  const hooks: BrowserManagerHooks = {
    pushState: (state) => {
      baseHooks.pushState(state);
      // DoD 17：agent 态 overlay 挂栈顶（页内点击 → onOverlayHit → userTakeover）；
      // user 态摘除——键盘/鼠标直达页面（before-input-event 接管路径存活）
      factory.showOverlay(state.workspaceId, state.takeover);
    },
    pushNotice: baseHooks.pushNotice,
  };

  const store = createBrowserSettingsStore(getDb());
  // 初始 root 空串占位——file:// 边界根由 onWorkspaceActivated 动态定标（唯一真相源）
  const policy = new BrowserPolicy(store.read, '');
  const manager = new BrowserManager(factory, policy, hooks, { screenshotDir });
  overlayHit.target = manager;
  initBrowserTools(policy, manager);

  registerBrowserShotProtocol(deps.protocol, screenshotDir);

  let ipcRegistered = false;
  const probe = deps.probeDevServers ?? probeDevServers;

  logger.info('浏览器子系统已组装', { screenshotDir });

  return {
    manager,
    policy,
    factory,
    attachToWindow(ipcMainLike, webContents) {
      senderTarget = webContents;
      // T7 routed 运行时断言：推送面与 invoke 面必须共享同一 webContents——
      // 若未来重构让 attachToWindow 不再是 sender 定标的唯一入口，此断言即红
      if (senderTarget !== webContents) {
        throw new Error('browser 推送面与 invoke 面必须共享同一 webContents（T7 契约）');
      }
      if (ipcRegistered) return; // 窗口重建：handler 已注册（ipcMain 全局），仅重定标 sender
      ipcRegistered = true;
      registerBrowserIpc({ manager, policy, store, probeDevServers: probe }, ipcMainLike, webContents);
    },
    switchWorkspace(wsId, workspaceDir) {
      manager.onWorkspaceActivated(wsId, workspaceDir);
    },
    bindLifecycle(appLike) {
      appLike.on('before-quit', () => manager.disposeAll());
    },
    disposeAll() {
      manager.disposeAll();
    },
  };
}
