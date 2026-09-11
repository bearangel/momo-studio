// electron/src/main/browser/manager.ts
//
// BrowserManager——浏览器编排核心（spec 2026-09-11 §3.1 / §3.2 / §5 / §7）。
//
// 纯 TypeScript 编排，零 Electron import：Electron 视图边界经 ViewFactory 注入（真实现见
// view-factory.ts，本文件单测用 mock factory——mock 事件参数序与真实 Electron 一致，
// momo-test-rules 仿真真实运行时语义）。BrowserManager 持有：
//
//   - tab 注册表：每个 tab 一个 ManagedView（懒建、serial 键控 console 缓冲）
//   - takeover 状态机：agent ↔ user（§3.2 三入口收敛 userTakeover）
//   - workspace 切换：stash {urls,current} → 销毁视图；激活按 stash 重建（重建不重过 assertUrl）
//   - 视图事件接线：popup 收编 / 崩溃自愈 / console 环形 / did-navigate / page-title-updated /
//     before-input-event（页内输入自动接管；修饰键不计；agent 期间自锁）
//   - sidebar bounds 透传 / 折叠销毁（折叠期间活动先恢复旧清单再作用——不丢 tab）
//
// 动作原语（click/type/pressKey/hover/scroll）自 T3 起委托 actions.ts（selector 四语法
// 解析 + Electron trusted 事件序列）；snapshot 自 T4 起委托 snapshot.ts（a11y 懒附加
// 采集 + selector 提示行格式化）；本文件负责门控（信任/takeover/视图定位）与
// 输入自锁（withAgentInput——sendInputEvent 回流 before-input-event 不计接管）。
// screenshot 在本文件内实现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clickElement,
  hoverElement,
  pressKey,
  SCROLL_DEFAULT_AMOUNT,
  scrollWheel,
  typeText,
} from './actions';
import {
  BrowserNavigationError,
  BrowserNoViewError,
  BrowserTakenOverError,
} from './errors';
import { BrowserPolicy } from './policy';
import { takeSnapshot } from './snapshot';
import type { BrowserState, TabInfo } from './types';

// =================================================================================
// 常量
// =================================================================================

/**
 * 初始空白页 URL 常量。tabsAction open 不带 url 时使用——不经 policy.assertUrl
 * （内部常量，非 tool/用户输入；T1 review 裁定：策略只门 tool/用户输入 URL）。
 */
export const ABOUT_BLANK = 'about:blank';

/** 每 tab console 环形缓冲上限（spec §3.1）。slice 移除截断，简单可靠 */
const CONSOLE_RING_SIZE = 50;

/** console-message level 数字 → 文本前缀（Electron 0-3: verbose/info/warning/error） */
const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'] as const;

/**
 * before-input-event 修饰键集合：单独按下不计接管信号（spec §13 误触发防线）。
 * 注意：修饰键仍可能跟其他键组合输入——组合输入由非修饰键（key/char）触发主路径。
 */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'Hyper',
  'OS',
]);

/** scroll 缺省 amount 常量已移至 actions.ts（SCROLL_DEFAULT_AMOUNT——动作语义单一归属） */
/** snapshot CDP 协议版本与格式化器已移至 snapshot.ts（T4——懒附加 + 提示行单一归属） */

// =================================================================================
// 结构性子类型（Electron 边界的契约面——单测用普通对象满足）
// =================================================================================

/** Electron webContents.debugger 的结构性子集（T4 snapshot 懒附加用） */
export interface DebugPort {
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

/** sendInputEvent 载荷：Electron InputEvent（Mouse/Wheel/Keyboard）的结构性形态 */
export type BrowserInputEvent = { readonly type: string } & Readonly<Record<string, string | number | boolean>>;

/** Electron webContents 的结构性子集——manager 编排所需面 */
export interface ManagedWebContents {
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent(event: BrowserInputEvent): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' },
  ): void;
  reload(): void;
  getURL(): string;
  getTitle(): string;
  readonly debugger: DebugPort;
}

/** Electron WebContentsView 的结构性子集（bounds 同步） */
export interface ManagedViewBounds {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

/** sidebar 占位区 rect——browser:setSidebarBounds 载荷（与 Electron setBounds 四字段同构） */
export interface SidebarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单 tab 视图（结构性契约——真 Electron WebContentsView 经 view-factory.ts 适配满足） */
export interface ManagedView {
  readonly webContents: ManagedWebContents;
  readonly bounds: ManagedViewBounds;
}

/** 视图工厂接口（manager 构造注入；真实现见 view-factory.ts，测试用 mock） */
export interface ViewFactory {
  create(wsId: string): ManagedView;
  destroy(v: ManagedView): void;
  /** 清除 partition 浏览数据（T9「清除浏览数据」经 clearBrowsingData 委托） */
  clearData(wsId: string): Promise<void>;
}

/** BrowserManager 钩子——构造注入（renderer 消费：IPC main→renderer 推送） */
export interface BrowserManagerHooks {
  /** BrowserState 完整快照（统一推送契约——§3.6 `browser:state`） */
  pushState(state: BrowserState): void;
  /** 非模态通知（崩溃重载 / 下载拦截 / popup 拦截 / 加载失败等） */
  pushNotice(kind: string, text: string): void;
}

/** 构造可选项（T10 boot 注入） */
export interface BrowserManagerOpts {
  /**
   * screenshot 落盘根目录（spec §4 工具 3 字面：`<userData>/browser-screenshots`）。
   * 缺省回退 `<tmpdir>/momo-browser-shots`（T2 行为，boot 未注入时的兜底）。
   */
  screenshotDir?: string;
}

/**
 * tabs / 关浏览器操作的调用方甄别（G4：tabs 为 agent/user 双方共用）。
 *   'agent'（缺省）——T5 browser_tabs / browser_close 工具路径，过接管门
 *   （user 态抛 BrowserTakenOverError，spec §3.2「任一 browser_* 工具」语义）；
 *   'user' ——T7 IPC 用户路径（用户点 tab / 开 / 关），放行——§3.2 的 TakenOver
 *   只约束工具，不约束人（review fix：此前单门拒绝导致用户接管后无法操作 tab）。
 */
export type BrowserActionSource = 'agent' | 'user';

// =================================================================================
// 内部状态
// =================================================================================

interface TabRecord {
  view: ManagedView;
  /** tab 唯一序列号——console buffer 以 serial 键控，tab 关闭即释放，零漂移 */
  serial: number;
}

interface TabStash {
  urls: string[];
  current: number;
}

interface ActiveWorkspace {
  workspaceId: string;
  workspaceDir: string;
  tabs: TabRecord[];
  current: number;
  takeover: 'agent' | 'user';
  /** serial → 环形缓冲（每 tab 50 条，level 前缀） */
  consoleBuffer: Map<number, string[]>;
  collapsed: boolean;
  /** 折叠前的清单（折叠时视图已销毁；展开或折叠期间活动用于重建） */
  collapseStash: TabStash | null;
}

// =================================================================================
// 公共：BrowserManager
// =================================================================================

export class BrowserManager {
  private active: ActiveWorkspace | null = null;
  /** workspaceId → {urls, current}；切走时填入，重新激活时取出重建 */
  private readonly stashedTabs = new Map<string, TabStash>();
  private nextSerial = 0;
  /** agent 输入动作进行中（sendInputEvent 在真实环境可能回流 before-input-event——不计接管） */
  private agentInputDepth = 0;
  /** renderer 最近一次上报的 sidebar 占位区 rect（null = 从未上报）——任何视图成为 current 时立即套用 */
  private lastRect: SidebarRect | null = null;

  constructor(
    private readonly factory: ViewFactory,
    private readonly policy: BrowserPolicy,
    private readonly hooks: BrowserManagerHooks,
    opts?: BrowserManagerOpts,
  ) {
    this.screenshotDir = opts?.screenshotDir;
  }

  /** screenshot 落盘根（null = 缺省 tmpdir 兜底） */
  private readonly screenshotDir?: string;

  // ---------- 门控与状态 ----------

  /** §3.1 IPC browser:getState 消费点——返回活跃 ws 当前 BrowserState；非活跃返回空壳 */
  getState(wsId: string): BrowserState {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) {
      return {
        workspaceId: wsId,
        tabs: [],
        current: 0,
        url: '',
        title: '',
        takeover: 'agent',
        trusted: this.isTrusted(wsId),
      };
    }
    return this.buildState(ws);
  }

  /** IPC browser:setSidebarBounds 消费点——renderer 占位区 rect 上报（DPR 换算在 T10 接线层）。缓存供任何后续成为 current 的视图立即套用（browser:state 推送不一定触发 renderer ResizeObserver 重报） */
  setSidebarBounds(rect: SidebarRect): void {
    this.lastRect = rect;
    const ws = this.active;
    const tab = ws?.tabs[ws.current];
    if (ws && tab) tab.view.bounds.setBounds(rect);
  }

  /** IPC browser:setSidebarCollapsed 消费点——折叠销毁视图；展开按折叠前清单重建 */
  setSidebarCollapsed(wsId: string, collapsed: boolean): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) return;
    if (ws.collapsed === collapsed) return;
    if (collapsed) {
      if (ws.tabs.length > 0) {
        ws.collapseStash = {
          urls: ws.tabs.map((t) => t.view.webContents.getURL()),
          current: ws.current,
        };
      }
      ws.collapsed = true;
      this.destroyTabs(ws);
      ws.current = 0;
    } else {
      ws.collapsed = false;
      const stash = ws.collapseStash;
      ws.collapseStash = null;
      if (stash && stash.urls.length > 0 && ws.tabs.length === 0) {
        this.restoreTabs(ws, stash);
      }
    }
    this.emitState(ws);
  }

  // ---------- 工具方法（§4 12 工具一一对应） ----------

  /** browser_navigate：策略门控 → 懒建 / 复用 → loadURL → 推送状态 */
  async navigate(wsId: string, rawUrl: string): Promise<{ url: string; title: string }> {
    const ws = this.requireWorkspace(wsId);
    this.assertAgentSide(ws);
    const url = this.policy.assertUrl(wsId, rawUrl); // 越界/协议错误原样穿透 T5（不建视图）
    this.ensureLive(ws);
    let tab = ws.tabs[ws.current];
    if (!tab) {
      tab = this.createTab(ws);
      ws.current = ws.tabs.length - 1;
      this.applyLastRect(ws); // 懒建的新视图成为 current——立即套用缓存 rect
    }
    await this.loadChecked(tab, url);
    this.emitState(ws);
    return {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
    };
  }

  /** browser_tabs：list/open/close/switch 四动作——open 收编与 setWindowOpenHandler 共用 openTabInternal；source 甄别见 BrowserActionSource */
  async tabsAction(
    wsId: string,
    action: 'list' | 'open' | 'close' | 'switch',
    index?: number,
    url?: string,
    source: BrowserActionSource = 'agent',
  ): Promise<TabInfo[]> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') this.assertAgentSide(ws);
    switch (action) {
      case 'list':
        return this.tabInfos(ws);
      case 'open': {
        this.ensureLive(ws);
        // url 未传 → ABOUT_BLANK（openTabInternal 不经策略）
        this.openTabInternal(ws, url ?? null);
        this.emitState(ws);
        return this.tabInfos(ws);
      }
      case 'close': {
        const idx = index ?? ws.current;
        const tab = ws.tabs[idx];
        if (!tab) {
          throw new RangeError(`tab 下标 ${idx} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        if (ws.tabs.length === 1) {
          // 唯一 tab 关闭 = 关闭浏览器（spec §4 工具 11）——source 透传（user 关自己最后一个 tab 不被拦）
          await this.closeBrowser(wsId, source);
          return [];
        }
        this.factory.destroy(tab.view);
        ws.tabs.splice(idx, 1);
        ws.consoleBuffer.delete(tab.serial);
        if (idx < ws.current) ws.current -= 1;
        else if (idx === ws.current) ws.current = Math.min(ws.current, ws.tabs.length - 1);
        this.applyLastRect(ws); // 关闭致 current 迁移时，新 current 视图（此前无 bounds）立即套用
        this.emitState(ws);
        return this.tabInfos(ws);
      }
      case 'switch': {
        const idx = index ?? 0;
        if (idx < 0 || idx >= ws.tabs.length) {
          throw new RangeError(`tab 下标 ${idx} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        ws.current = idx;
        this.applyLastRect(ws); // 切换后的 current 视图此前未持 bounds——立即套用
        this.emitState(ws);
        return this.tabInfos(ws);
      }
    }
  }

  /** browser_close：销毁当前 workspace 视图 + 清 stash + takeover 复位（spec §7）；source 甄别见 BrowserActionSource */
  async closeBrowser(wsId: string, source: BrowserActionSource = 'agent'): Promise<void> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') this.assertAgentSide(ws);
    this.destroyTabs(ws);
    ws.current = 0;
    ws.takeover = 'agent'; // 全新仲裁起点
    ws.collapseStash = null;
    this.stashedTabs.delete(wsId); // §7：清 stash——下次激活空态
    this.emitState(ws);
  }

  /** browser_console_messages：当前 tab 环形缓冲拷贝——text 序列 */
  async consoleMessages(wsId: string): Promise<string[]> {
    const { ws, tab } = this.requireCurrentTab(wsId);
    const buf = ws.consoleBuffer.get(tab.serial);
    return buf ? [...buf] : [];
  }

  /** browser_evaluate：设置默认关（§6.2）；内部 selector 解析脚本不受此开关约束（§3.3） */
  async evaluate(wsId: string, expression: string): Promise<unknown> {
    const ws = this.requireWorkspace(wsId);
    this.assertAgentSide(ws);
    this.policy.assertEvaluate(wsId);
    const tab = ws.tabs[ws.current];
    if (!tab) throw new BrowserNoViewError();
    return tab.view.webContents.executeJavaScript(expression);
  }

  // ---------- 动作原语（委托 actions.ts——T3 selector 四语法 + trusted 事件序列） ----------

  /**
   * 输入派发自锁钩子——传给 actions 层，把 sendInputEvent 序列包在 withAgentInput
   * 内（回流 before-input-event 不触发「用户接管」误判）。
   */
  private inputGuard(): (run: () => void) => void {
    return (run) => this.withAgentInput(run);
  }

  /** click：selector 定位（四语法）→ 元素中心 trusted 点击序列 */
  async click(wsId: string, selector: string): Promise<void> {
    const wc = this.requireCurrentWebContents(wsId);
    await clickElement(wc, selector, this.inputGuard());
  }

  /** hover：selector 定位 → mouseMove 至元素中心 */
  async hover(wsId: string, selector: string): Promise<void> {
    const wc = this.requireCurrentWebContents(wsId);
    await hoverElement(wc, selector, this.inputGuard());
  }

  /** type：先 click 聚焦 → char 逐字符 → submit=true 末尾补 Enter */
  async type(wsId: string, selector: string, text: string, submit = false): Promise<void> {
    const wc = this.requireCurrentWebContents(wsId);
    await typeText(wc, selector, text, submit, this.inputGuard());
  }

  /** pressKey：白名单（Enter/Tab/Escape/方向/翻页/Home/End）外按键抛 BrowserInvalidKeyError */
  async pressKey(wsId: string, key: string): Promise<void> {
    const wc = this.requireCurrentWebContents(wsId);
    pressKey(wc, key, this.inputGuard());
  }

  /** scroll：mouseWheel 事件，direction='down' 向下滚；amount 单位=滚轮格（缺省 3） */
  async scroll(
    wsId: string,
    direction: 'up' | 'down',
    amount: number = SCROLL_DEFAULT_AMOUNT,
  ): Promise<void> {
    const wc = this.requireCurrentWebContents(wsId);
    scrollWheel(wc, direction, amount, this.inputGuard());
  }

  /** snapshot：a11y 树懒附加采集 + selector 提示行（T4 起委托 snapshot.ts 模块） */
  async snapshot(wsId: string): Promise<string> {
    const wc = this.requireCurrentWebContents(wsId);
    return takeSnapshot(wc);
  }

  /** screenshot：capturePage → PNG → 落 `<screenshotDir>/<wsId>/`（boot 注入 userData 目录；缺省 tmpdir 兜底）；filename basename 清洗 */
  async screenshot(wsId: string, filename?: string): Promise<{ path: string }> {
    const wc = this.requireCurrentWebContents(wsId);
    const image = await wc.capturePage();
    const safeName = path.basename(
      filename && filename.trim() !== '' ? filename : `shot-${Date.now()}.png`,
    );
    const base = this.screenshotDir ?? path.join(os.tmpdir(), 'momo-browser-shots');
    const dir = path.join(base, wsId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName);
    fs.writeFileSync(file, image.toPNG());
    return { path: file };
  }

  // ---------- 接管（§3.2 状态机） ----------

  /**
   * §3.2 接管入口收敛点：
   *   入口 1：显式按钮（IPC browser:takeover → manager.userTakeover）
   *   入口 2：地址栏回车（userNavigate 内部调用 userTakeover 再 navigate）
   *   入口 3：页内输入（before-input-event 监听器 char/keyDown 触发）
   * 重复进入幂等（user 态再调用 no-op）；非活跃 ws 静默忽略。
   */
  userTakeover(wsId: string): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId || ws.takeover === 'user') return;
    ws.takeover = 'user';
    this.emitState(ws);
  }

  /** 显式释放（v1 无自动回切——agent 收到 TakenOver 错误自决等待/改道） */
  releaseTakeover(wsId: string): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId || ws.takeover === 'agent') return;
    ws.takeover = 'agent';
    this.emitState(ws);
  }

  /** 地址栏回车（第二入口）：URL 过策略 → 接管 → 当前 tab 载入。校验失败不产生接管副作用 */
  async userNavigate(wsId: string, rawUrl: string): Promise<{ url: string; title: string }> {
    const url = this.policy.assertUrl(wsId, rawUrl);
    const ws = this.requireWorkspace(wsId);
    this.userTakeover(wsId);
    this.ensureLive(ws);
    let tab = ws.tabs[ws.current];
    if (!tab) {
      tab = this.createTab(ws); // tabs 为空时新视图落在 idx 0 == current
      this.applyLastRect(ws);
    }
    await this.loadChecked(tab, url);
    this.emitState(ws);
    return {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
    };
  }

  // ---------- workspace 生命周期 ----------

  /** workspace 激活（main 切 workspace 时调）：自动 deactivate 前一活跃 ws；按 stash 重建；file:// 边界根同步到该 ws 目录 */
  onWorkspaceActivated(wsId: string, workspaceDir: string): void {
    this.policy.setWorkspaceRoot(workspaceDir);
    const cur = this.active;
    if (cur?.workspaceId === wsId) {
      cur.workspaceDir = workspaceDir;
      return; // 重复激活幂等
    }
    if (cur) this.onWorkspaceDeactivated(cur.workspaceId);
    const ws: ActiveWorkspace = {
      workspaceId: wsId,
      workspaceDir,
      tabs: [],
      current: 0,
      takeover: 'agent', // 激活即全新仲裁（不延续切走前的接管态）
      consoleBuffer: new Map(),
      collapsed: false,
      collapseStash: null,
    };
    this.active = ws;
    const stash = this.stashedTabs.get(wsId);
    if (stash && stash.urls.length > 0) {
      this.stashedTabs.delete(wsId);
      this.restoreTabs(ws, stash); // stash 是内部恢复（URL 当初过过策略），不重过 assertUrl
    }
    this.emitState(ws);
  }

  /** workspace 切走：stash {urls,current} → 销毁视图（partition 数据落盘不动——spec §3.7） */
  onWorkspaceDeactivated(wsId: string): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) return;
    const stash: TabStash = ws.collapseStash ?? {
      urls: ws.tabs.map((t) => t.view.webContents.getURL()),
      current: ws.current,
    };
    this.stashedTabs.set(wsId, stash);
    this.destroyTabs(ws);
    ws.collapseStash = null;
    ws.collapsed = false;
    this.active = null; // 不推送——新 workspace 激活时会推送其状态
  }

  /** app before-quit：销毁活跃视图（partition 数据自动落盘——spec §7） */
  disposeAll(): void {
    if (!this.active) return;
    this.destroyTabs(this.active);
    this.active = null;
  }

  /** T9「清除浏览数据」：委托 factory 清 partition storage（设置页路径，不经接管门） */
  async clearBrowsingData(wsId: string): Promise<void> {
    await this.factory.clearData(wsId);
  }

  // ===============================================================================
  // 私有
  // ===============================================================================

  private requireWorkspace(wsId: string): ActiveWorkspace {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) throw new BrowserNoViewError();
    return ws;
  }

  private assertAgentSide(ws: ActiveWorkspace): void {
    if (ws.takeover === 'user') throw new BrowserTakenOverError();
  }

  private requireCurrentTab(wsId: string): { ws: ActiveWorkspace; tab: TabRecord } {
    const ws = this.requireWorkspace(wsId);
    this.assertAgentSide(ws);
    const tab = ws.tabs[ws.current];
    if (!tab) throw new BrowserNoViewError();
    return { ws, tab };
  }

  private requireCurrentWebContents(wsId: string): ManagedWebContents {
    return this.requireCurrentTab(wsId).tab.view.webContents;
  }

  private buildState(ws: ActiveWorkspace): BrowserState {
    const tabs = this.tabInfos(ws);
    const cur = tabs[ws.current];
    return {
      workspaceId: ws.workspaceId,
      tabs,
      current: ws.current,
      url: cur?.url ?? '',
      title: cur?.title ?? '',
      takeover: ws.takeover,
      trusted: this.isTrusted(ws.workspaceId),
    };
  }

  private tabInfos(ws: ActiveWorkspace): TabInfo[] {
    return ws.tabs.map((t, i) => ({
      index: i,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
    }));
  }

  private isTrusted(wsId: string): boolean {
    try {
      this.policy.assertAllowed(wsId);
      return true;
    } catch {
      return false;
    }
  }

  private emitState(ws: ActiveWorkspace): void {
    this.hooks.pushState(this.buildState(ws));
  }

  /** 折叠期间发生浏览器活动 → 按折叠前清单恢复视图（折叠不丢 tab——T8 展开无需重建） */
  private ensureLive(ws: ActiveWorkspace): void {
    if (!ws.collapsed || !ws.collapseStash) return;
    const stash = ws.collapseStash;
    ws.collapseStash = null;
    this.restoreTabs(ws, stash);
  }

  /** 不挂事件；调用方负责后续 wiring / loadURL */
  private createTab(ws: ActiveWorkspace): TabRecord {
    const view = this.factory.create(ws.workspaceId);
    const serial = this.nextSerial++;
    ws.consoleBuffer.set(serial, []);
    const record: TabRecord = { view, serial };
    ws.tabs.push(record);
    this.wireView(ws, record);
    return record;
  }

  /** fire-and-forget 载入（open/收编/恢复路径）：失败 → notice（tool 路径 navigate 自行 await+抛错） */
  private async loadForNotice(record: TabRecord, url: string): Promise<void> {
    try {
      await record.view.webContents.loadURL(url);
    } catch (err) {
      this.hooks.pushNotice('navigation-error', `加载 ${url} 失败：${errorMessage(err)}`);
    }
  }

  /** tool 路径载入：失败 → BrowserNavigationError（spec §8 description 透传） */
  private async loadChecked(record: TabRecord, url: string): Promise<void> {
    try {
      await record.view.webContents.loadURL(url);
    } catch (err) {
      throw new BrowserNavigationError(errorMessage(err));
    }
  }

  /** open / popup 收编共用：createTab + 切 current + fire-and-forget 载入 */
  private openTabInternal(ws: ActiveWorkspace, initialUrl: string | null): TabRecord {
    const record = this.createTab(ws);
    ws.current = ws.tabs.length - 1; // 新 tab 成为当前（§4 工具 11 语义）
    this.applyLastRect(ws); // 新 current 视图立即套用缓存 rect
    void this.loadForNotice(record, initialUrl ?? ABOUT_BLANK);
    return record;
  }

  /** 销毁视图集合并清空缓冲（不重置 current / takeover——由 closeBrowser / onWorkspaceDeactivated 决定） */
  private destroyTabs(ws: ActiveWorkspace): void {
    for (const tab of ws.tabs) this.factory.destroy(tab.view);
    ws.tabs = [];
    ws.consoleBuffer.clear();
  }

  /** 按 stash 重建视图——内部恢复（不重过策略） */
  private restoreTabs(ws: ActiveWorkspace, stash: TabStash): void {
    for (const url of stash.urls) {
      const record = this.createTab(ws);
      void this.loadForNotice(record, url);
    }
    ws.current = Math.min(Math.max(stash.current, 0), Math.max(ws.tabs.length - 1, 0));
    this.applyLastRect(ws); // 恢复后的 current 视图立即套用缓存 rect
  }

  /**
   * 把缓存的 sidebar rect 套用到「刚成为 current」的视图：真实 WebContentsView 默认
   * bounds 0,0,0,0（不可见），新视图不等 renderer 重报——browser:state 推送不一定触发
   * 其 ResizeObserver。lastRect 为 null（从未上报）时 no-op。
   */
  private applyLastRect(ws: ActiveWorkspace): void {
    if (!this.lastRect) return;
    const tab = ws.tabs[ws.current];
    if (tab) tab.view.bounds.setBounds(this.lastRect);
  }

  /**
   * 视图事件接线（manager 唯一接线点——真实现由 manager 而非 factory 主导，
   * 便于纯 Node 单测用 mock view 仿真真实 Electron 事件面，view-factory 仅负责
   * session 级：partition 创建 / webPreferences 硬化 / will-download / clearData）。
   */
  private wireView(ws: ActiveWorkspace, record: TabRecord): void {
    const wc = record.view.webContents;

    // C6 硬化：popup/window.open 一律 deny + 收编为新 tab（不产生游离 OS 窗口）
    wc.setWindowOpenHandler((details: { url: string }) => {
      this.incorporatePopup(ws, details.url);
      return { action: 'deny' };
    });

    // G8 崩溃自愈：reload + 通知（tab URL 不变；SPA 内存态丢失属预期）
    wc.on('render-process-gone', () => {
      wc.reload();
      this.hooks.pushNotice('crash-reloaded', '页面渲染进程崩溃，已自动重载');
    });

    // console 环形缓冲（每 tab 50 条，serial 键控——tab 关闭即随记录释放，不漂移）
    wc.on('console-message', (...args: unknown[]) => {
      const level = typeof args[1] === 'number' ? args[1] : 0;
      const message = typeof args[2] === 'string' ? args[2] : '';
      const buf = ws.consoleBuffer.get(record.serial);
      if (!buf) return;
      const tag = CONSOLE_LEVELS[level] ?? 'log';
      buf.push(`[${tag}] ${message}`);
      if (buf.length > CONSOLE_RING_SIZE) buf.splice(0, buf.length - CONSOLE_RING_SIZE);
    });

    // 地址栏/标题同步：页面自身导航（含 SPA pushState）与标题变化 → 重新推送状态
    wc.on('did-navigate', () => this.emitState(ws));
    wc.on('did-navigate-in-page', () => this.emitState(ws));
    wc.on('page-title-updated', () => this.emitState(ws));

    // §3.2 第三入口：页内键盘输入 → 用户接管。修饰键单独按下不计（§13 误触发防线）；
    // agent 自身 sendInputEvent 期间回流的事件不计（agentInputDepth 自锁——真实环境 sendInputEvent
    // 可能被 Chromium 转发回 main process 的 before-input-event，压栈自锁防止自接管）。
    wc.on('before-input-event', (...args: unknown[]) => {
      if (this.agentInputDepth > 0) return;
      const input = args[1];
      if (typeof input !== 'object' || input === null) return;
      const obj = input as { type?: unknown; key?: unknown };
      if (typeof obj.type !== 'string' || typeof obj.key !== 'string') return;
      const isChar = obj.type === 'char';
      const isPlainKeyDown = obj.type === 'keyDown' && !MODIFIER_KEYS.has(obj.key);
      if (isChar || isPlainKeyDown) this.userTakeover(ws.workspaceId);
    });
  }

  /** popup URL 收编：过策略（页面发起的 window.open 也是可见导航面——防御纵深） */
  private incorporatePopup(ws: ActiveWorkspace, rawUrl: string): void {
    let url: string;
    try {
      url = this.policy.assertUrl(ws.workspaceId, rawUrl);
    } catch (err) {
      this.hooks.pushNotice('popup-blocked', `弹窗已拦截：${errorMessage(err)}`);
      return;
    }
    this.ensureLive(ws);
    this.openTabInternal(ws, url);
    this.emitState(ws);
  }

  /** agent 输入动作压栈自锁（防止 sendInputEvent 回流的 before-input-event 触发自接管） */
  private withAgentInput(run: () => void): void {
    this.agentInputDepth += 1;
    try {
      run();
    } finally {
      this.agentInputDepth -= 1;
    }
  }
}

// =================================================================================
// 模块级辅助
// =================================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
