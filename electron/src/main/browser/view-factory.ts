// electron/src/main/browser/view-factory.ts
//
// BrowserManager 视图工厂的 Electron 真实现——经 initRealViewFactory(hooks) 与 manager 互认。
//
// 本文件 import 'electron'——单测用 vi.mock('electron') 提供结构性假件
// （view-factory.test.ts）；e2e 在 T11 覆盖真实行为。
//
// 职责分割（与 manager.ts 的接线分工）：
//   - view-factory（本文件）：session 级别——partition 创建、webPreferences 四硬化（C7 节点
//     integration / contextIsolation / sandbox / webSecurity）、session will-download 拦截
//     （C6 popup 收编与 render-process-gone 由 manager 在 wireView 接线——便于纯 Node 单测用
//     mock view 仿真真实 Electron 事件面，详见 manager.wireView 注释）
//   - clearBrowsingData 委托：本文件负责 session.clearStorageData
//   - 视图挂载（T10）：create 时 addChildView 到挂载目标（主窗口 contentView）、
//     destroy 时 removeChildView + webContents.close——挂载目标经 setMountTarget 注入
//   - 页内点击接管 overlay（DoD 17 修正版）：agent 态把透明 overlay 视图挂到浏览器视图
//     之上拦截 mousedown → hooks.onOverlayHit → manager.userTakeover；user 态摘除
//
// "互认"语义：factory 通过 hooks 拿到 pushNotice（下载拦截通知）与 onOverlayHit（页内
// 点击接管）；manager 通过构造注入 factory。在 boot 期（T10 接线）共享同一 hooks 对象。
import path from 'node:path';
import { session, WebContentsView } from 'electron';
import type { ManagedView, ManagedWebContents, ViewFactory } from './manager';
import type { DebugPort, ManagedViewBounds } from './manager';
import { logger } from '../logger';

/** initRealViewFactory 钩子——与 manager 共享（pushNotice 来自 manager 同一 hook 对象） */
export interface RealFactoryHooks {
  /** 下载拦截通知（will-download preventDefault 后推送 UI） */
  pushNotice(kind: string, text: string): void;
  /**
   * 页内点击接管（DoD 17）：overlay mousedown 命中——boot 接 manager.userTakeover(wsId)。
   * factory 按 overlay 归属 ws 传入（命中时无需猜测目标）。
   */
  onOverlayHit(wsId: string): void;
}

/**
 * 页内点击接管控制面（DoD 17 修正版）——boot pushState 包装层按 takeover 调用。
 *
 * 背景（T10 方案退役）：Electron 30 无 per-view setIgnoreMouseEvents API
 * （窗口级；per-view 穿透为上游开放特性请求 electron#49039），T10 曾以 CDP
 * `Input.setIgnoreInputEvents` 近似——但该 flag 同时吞掉键盘输入（before-input-event
 * 接管路径随之失效）且输入被丢弃不重派发给下方视图（renderer DOM overlay 收不到
 * mousedown，页内点击接管死路）。本方案改为**原生 overlay WebContentsView**：
 * agent 态在浏览器视图之上挂一块全透明、完全受控的视图拦截鼠标；user 态整视图摘除，
 * 键盘/鼠标直达页面——两条接管路径（页内点击 + 键盘 before-input-event）都存活。
 */
export interface TakeoverViewFactory {
  /**
   * takeover='agent' → overlay 挂载栈顶（bounds = 最近 tab rect）；'user' → 摘除。
   * ws 无 tab 视图（空 ws / 折叠 / 切走）时 agent 态不建——overlay 生命周期与 tab 视图一致。
   */
  showOverlay(wsId: string, takeover: 'agent' | 'user'): void;
  /** 视图挂载目标（T10：index.ts 窗口创建后传 win.contentView；null = 摘除） */
  setMountTarget(mount: ViewMount | null): void;
}

/** 视图挂载目标（主窗口 contentView 的结构性子集——create/destroy 时挂/摘） */
export interface ViewMount {
  addChildView(view: unknown): void;
  removeChildView(view: unknown): void;
}

/** overlay 视图记录（per ws 懒建——随 tab 视图全灭而销毁） */
interface OverlayRecord {
  view: WebContentsView;
  /** 当前是否在挂载树中（agent 态挂栈顶 / user 态 removeChildView 摘除） */
  attached: boolean;
}

/** overlay 注入的 mousedown 监听脚本（依赖 overlay-preload 暴露的 window.momoOverlay） */
const OVERLAY_MOUSEDOWN_SCRIPT =
  "window.addEventListener('mousedown', () => window.momoOverlay?.hit()); undefined;";

/** overlay 透明底 + 撑满样式（insertCSS 注入 about:blank） */
const OVERLAY_CSS =
  'html, body { background: transparent; margin: 0; width: 100%; height: 100%; }';

/** overlay preload 编译产物路径（tsc 主流水线：src/main/browser → dist/main/browser） */
const overlayPreloadPath = path.join(__dirname, 'overlay-preload.js');

/**
 * 构建真实 Electron 视图工厂。
 *
 *  - 每个 partition（`persist:browser-<wsId>`）的 `will-download` 仅注册一次（多 tab 共用 session
 *    重复注册会触发 Electron 监听器泄漏警告）。Set 跨进程生命周期去重。
 *  - destroy：removeChildView（若已设挂载目标）+ webContents.close()；ws 的 tab 视图全灭时
 *    overlay 一并销毁（deactivate/collapse/closeBrowser/disposeAll 共用路径）。
 *  - clearBrowsingData 调 session.clearStorageData 清 cookie/localStorage/indexedDB。
 */
export function initRealViewFactory(hooks: RealFactoryHooks): ViewFactory &
  TakeoverViewFactory {
  const downloadHooked = new Set<string>();
  // ManagedView 包装后无 raw view 引用——destroy 经此反查真实 WebContentsView
  const realByManaged = new WeakMap<ManagedView, WebContentsView>();
  // 每 ws 的全部存活视图（overlay 生命周期判据；destroy 时移除）
  const viewsByWs = new Map<string, Set<WebContentsView>>();
  // 每 ws 的 overlay 视图（DoD 17 页内点击接管）
  const overlays = new Map<string, OverlayRecord>();
  // 每 ws 最近一次 tab rect（manager 全部 lastRect apply 点经 setBounds 包装层落此）——
  // overlay 挂载/新建时补套，保证与浏览器视图同 rect（含零 rect 卸载路径）
  const lastRectByWs = new Map<string, { x: number; y: number; width: number; height: number }>();
  let mount: ViewMount | null = null;

  /** 懒建 ws overlay（透明 + preload + about:blank 注入 + 命中 IPC 接线）；重复调用幂等 */
  const ensureOverlay = (wsId: string): OverlayRecord => {
    const existing = overlays.get(wsId);
    if (existing) return existing;
    // in-memory session（无 persist: 前缀）：一次性透明点击层无持久化需求，且与浏览器
    // partition（persist:browser-<wsId>）数据域隔离——clearBrowsingData 不会触及它
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition('browser-overlay'),
        nodeIntegration: false, // 硬化：绝不开（spec §6.4）
        contextIsolation: true,
        sandbox: true,
        preload: overlayPreloadPath,
      },
    });
    view.setBackgroundColor('#00000000'); // 全透明——不遮下方浏览器视图内容
    // 命中接线（Electron 30 webContents.ipc——作用域限本 webContents，不占全局 ipcMain 通道）
    view.webContents.ipc.on('momo-overlay-hit', () => hooks.onOverlayHit(wsId));
    // 页面注入：about:blank + 透明底 + 撑满 + mousedown → preload 桥。fire-and-forget：
    // 注入失败仅降级（点击接管不可用），不影响 overlay 其余生命周期
    void view.webContents
      .loadURL('about:blank')
      .then(() => view.webContents.insertCSS(OVERLAY_CSS))
      .then(() => view.webContents.executeJavaScript(OVERLAY_MOUSEDOWN_SCRIPT))
      .catch((err: unknown) => {
        logger.warn('browser overlay 页面注入失败（页内点击接管降级，键盘/地址栏接管不受影响）', {
          workspaceId: wsId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    const rec: OverlayRecord = { view, attached: false };
    overlays.set(wsId, rec);
    return rec;
  };

  /** overlay 随 tab 视图全灭销毁：摘挂载 + webContents.close + rect 缓存清理 */
  const destroyOverlay = (wsId: string): void => {
    const rec = overlays.get(wsId);
    if (!rec) return;
    overlays.delete(wsId);
    if (rec.attached && mount) mount.removeChildView(rec.view);
    rec.view.webContents.close();
    lastRectByWs.delete(wsId);
  };

  return {
    create(wsId: string): ManagedView {
      const partition = `persist:browser-${wsId}`;
      const ses = session.fromPartition(partition);

      if (!downloadHooked.has(wsId)) {
        downloadHooked.add(wsId);
        // C7：下载一律取消（v1 不支持保存文件）—— spec §6.4 / §13 配额缓解（partition 磁盘）
        ses.on('will-download', (event) => {
          event.preventDefault();
          hooks.pushNotice('download-blocked', '下载已拦截（v1 不支持保存文件）');
        });
      }

      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          nodeIntegration: false, // 硬化：绝不开（spec §6.4）
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      if (mount) mount.addChildView(view);
      // overlay 恒在浏览器视图之上：agent 态新 tab 挂载会把 overlay 挤到非顶位——
      // 重新挂到末位恢复栈顶（addChildView 附加序即 z 序，末位 = 最上）
      const overlay = overlays.get(wsId);
      if (overlay?.attached && mount) {
        mount.removeChildView(overlay.view);
        mount.addChildView(overlay.view);
      }

      const managed = wrapManagedView(view, (b) => {
        // overlay bounds 跟随：manager 的全部 lastRect apply 点（懒建/切 tab/恢复/rect 上报/
        // 零 rect 卸载）都经此——缓存 + 同步到 overlay，两侧永不漂移
        lastRectByWs.set(wsId, b);
        overlays.get(wsId)?.view.setBounds(b);
      });
      realByManaged.set(managed, view);
      let set = viewsByWs.get(wsId);
      if (!set) {
        set = new Set();
        viewsByWs.set(wsId, set);
      }
      set.add(view);
      return managed;
    },

    destroy(v: ManagedView): void {
      // 真 webContents 销毁——通过 WeakMap 反查真实 WebContentsView 引用。
      const real = realByManaged.get(v);
      if (real) {
        if (mount) mount.removeChildView(real);
        real.webContents.close();
        for (const set of viewsByWs.values()) set.delete(real);
        // tab 视图全灭（destroyTabs 路径：deactivate / collapse / closeBrowser / disposeAll）
        // → overlay 随之销毁——生命周期与 tab 视图一致，下次 showOverlay 懒重建
        for (const [wsId, set] of viewsByWs) {
          if (set.size === 0) {
            viewsByWs.delete(wsId);
            destroyOverlay(wsId);
          }
        }
      }
      realByManaged.delete(v);
    },

    async clearData(wsId: string): Promise<void> {
      await session.fromPartition(`persist:browser-${wsId}`).clearStorageData();
    },

    showOverlay(wsId: string, takeover: 'agent' | 'user'): void {
      if (takeover === 'user') {
        // user 态：整视图摘除。取 removeChildView 而非 setBounds(0,0,0,0)：零 rect 视图
        // 仍参与合成且部分平台有 1px 命中/焦点残留；摘除保证零命中，重挂时 addChildView
        // 天然落栈顶——与「overlay 恒在浏览器视图之上」的次序维护共用同一机制
        const rec = overlays.get(wsId);
        if (rec?.attached && mount) {
          mount.removeChildView(rec.view);
          rec.attached = false;
        }
        return;
      }
      // agent 态：无 tab 视图（空 ws / 折叠 / 切走）不建——无输入面可拦，且 overlay
      // 生命周期与 tab 视图绑定（tab 重建后下一次 pushState 自然补建）
      const views = viewsByWs.get(wsId);
      if (!views || views.size === 0) return;
      const rec = ensureOverlay(wsId);
      if (!rec.attached && mount) {
        mount.addChildView(rec.view); // 附加序末位 = 栈顶（浏览器视图之上）
        rec.attached = true;
      }
      // bounds 补套：tab 视图 setBounds 时已缓存最近 rect；overlay 新建场景在此对齐
      const rect = lastRectByWs.get(wsId);
      if (rect) rec.view.setBounds(rect);
    },

    setMountTarget(next: ViewMount | null): void {
      mount = next;
    },
  };
}

/**
 * 把真实 WebContentsView 适配为结构性 ManagedView 契约——
 * loadURL / on / executeJavaScript / sendInputEvent / capturePage / setWindowOpenHandler /
 * reload / getURL / getTitle / debugger / bounds 全部显式转发，保证类型边界清晰且无 `as` cast。
 *
 * 测试 mock factory 不经过本适配器——mock view 直接实现 ManagedView 接口（结构性子类型）。
 * onBounds：bounds 变更时回放给 factory（overlay 跟随 + rect 缓存——见 create 内注释）。
 */
function wrapManagedView(
  view: WebContentsView,
  onBounds: (b: { x: number; y: number; width: number; height: number }) => void,
): ManagedView {
  const wc: ManagedWebContents = {
    loadURL: (url: string) => view.webContents.loadURL(url),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      // Electron webContents.on 是事件字面量重载方法（不暴露通用 string 签名）。
      // 我们在 manager 侧用非字面量 event 名（'render-process-gone' / 'console-message' 等），
      // 适配层强制 cast 到通用签名——运行时等价于 EventEmitter.on(event, listener)。
      (view.webContents.on as (event: string, listener: (...args: unknown[]) => void) => unknown)(
        event,
        listener,
      );
    },
    executeJavaScript: (code: string) =>
      view.webContents.executeJavaScript(code) as Promise<unknown>,
    sendInputEvent: (event) => {
      // 真实 InputEvent 是 MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent 联合；
      // 我们的 BrowserInputEvent 是其结构性子集；调用点构造的载荷符合 Electron 期望（keyCode/string），
      // sendInputEvent 在 d.ts 中按 method bivariance 允许。
      view.webContents.sendInputEvent(event as unknown as Parameters<typeof view.webContents.sendInputEvent>[0]);
    },
    capturePage: () =>
      view.webContents
        .capturePage()
        // NativeImage 含 toPNG + toDataURL + ...；ManagedWebContents 只要求 toPNG。
        // 结构性子类型：NativeImage 满足 { toPNG(): Buffer }。
        .then((img) => ({ toPNG: () => img.toPNG() })),
    setWindowOpenHandler: (handler) => {
      // 真实 handler 签名 (HandlerDetails) => WindowOpenHandlerResponse；我们的 (details: {url}) => {action:'deny'}
      // bivariance + 子类型满足——只读 url 字段匹配。
      view.webContents.setWindowOpenHandler(handler as unknown as Parameters<typeof view.webContents.setWindowOpenHandler>[0]);
    },
    reload: () => {
      view.webContents.reload();
    },
    getURL: () => view.webContents.getURL(),
    getTitle: () => view.webContents.getTitle(),
    debugger: wrapDebugger(view.webContents.debugger),
  };

  const bounds: ManagedViewBounds = {
    setBounds: (b) => {
      view.setBounds(b);
      onBounds(b);
    },
  };

  return { webContents: wc, bounds };
}

/** Electron Debugger 适配——只暴露 manager 编排需要的子集（snapshot 懒附加用） */
function wrapDebugger(dbg: Electron.Debugger): DebugPort {
  return {
    attach: (protocolVersion?: string) => {
      dbg.attach(protocolVersion);
    },
    detach: () => {
      dbg.detach();
    },
    sendCommand: (method: string, commandParams?: Record<string, unknown>) =>
      dbg.sendCommand(method, commandParams) as Promise<unknown>,
  };
}
