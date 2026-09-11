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
//
// "互认"语义：factory 通过 hooks 拿到 pushNotice（用于下载拦截通知）；manager 通过构造注入
// factory。在 boot 期（T10 接线）共享同一 hooks 对象。
import { session, WebContentsView } from 'electron';
import type { ManagedView, ManagedWebContents, ViewFactory } from './manager';
import type { DebugPort, ManagedViewBounds } from './manager';
import { logger } from '../logger';

/** initRealViewFactory 钩子——与 manager 共享（pushNotice 来自 manager 同一 hook 对象） */
export interface RealFactoryHooks {
  /** 下载拦截通知（will-download preventDefault 后推送 UI） */
  pushNotice(kind: string, text: string): void;
}

/**
 * 鼠标穿透控制面（DoD 17）——boot pushState 包装层按 takeover 调用。
 *
 * 平台边界（诚实声明）：Electron 30 无 per-view setIgnoreMouseEvents API
 * （setIgnoreMouseEvents 是窗口级；per-view 穿透为上游开放特性请求 electron#49039）。
 * 本实现采用 CDP `Input.setIgnoreInputEvents`——agent 态让页面忽略真实输入（防用户
 * 误触页面交互而未接管），user 态恢复接收。该 flag 随 DevTools 会话存活，故 agent 态
 * 期间对每视图保持 debugger 附加（SmartDebugger 引用计数，与 snapshot 懒附加共存）。
 */
export interface TakeoverViewFactory {
  setIgnoreMouseEvents(wsId: string, ignore: boolean): void;
  /** 视图挂载目标（T10：index.ts 窗口创建后传 win.contentView；null = 摘除） */
  setMountTarget(mount: ViewMount | null): void;
}

/** 视图挂载目标（主窗口 contentView 的结构性子集——create/destroy 时挂/摘） */
export interface ViewMount {
  addChildView(view: unknown): void;
  removeChildView(view: unknown): void;
}

/**
 * 引用计数 debugger 包装：
 *   - 公共 attach/detach（snapshot 懒附加路径）按计数配对——计数归零且无穿透持有时才真 detach
 *   - 穿透持有（setIgnoreMouseEvents true 期间）与 snapshot 共享同一会话：
 *     agent 态 snapshot 照常可用（attach 已附加时计数 +1 不重复附加）
 */
interface SmartDebugger extends DebugPort {
  /** 穿透持有：确保已附加并标记持有（重复调用幂等） */
  acquireHold(): void;
  /** 解除穿透持有：无其他使用者时真 detach */
  releaseHold(): void;
}

function wrapSmartDebugger(dbg: Electron.Debugger): SmartDebugger {
  let attached = false;
  let users = 0;
  let hold = false;
  const ensureAttached = (): void => {
    if (attached) return;
    dbg.attach('1.3');
    attached = true;
  };
  const maybeDetach = (): void => {
    if (attached && users === 0 && !hold) {
      dbg.detach();
      attached = false;
    }
  };
  return {
    attach(protocolVersion?: string) {
      // 已附加时不再重复 attach（Electron 会抛 already attached）——计数语义
      if (attached) {
        users++;
        return;
      }
      dbg.attach(protocolVersion);
      attached = true;
      users++;
    },
    detach() {
      users = Math.max(0, users - 1);
      maybeDetach();
    },
    sendCommand(method, commandParams) {
      return dbg.sendCommand(method, commandParams) as Promise<unknown>;
    },
    acquireHold() {
      ensureAttached();
      hold = true;
    },
    releaseHold() {
      hold = false;
      maybeDetach();
    },
  };
}

/**
 * 构建真实 Electron 视图工厂。
 *
 *  - 每个 partition（`persist:browser-<wsId>`）的 `will-download` 仅注册一次（多 tab 共用 session
 *    重复注册会触发 Electron 监听器泄漏警告）。Set 跨进程生命周期去重。
 *  - destroy：removeChildView（若已设挂载目标）+ webContents.close()。
 *  - clearBrowsingData 调 session.clearStorageData 清 cookie/localStorage/indexedDB。
 */
export function initRealViewFactory(hooks: RealFactoryHooks): ViewFactory &
  TakeoverViewFactory & { setMountTarget(mount: ViewMount | null): void } {
  const downloadHooked = new Set<string>();
  // ManagedView 包装后无 raw view 引用——destroy 经此反查真实 WebContentsView
  const realByManaged = new WeakMap<ManagedView, WebContentsView>();
  // 每 ws 的全部存活视图（setIgnoreMouseEvents 遍历面；destroy 时移除）
  const viewsByWs = new Map<string, Set<WebContentsView>>();
  // 每 ws 视图的穿透持有 debugger（按视图闭包持有引用计数状态）
  const smartDebuggers = new Map<WebContentsView, SmartDebugger>();
  let mount: ViewMount | null = null;

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

      // 每视图唯一 SmartDebugger（公共 debugger 面 = snapshot 懒附加；穿透持有共享同一会话）
      const smart = wrapSmartDebugger(view.webContents.debugger);
      smartDebuggers.set(view, smart);
      const managed = wrapManagedView(view, smart);
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
        // 穿透持有先解除（否则 debugger 会话随 close 强拆但持有状态不清）
        smartDebuggers.get(real)?.releaseHold();
        smartDebuggers.delete(real);
        if (mount) mount.removeChildView(real);
        real.webContents.close();
        for (const set of viewsByWs.values()) set.delete(real);
      }
      realByManaged.delete(v);
    },

    async clearData(wsId: string): Promise<void> {
      await session.fromPartition(`persist:browser-${wsId}`).clearStorageData();
    },

    setIgnoreMouseEvents(wsId: string, ignore: boolean): void {
      const views = viewsByWs.get(wsId);
      if (!views) return;
      for (const view of views) {
        const dbg = smartDebuggers.get(view);
        if (!dbg) continue; // create 时已注册——理论不可达，防御分支
        try {
          if (ignore) {
            // agent 态：持有会话（flag 随会话存活）+ 页面忽略输入
            dbg.acquireHold();
            void dbg.sendCommand('Input.setIgnoreInputEvents', { ignore: true }).catch((err) => {
              logger.warn('browser 鼠标穿透设置失败（降级：页面继续接收输入）', {
                workspaceId: wsId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            // user 态：先发恢复命令再解除持有（会话存活期间命令才有效）
            void dbg
              .sendCommand('Input.setIgnoreInputEvents', { ignore: false })
              .then(() => dbg?.releaseHold())
              .catch(() => dbg?.releaseHold());
          }
        } catch (err) {
          // attach 被用户 DevTools 占用等——降级不阻断（DoD 17 边界见文件头）
          logger.warn('browser 鼠标穿透 debugger 附加失败（降级）', {
            workspaceId: wsId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
 */
function wrapManagedView(view: WebContentsView, smart: SmartDebugger): ManagedView {
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
    debugger: smart,
  };

  const bounds: ManagedViewBounds = {
    setBounds: (b) => {
      view.setBounds(b);
    },
  };

  return { webContents: wc, bounds };
}
