// electron/src/main/browser/view-factory.ts
//
// BrowserManager 视图工厂的 Electron 真实现——经 initRealViewFactory(hooks) 与 manager 互认。
//
// 本文件 import 'electron'——单测不 import（Node 无 Electron 运行时，纯 Node 单测用 mock factory
// 满足 ViewFactory 接口；e2e 在 T11 覆盖真实行为）。
//
// 职责分割（与 manager.ts 的接线分工）：
//   - view-factory（本文件）：session 级别——partition 创建、webPreferences 四硬化（C7 节点
//     integration / contextIsolation / sandbox / webSecurity）、session will-download 拦截
//     （C6 popup 收编与 render-process-gone 由 manager 在 wireView 接线——便于纯 Node 单测用
//     mock view 仿真真实 Electron 事件面，详见 manager.wireView 注释）
//   - clearBrowsingData 委托：本文件负责 session.clearStorageData
//
// "互认"语义：factory 通过 hooks 拿到 pushNotice（用于下载拦截通知）；manager 通过构造注入
// factory。在 boot 期（T10 接线）共享同一 hooks 对象。
import { session, WebContentsView } from 'electron';
import type { ManagedView, ManagedWebContents, ViewFactory } from './manager';
import type { DebugPort, ManagedViewBounds } from './manager';

/** initRealViewFactory 钩子——与 manager 共享（pushNotice 来自 manager 同一 hook 对象） */
export interface RealFactoryHooks {
  /** 下载拦截通知（will-download preventDefault 后推送 UI） */
  pushNotice(kind: string, text: string): void;
}

/**
 * 构建真实 Electron 视图工厂。
 *
 *  - 每个 partition（`persist:browser-<wsId>`）的 `will-download` 仅注册一次（多 tab 共用 session
 *    重复注册会触发 Electron 监听器泄漏警告）。Set 跨进程生命周期去重。
 *  - destroy 仅 webContents.close()——window.contentView.removeChildView 由 T10 接线层负责。
 *  - clearBrowsingData 调 session.clearStorageData 清 cookie/localStorage/indexedDB。
 */
export function initRealViewFactory(hooks: RealFactoryHooks): ViewFactory {
  const downloadHooked = new Set<string>();
  // ManagedView 包装后无 raw view 引用——destroy 经此反查真实 WebContentsView
  const realByManaged = new WeakMap<ManagedView, WebContentsView>();

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

      const managed = wrapManagedView(view);
      realByManaged.set(managed, view);
      return managed;
    },

    destroy(v: ManagedView): void {
      // 真 webContents 销毁——通过 WeakMap 反查真实 WebContentsView 引用。
      // window.contentView.removeChildView 由 T10 接线层负责（manager 不持有 window 引用）。
      const real = realByManaged.get(v);
      if (real) real.webContents.close();
      realByManaged.delete(v);
    },

    async clearData(wsId: string): Promise<void> {
      await session.fromPartition(`persist:browser-${wsId}`).clearStorageData();
    },
  };
}

/**
 * 把真实 WebContentsView 适配为结构性 ManagedView 契约——
 * loadURL / on / executeJavaScript / sendInputEvent / capturePage / setWindowOpenHandler /
 * reload / getURL / getTitle / debugger / bounds 全部显式转发，保证类型边界清晰且无 `as` cast。
 *
 * 测试 mock factory 不经过本适配器——mock view 直接实现 ManagedView 接口（结构性子类型）。
 */
function wrapManagedView(view: WebContentsView): ManagedView {
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
    },
  };

  return { webContents: wc, bounds };
}

/** Electron Debugger 适配——只暴露 manager 编排需要的子集 */
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
