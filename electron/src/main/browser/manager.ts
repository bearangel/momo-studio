// electron/src/main/browser/manager.ts
//
// BrowserManager——浏览器编排核心（spec 2026-09-11 §3.1 / §3.2 / §5 / §7）。
//
// 纯 TypeScript 编排，零 Electron import：Electron 视图边界经 ViewFactory 注入（真实现见
// view-factory.ts，本文件单测用 mock factory——mock 事件参数序与真实 Electron 一致，
// momo-test-rules 仿真真实运行时语义）。BrowserManager 持有：
//
//   - tab 注册表：每个 tab 一个 ManagedView（懒建、serial 键控 console 缓冲），
//     每条记录携 owner 归属（spec 2026-09-15 §4.1）——多 agent tab 并存互不踩踏，
//     各方光标独立（ownerCurrent）
//   - takeover 状态机：agent ↔ user（§3.2 三入口收敛 userTakeover）
//   - workspace 切换：stash {urls,current,owners} → 销毁视图；激活按 stash 重建（重建不重过 assertUrl）
//   - 视图事件接线：popup 收编 / 崩溃自愈 / console 环形 / did-navigate / page-title-updated /
//     before-input-event（页内输入自动接管；修饰键不计；agent 期间自锁）
//   - sidebar bounds 透传 / 隐藏与显示（收起 = bounds 置零不销毁，spec 2026-09-15 §6.3；
//     活跃会话 agent 导航自动切换可见 tab + expandHint 通告，§7.3）
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
import { USER_OP_CTX } from './op-protocol';
import type { BrowserOpCtx } from './op-protocol';
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

/** agent 驻留等待缺省时长（spec 2026-09-14 §4.1；readAgentWaitMs 注入覆盖，0=立即失败）。
 *  导出供 IPC 桥推导 manager-op 档超时（终审 C1：桥超时必须晚于 park 诚实 reject 上限）。
 *  取 120s（终审 I1）：缺省必须大于 idle 90s——否则旗舰场景（误触后无人操作）timeout
 *  先于空闲自愈触发，waiter 消散后控制权停在 user 态，自愈事实不可达 */
export const DEFAULT_AGENT_WAIT_MS = 120_000;
/** 空闲自动回切缺省阈值（spec §4.2；readIdleAutoReleaseMs 注入覆盖，0=关闭） */
const DEFAULT_IDLE_AUTO_RELEASE_MS = 90_000;
/** 驻留等待 tick 间隔（释放检测 + 空闲判定 + 超时判定共用） */
const AGENT_WAIT_TICK_MS = 1_000;

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
  /** 非模态通知（崩溃重载 / 下载拦截 / popup 拦截 / 加载失败 / 信任卡等）。
   * workspaceId 携带用于 renderer 信任卡路由（v2.7 review M7）——单活跃 ws 推导脆弱
   * （用户切 ws、tool 调用跨 ws 上下文等场景），载荷携带更可靠。
   * durationMs 可选第 4 参：agent-waiting-release 卡片本地倒计时用（= 本轮等待
   * 实际生效时长，spec 2026-09-14 §4.3——防 renderer 硬编码默认值与设置覆盖值漂移）。 */
  pushNotice(kind: string, text: string, workspaceId: string, durationMs?: number): void;
}

/** 构造可选项（T10 boot 注入） */
export interface BrowserManagerOpts {
  /**
   * screenshot 落盘根目录（spec §4 工具 3 字面：`<userData>/browser-screenshots`）。
   * 缺省回退 `<tmpdir>/momo-browser-shots`（T2 行为，boot 未注入时的兜底）。
   */
  screenshotDir?: string;
  /**
   * agent 驻留等待时长读取器（毫秒；settings 的 browserAgentWaitMs 投影，boot 接线）。
   * 缺省恒 DEFAULT_AGENT_WAIT_MS；返回 0 = 关闭等待（user 态立即失败，v1 fail-fast）。
   * 每 tick 重读——运行中改设置即时生效，无需重启。
   */
  readAgentWaitMs?: (wsId: string) => number;
  /**
   * 空闲自动回切阈值读取器（毫秒；settings 的 browserIdleAutoReleaseMs 投影）。
   * 缺省恒 DEFAULT_IDLE_AUTO_RELEASE_MS；返回 0 = 关闭自愈。每 tick 重读（同上）。
   */
  readIdleAutoReleaseMs?: (wsId: string) => number;
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
  /** 归属方（spec 2026-09-15 §4.1）：agent 实例 ID 或 'user' */
  owner: string;
}

interface TabStash {
  urls: string[];
  current: number;
  /** 各 url 的归属（spec §6.5）：切仓往返保归属——restore 按下标还原 owner */
  owners: string[];
}

interface ActiveWorkspace {
  workspaceId: string;
  workspaceDir: string;
  tabs: TabRecord[];
  current: number;
  /** 归属方 → 该方 current tab 的全局下标（spec §4.1 独立光标） */
  ownerCurrent: Map<string, number>;
  takeover: 'agent' | 'user';
  /** serial → 环形缓冲（每 tab 50 条，level 前缀） */
  consoleBuffer: Map<number, string[]>;
  /** 侧栏收起 = 视图全零 bounds 隐藏（不销毁，spec §6.3）——可见性真相源在 renderer */
  viewsHidden: boolean;
  /** 最近一次真实用户输入时刻（userTakeover / before-input-event 刷新；空闲自愈判定用，spec §4.2） */
  lastUserInputAt: number;
}

/** agent 驻留等待条目（单飞：同 ws 并发工具 join 同一 promise，只推一次 notice）。
 *  settle 统一收敛在 settleAgentWait——resolve/reject 由其按出口调用。 */
interface AgentWaitEntry {
  promise: Promise<void>;
  promiseResolve: () => void;
  promiseReject: (err: Error) => void;
  startedAt: number;
  timer: NodeJS.Timeout;
}

// =================================================================================
// 公共：BrowserManager
// =================================================================================

export class BrowserManager {
  private active: ActiveWorkspace | null = null;
  /** workspaceId → {urls,current,owners}；切走时填入，重新激活时取出重建 */
  private readonly stashedTabs = new Map<string, TabStash>();
  private nextSerial = 0;
  /** agent 输入动作进行中（sendInputEvent 在真实环境可能回流 before-input-event——不计接管） */
  private agentInputDepth = 0;
  /** renderer 最近一次上报的 sidebar 占位区 rect（null = 从未上报）——任何视图成为 current 时立即套用 */
  private lastRect: SidebarRect | null = null;
  /** workspaceId → agent 驻留等待条目（单飞：同 ws 并发工具 join 同一 promise） */
  private readonly agentWaiters = new Map<string, AgentWaitEntry>();
  /** renderer 上报的活跃会话（spec §5.4/§7.3 自动展开判定输入；null = 非会话视图，安全缺省永不 expandHint） */
  private activeSessionId: string | null = null;

  constructor(
    private readonly factory: ViewFactory,
    private readonly policy: BrowserPolicy,
    private readonly hooks: BrowserManagerHooks,
    opts?: BrowserManagerOpts,
  ) {
    this.screenshotDir = opts?.screenshotDir;
    this.readAgentWaitMs = opts?.readAgentWaitMs;
    this.readIdleAutoReleaseMs = opts?.readIdleAutoReleaseMs;
  }

  /** screenshot 落盘根（null = 缺省 tmpdir 兜底） */
  private readonly screenshotDir?: string;

  /** agent 驻留等待时长读取器（undefined = 恒 DEFAULT_AGENT_WAIT_MS） */
  private readonly readAgentWaitMs?: (wsId: string) => number;

  /** 空闲自动回切阈值读取器（undefined = 恒 DEFAULT_IDLE_AUTO_RELEASE_MS） */
  private readonly readIdleAutoReleaseMs?: (wsId: string) => number;

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
        expandHint: false,
      };
    }
    return this.buildState(ws, false);
  }

  /** IPC browser:setSidebarBounds 消费点——renderer 占位区 rect 上报（DPR 换算在 T10 接线层）。缓存供任何后续成为 current 的视图立即套用（browser:state 推送不一定触发 renderer ResizeObserver 重报） */
  setSidebarBounds(rect: SidebarRect): void {
    this.lastRect = rect; // 隐藏期仍缓存（显示时恢复用），但不施加
    const ws = this.active;
    if (!ws || ws.viewsHidden) return;
    const tab = ws.tabs[ws.current];
    if (tab) tab.view.bounds.setBounds(rect);
  }

  /** IPC browser:setSidebarVisible 消费点——收起 = 纯隐藏（bounds 全零，视图存活，spec §6.3）；显示 = 恢复可见 tab */
  setSidebarVisible(wsId: string, visible: boolean): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) return;
    if (ws.viewsHidden === !visible) return;
    ws.viewsHidden = !visible;
    if (!visible) {
      for (const t of ws.tabs) t.view.bounds.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else {
      this.applyLastRect(ws);
    }
    // 不推送状态：可见性真相源在 renderer（per-session），main 无折叠语义
  }

  /** IPC browser:setActiveSession 消费点——renderer 活跃会话上报（自动展开判定输入，spec §7.3） */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  // ---------- 工具方法（§4 12 工具一一对应） ----------

  /** browser_navigate：策略门控 → owner 光标懒建 / 复用 → loadURL → 自动切换/展开（maybeAutoSwitch，spec §7.3） */
  async navigate(wsId: string, rawUrl: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<{ url: string; title: string }> {
    const ws = this.requireWorkspace(wsId);
    await this.gateAgentSide(ws);
    const url = this.policy.assertUrl(wsId, rawUrl); // 越界/协议错误原样穿透 T5（不建视图）
    const idx = this.ensureOwnerTab(ws, ctx.ownerId);
    const tab = ws.tabs[idx]!;
    await this.loadChecked(tab, url);
    this.maybeAutoSwitch(ws, ctx, idx);
    return {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
    };
  }

  /** browser_tabs：list/open/close/switch 四动作——归属制（spec §6.1）：agent 源按 ctx.ownerId
 *  作用域（集合内重索引、独立光标、close 只清自己集合）；user 源保持全局语义。
 *  open 收编与 setWindowOpenHandler 共用 openTabInternal；source 甄别见 BrowserActionSource */
  async tabsAction(
    wsId: string,
    action: 'list' | 'open' | 'close' | 'switch',
    index?: number,
    url?: string,
    source: BrowserActionSource = 'agent',
    ctx: BrowserOpCtx = USER_OP_CTX,
  ): Promise<TabInfo[]> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') await this.gateAgentSide(ws);
    switch (action) {
      case 'list':
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      case 'open': {
        // url 携带时先过策略门（F1 review fix——与 navigate/userNavigate 同口径）：
        // 此前裸传 openTabInternal 会绕过 assertUrl，agent 可经 browser_tabs
        // {action:'open', url:'file:///Users/x/.ssh/id_rsa'} 打破 file:// workspace
        // 硬边界与域名黑白名单。策略失败在 openTabInternal 之前抛出，
        // 不开 tab、无任何副作用。url 未传 → null 仍走 ABOUT_BLANK（内部常量，
        // 非 tool/用户输入，不经策略——T1 review 裁定）。
        const initialUrl = url === undefined ? null : this.policy.assertUrl(wsId, url);
        this.openTabInternal(ws, initialUrl, source === 'agent' ? ctx.ownerId : 'user', source !== 'agent');
        this.emitState(ws);
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      }
      case 'close': {
        let idx: number;
        if (source === 'agent') {
          const own = this.ownerTabs(ws, ctx.ownerId);
          // index 是集合内下标；缺省 = 当前光标的集合内位置
          const scoped = index ?? own.indexOf(this.resolveOwnerCurrent(ws, ctx.ownerId));
          if (scoped < 0 || scoped >= own.length) {
            throw new RangeError(`tab 下标 ${index ?? scoped} 越界（现有 ${own.length} 个 tab）`);
          }
          idx = own[scoped]!;
        } else {
          idx = index ?? ws.current;
        }
        const tab = ws.tabs[idx];
        if (!tab) {
          throw new RangeError(`tab 下标 ${index ?? ws.current} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        // agent 关光自己最后一个 tab = 集合清空（不触发关浏览器，spec §6.4）
        if (source === 'agent' && this.ownerTabs(ws, ctx.ownerId).length === 1) {
          this.factory.destroy(tab.view);
          ws.tabs.splice(idx, 1);
          ws.consoleBuffer.delete(tab.serial);
          ws.ownerCurrent.delete(ctx.ownerId);
          this.reindexOwnerCursors(ws, idx); // 他方光标随 splice 移位（I-1：否则同 owner 校验通过不触发自愈，静默漂移）
          this.fixCurrentAfterRemoval(ws);
          this.applyLastRect(ws);
          this.emitState(ws);
          return [];
        }
        if (ws.tabs.length === 1) {
          // user 关全局唯一 tab = 关闭浏览器（spec §4 工具 11 语义保留于 user 源）
          await this.closeBrowser(wsId, source, ctx);
          return [];
        }
        this.factory.destroy(tab.view);
        ws.tabs.splice(idx, 1);
        ws.consoleBuffer.delete(tab.serial);
        if (idx < ws.current) ws.current -= 1;
        else if (idx === ws.current) ws.current = Math.min(ws.current, ws.tabs.length - 1);
        // 其他 owner 的光标/缓存随 splice 修正（全局下标移位）
        this.reindexOwnerCursors(ws, idx);
        this.applyLastRect(ws); // 关闭致 current 迁移时，新 current 视图（此前无 bounds）立即套用
        this.emitState(ws);
        return this.tabInfos(ws, source === 'agent' ? ctx.ownerId : null);
      }
      case 'switch': {
        if (source === 'agent') {
          const global = this.ownerScopedIndex(ws, ctx.ownerId, index ?? 0);
          ws.ownerCurrent.set(ctx.ownerId, global); // 仅移自己光标，不动可见 tab（spec §6.1）
          this.emitState(ws);
          return this.tabInfos(ws, ctx.ownerId);
        }
        const idx = index ?? 0;
        if (idx < 0 || idx >= ws.tabs.length) {
          throw new RangeError(`tab 下标 ${idx} 越界（现有 ${ws.tabs.length} 个 tab）`);
        }
        ws.current = idx;
        this.applyLastRect(ws); // 切换后的 current 视图此前未持 bounds——立即套用
        this.emitState(ws);
        return this.tabInfos(ws, null);
      }
    }
  }

  /** browser_close：agent 源只销毁自己集合（spec §6.4 归属制）；user 源全局销毁（renderer 已过确认卡） */
  async closeBrowser(wsId: string, source: BrowserActionSource = 'agent', ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const ws = this.requireWorkspace(wsId);
    if (source === 'agent') {
      await this.gateAgentSide(ws);
      const own = this.ownerTabs(ws, ctx.ownerId);
      for (let i = own.length - 1; i >= 0; i--) {
        const global = own[i]!;
        const tab = ws.tabs[global]!;
        this.factory.destroy(tab.view);
        ws.tabs.splice(global, 1);
        ws.consoleBuffer.delete(tab.serial);
        this.reindexOwnerCursors(ws, global); // 每次 splice 后即时修正他方光标（I-1：连删逆序也不能漏）
      }
      ws.ownerCurrent.delete(ctx.ownerId);
      this.fixCurrentAfterRemoval(ws);
      this.applyLastRect(ws);
      this.emitState(ws);
      return;
    }
    this.destroyTabs(ws);
    ws.current = 0;
    ws.ownerCurrent.clear();
    ws.takeover = 'agent'; // 全新仲裁起点（仅全局销毁——spec §6.4）
    this.stashedTabs.delete(wsId); // §7：清 stash——下次激活空态
    this.settleAgentWait(wsId, true); // park 中的 waiter 不悬挂——resolve 后按新仲裁态继续
    this.emitState(ws);
  }

  /** browser_console_messages：owner 当前 tab 环形缓冲拷贝——text 序列 */
  async consoleMessages(wsId: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<string[]> {
    const { ws, tab } = await this.requireCurrentTab(wsId, ctx);
    const buf = ws.consoleBuffer.get(tab.serial);
    return buf ? [...buf] : [];
  }

  /** browser_evaluate：设置默认关（§6.2）；内部 selector 解析脚本不受此开关约束（§3.3）；tab 按 owner 光标解析 */
  async evaluate(wsId: string, expression: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<unknown> {
    const ws = this.requireWorkspace(wsId);
    await this.gateAgentSide(ws);
    this.policy.assertEvaluate(wsId);
    const idx = this.resolveOwnerCurrent(ws, ctx.ownerId);
    const tab = idx >= 0 ? ws.tabs[idx] : undefined;
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

  /** click：selector 定位（四语法）→ 元素中心 trusted 点击序列（tab 按 owner 光标解析） */
  async click(wsId: string, selector: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    await clickElement(wc, selector, this.inputGuard());
  }

  /** hover：selector 定位 → mouseMove 至元素中心（tab 按 owner 光标解析） */
  async hover(wsId: string, selector: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    await hoverElement(wc, selector, this.inputGuard());
  }

  /** type：先 click 聚焦 → char 逐字符 → submit=true 末尾补 Enter（tab 按 owner 光标解析） */
  async type(wsId: string, selector: string, text: string, submit = false, ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    await typeText(wc, selector, text, submit, this.inputGuard());
  }

  /** pressKey：白名单（Enter/Tab/Escape/方向/翻页/Home/End）外按键抛 BrowserInvalidKeyError（tab 按 owner 光标解析） */
  async pressKey(wsId: string, key: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<void> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    pressKey(wc, key, this.inputGuard());
  }

  /** scroll：mouseWheel 事件，direction='down' 向下滚；amount 单位=滚轮格（缺省 3）（tab 按 owner 光标解析） */
  async scroll(
    wsId: string,
    direction: 'up' | 'down',
    amount: number = SCROLL_DEFAULT_AMOUNT,
    ctx: BrowserOpCtx = USER_OP_CTX,
  ): Promise<void> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    scrollWheel(wc, direction, amount, this.inputGuard());
  }

  /** snapshot：a11y 树懒附加采集 + selector 提示行（T4 起委托 snapshot.ts 模块；tab 按 owner 光标解析） */
  async snapshot(wsId: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<string> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    return takeSnapshot(wc);
  }

  /** screenshot：capturePage → PNG → 落 `<screenshotDir>/<wsId>/`（boot 注入 userData 目录；缺省 tmpdir 兜底）；filename basename 清洗（tab 按 owner 光标解析） */
  async screenshot(wsId: string, filename?: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<{ path: string }> {
    const wc = await this.requireCurrentWebContents(wsId, ctx);
    const image = await wc.capturePage();
    const safeName = path.basename(
      filename && filename.trim() !== '' ? filename : `shot-${Date.now()}.png`,
    );
    const base = this.screenshotDir ?? path.join(os.tmpdir(), 'momo-browser-shots');
    const dir = path.join(base, wsId);
    // fs/promises（审查 Nit）：方法本就 async，同步 IO 会卡主进程事件循环
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, safeName);
    await fs.promises.writeFile(file, image.toPNG());
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
    if (!ws || ws.workspaceId !== wsId) return;
    // 幂等进入也刷新输入时刻——user 态持续输入不断推迟空闲自愈（spec §4.2）；
    // 刷新点全集（三入口 + overlay mousedown）全部经本方法收敛。
    ws.lastUserInputAt = Date.now();
    if (ws.takeover === 'user') return;
    ws.takeover = 'user';
    this.emitState(ws);
  }

  /** 显式释放（agent 收到 TakenOver 错误自决等待/改道；空闲自愈见 agentWaitTick——spec 2026-09-14 §4.2） */
  releaseTakeover(wsId: string): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId || ws.takeover === 'agent') return;
    ws.takeover = 'agent';
    this.emitState(ws);
    this.settleAgentWait(wsId, true); // 放行驻留等待中的 agent 工具调用
  }

  /** 地址栏回车（第二入口）：URL 过策略 → 接管 → 当前可见 tab 载入（user 路径全局语义）。校验失败不产生接管副作用 */
  async userNavigate(wsId: string, rawUrl: string): Promise<{ url: string; title: string }> {
    const url = this.policy.assertUrl(wsId, rawUrl);
    const ws = this.requireWorkspace(wsId);
    this.userTakeover(wsId);
    let tab = ws.tabs[ws.current];
    if (!tab) {
      tab = this.createTab(ws, 'user'); // tabs 为空时新视图落在 idx 0 == current
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

  /** workspace 激活（main 切 workspace 时调）：自动 deactivate 前一活跃 ws；按 stash 重建（含归属还原）；file:// 边界根同步到该 ws 目录。不读落库折叠态（§7.4 退役——可见性真相源在 renderer） */
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
      takeover: 'agent',
      consoleBuffer: new Map(),
      ownerCurrent: new Map(),
      viewsHidden: false,
      lastUserInputAt: Date.now(),
    };
    this.active = ws;
    const stash = this.stashedTabs.get(wsId);
    if (stash && stash.urls.length > 0) {
      this.stashedTabs.delete(wsId);
      this.restoreTabs(ws, stash);
    }
    this.emitState(ws);
  }

  /** workspace 切走：stash {urls,current,owners} → 销毁视图（partition 数据落盘不动——spec §3.7） */
  onWorkspaceDeactivated(wsId: string): void {
    const ws = this.active;
    if (!ws || ws.workspaceId !== wsId) return;
    this.settleAgentWait(wsId, true);
    if (ws.tabs.length > 0 || !this.stashedTabs.has(wsId)) {
      this.stashedTabs.set(wsId, {
        urls: ws.tabs.map((t) => t.view.webContents.getURL()),
        current: ws.current,
        owners: ws.tabs.map((t) => t.owner), // 归属随清单跨 ws 保留（spec §6.5）
      });
    }
    this.destroyTabs(ws);
    ws.ownerCurrent.clear();
    this.active = null; // 不推送——新 workspace 激活时会推送其状态
  }

  /** app before-quit：销毁活跃视图（partition 数据自动落盘——spec §7） */
  disposeAll(): void {
    if (!this.active) return;
    this.settleAgentWait(this.active.workspaceId, true); // 退出前放行 waiter，不悬挂 Promise
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

  /**
   * agent 门（带驻留等待，spec 2026-09-14 §4.1）：user 态 park 至释放/空闲自愈/超时；
   * agent 态立即返回（快路径零开销）。释放后被再接管 → while 复查重新 park
   * （每次 park 独立 deadline，§4.1 竞态语义）。readAgentWaitMs=0 时回到 v1 fail-fast。
   * 循环同时要求 ws 仍是当前活跃对象——deactivate/disposeAll 清理 settle 后 stale ws
   * 的 takeover 仍 'user'，不判归属会 re-park 成永不 settle 的死等（并致重激活后
   * settle→re-park→notice ~1Hz 刷屏）；失活退出统一抛 BrowserNoViewError（与
   * requireWorkspace 对失活 ws 的语义一致）。
   */
  private async gateAgentSide(ws: ActiveWorkspace): Promise<void> {
    while (ws.takeover === 'user' && this.active === ws) {
      const waitMs = this.readAgentWaitMs?.(ws.workspaceId) ?? DEFAULT_AGENT_WAIT_MS;
      if (waitMs <= 0) {
        throw new BrowserTakenOverError(
          '浏览器被用户接管（等待已关闭）。可请用户点击浏览器侧栏的「释放」按钮，或改用 webfetch 等非浏览器方式继续当前任务',
        );
      }
      await this.parkAgentSide(ws, waitMs);
    }
    if (this.active !== ws) throw new BrowserNoViewError();
  }

  /** 单飞驻留：entry 已存在则 join 其 promise；创建时推 notice（trust 先例：notice 前置，
   *  推送抛错同步清理 entry/timer——否则后续调用 join 一个永无结果的等待） */
  private parkAgentSide(ws: ActiveWorkspace, waitMs: number): Promise<void> {
    const existing = this.agentWaiters.get(ws.workspaceId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: AgentWaitEntry = {
      promise,
      promiseResolve: resolve,
      promiseReject: reject,
      startedAt: Date.now(),
      timer: setInterval(() => this.agentWaitTick(ws.workspaceId), AGENT_WAIT_TICK_MS),
    };
    entry.timer.unref?.();
    this.agentWaiters.set(ws.workspaceId, entry);
    try {
      this.hooks.pushNotice(
        'agent-waiting-release',
        'agent 正在等待浏览器控制权——点击「释放并继续」恢复任务，或稍候自动恢复',
        ws.workspaceId,
        waitMs,
      );
    } catch (err) {
      this.agentWaiters.delete(ws.workspaceId);
      clearInterval(entry.timer);
      throw err;
    }
    return promise;
  }

  /** tick 三出口（spec §4.1）：释放复查（双保险）/ 空闲自愈 / 超时。
   *  自愈仅在「agent 正在等待」时判定——无 waiter 则本 tick 根本不会触发（不打扰原则）。 */
  private agentWaitTick(wsId: string): void {
    const ws = this.active;
    const entry = this.agentWaiters.get(wsId);
    if (!ws || ws.workspaceId !== wsId || !entry) return;
    if (ws.takeover !== 'user') {
      this.settleAgentWait(wsId, true);
      return;
    }
    const idleMs = this.readIdleAutoReleaseMs?.(wsId) ?? DEFAULT_IDLE_AUTO_RELEASE_MS;
    if (idleMs > 0 && Date.now() - ws.lastUserInputAt >= idleMs) {
      this.releaseTakeover(wsId); // 单一出口：翻转 + emitState + settle
      return;
    }
    const waitMs = this.readAgentWaitMs?.(wsId) ?? DEFAULT_AGENT_WAIT_MS;
    if (Date.now() - entry.startedAt >= waitMs) this.settleAgentWait(wsId, false, waitMs);
  }

  /** settle：resolve（释放/清理）或 reject 超时（文案诚实化，spec §4.5）。
   *  迟到 settle 对无 entry 是 no-op；entry/timer 此处统一清理，不悬挂 interval。 */
  private settleAgentWait(wsId: string, ok: boolean, waitedMs?: number): void {
    const entry = this.agentWaiters.get(wsId);
    if (!entry) return;
    this.agentWaiters.delete(wsId);
    clearInterval(entry.timer);
    if (ok) {
      entry.promiseResolve();
      return;
    }
    entry.promiseReject(
      new BrowserTakenOverError(
        `浏览器被用户接管，已等待 ${Math.round((waitedMs ?? 0) / 1000)} 秒未释放。用户可点击浏览器侧栏/提示卡上的「释放」按钮；也可以改用 webfetch 等非浏览器方式继续当前任务，稍后再回到浏览器操作`,
      ),
    );
  }

  private async requireCurrentTab(wsId: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<{ ws: ActiveWorkspace; tab: TabRecord }> {
    const ws = this.requireWorkspace(wsId);
    await this.gateAgentSide(ws);
    const idx = this.resolveOwnerCurrent(ws, ctx.ownerId);
    const tab = idx >= 0 ? ws.tabs[idx] : undefined;
    if (!tab) throw new BrowserNoViewError();
    return { ws, tab };
  }

  private async requireCurrentWebContents(wsId: string, ctx: BrowserOpCtx = USER_OP_CTX): Promise<ManagedWebContents> {
    return (await this.requireCurrentTab(wsId, ctx)).tab.view.webContents;
  }

  // ---------- 归属解析（spec 2026-09-15 §4.1 / §6.1——owner 集合与独立光标） ----------

  /** owner 拥有的全部 tab 全局下标（升序） */
  private ownerTabs(ws: ActiveWorkspace, owner: string): number[] {
    const idx: number[] = [];
    ws.tabs.forEach((t, i) => { if (t.owner === owner) idx.push(i); });
    return idx;
  }

  /** 解析 owner 光标：缓存命中且未悬空 → 用缓存；悬空 → 修正回集合首个；集合空 → -1 */
  private resolveOwnerCurrent(ws: ActiveWorkspace, owner: string): number {
    const cached = ws.ownerCurrent.get(owner);
    if (cached !== undefined && ws.tabs[cached]?.owner === owner) return cached;
    const first = this.ownerTabs(ws, owner)[0];
    if (first === undefined) return -1;
    ws.ownerCurrent.set(owner, first);
    return first;
  }

  /** 保证 owner 的 current tab 存在（无则建专属 tab）——ensureLive 的懒建语义收敛于此 */
  private ensureOwnerTab(ws: ActiveWorkspace, owner: string): number {
    const idx = this.resolveOwnerCurrent(ws, owner);
    if (idx >= 0) return idx;
    this.createTab(ws, owner);
    const next = ws.tabs.length - 1;
    ws.ownerCurrent.set(owner, next);
    return next;
  }

  /** agent 作用域下标（0..n-1）→ 全局下标；越界抛 RangeError */
  private ownerScopedIndex(ws: ActiveWorkspace, owner: string, scoped: number | undefined): number {
    const own = this.ownerTabs(ws, owner);
    const raw = scoped ?? 0;
    if (raw < 0 || raw >= own.length) {
      throw new RangeError(`tab 下标 ${raw} 越界（现有 ${own.length} 个 tab）`);
    }
    return own[raw]!;
  }

  /** 全局删除 idx 后修正 ws.current（悬空钳制到末位） */
  private fixCurrentAfterRemoval(ws: ActiveWorkspace): void {
    if (ws.current >= ws.tabs.length) ws.current = Math.max(ws.tabs.length - 1, 0);
  }

  private reindexOwnerCursors(ws: ActiveWorkspace, removedIdx: number): void {
    for (const [owner, cur] of ws.ownerCurrent) {
      if (cur === removedIdx) ws.ownerCurrent.delete(owner); // 悬空 → 下次解析回集合首个
      else if (cur > removedIdx) ws.ownerCurrent.set(owner, cur - 1);
    }
  }

  private buildState(ws: ActiveWorkspace, expandHint: boolean): BrowserState {
    const tabs = this.tabInfos(ws, null);
    const cur = tabs[ws.current];
    return {
      workspaceId: ws.workspaceId,
      tabs,
      current: ws.current,
      url: cur?.url ?? '',
      title: cur?.title ?? '',
      takeover: ws.takeover,
      trusted: this.isTrusted(ws.workspaceId),
      expandHint,
    };
  }

  /** tab 清单：owner 非空 = 该 owner 集合内重索引（agent 视角）；null = 全局（user 视角） */
  private tabInfos(ws: ActiveWorkspace, owner: string | null): TabInfo[] {
    if (owner === null) {
      return ws.tabs.map((t, i) => ({ index: i, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), owner: t.owner }));
    }
    return this.ownerTabs(ws, owner).map((global, scoped) => ({
      index: scoped,
      url: ws.tabs[global]!.view.webContents.getURL(),
      title: ws.tabs[global]!.view.webContents.getTitle(),
      owner,
    }));
  }

  private isTrusted(wsId: string): boolean {
    // N1：纯判定零副作用——本方法位于状态推送面（getState / buildState→emitState，
    // did-navigate / page-title-updated 等高频触发）；包 assertAllowed 会把 trust notice
    // 副作用泄漏进每次导航/标题更新（用户自己浏览被误弹「agent 请求访问」卡）。
    return this.policy.isAllowed(wsId);
  }

  private emitState(ws: ActiveWorkspace, opts?: { expandHint?: boolean }): void {
    this.hooks.pushState(this.buildState(ws, opts?.expandHint ?? false));
  }

  /** 自动切换/展开（spec §7.3）：仅活跃会话的 agent 导航触发——切可见 tab + expandHint；
   *  user 源与非活跃会话不打扰（expandHint=false，不动 ws.current）。 */
  private maybeAutoSwitch(ws: ActiveWorkspace, ctx: BrowserOpCtx, ownerTabIdx: number): void {
    const hit = ctx.ownerId !== 'user' && ctx.sessionId !== '' && ctx.sessionId === this.activeSessionId;
    if (hit) {
      ws.current = ownerTabIdx;
      this.applyLastRect(ws); // viewsHidden 时内部 no-op——仅记录 ws.current，显示时恢复
      this.emitState(ws, { expandHint: true });
    } else {
      this.emitState(ws);
    }
  }

  /** 不挂事件；调用方负责后续 wiring / loadURL。owner 记录归属（spec §4.1） */
  private createTab(ws: ActiveWorkspace, owner: string): TabRecord {
    const view = this.factory.create(ws.workspaceId);
    const serial = this.nextSerial++;
    ws.consoleBuffer.set(serial, []);
    const record: TabRecord = { view, serial, owner };
    ws.tabs.push(record);
    this.wireView(ws, record);
    return record;
  }

  /** fire-and-forget 载入（open/收编/恢复路径）：失败 → notice（tool 路径 navigate 自行 await+抛错） */
  private async loadForNotice(record: TabRecord, url: string, wsId: string): Promise<void> {
    try {
      await record.view.webContents.loadURL(url);
    } catch (err) {
      this.hooks.pushNotice('navigation-error', `加载 ${url} 失败：${errorMessage(err)}`, wsId);
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

  /** open / popup 收编共用：createTab + 移光标 + fire-and-forget 载入。
   *  focusVisible：user 源 true（新 tab 成为可见——既有语义）；agent 源 false
   *  （可见 tab 仅由活跃会话自动切换与用户显式切换改变，spec §6.2）。 */
  private openTabInternal(ws: ActiveWorkspace, initialUrl: string | null, owner: string, focusVisible: boolean): TabRecord {
    const record = this.createTab(ws, owner);
    const idx = ws.tabs.length - 1;
    ws.ownerCurrent.set(owner, idx);
    if (focusVisible) {
      ws.current = idx;
      this.applyLastRect(ws); // 新可见视图立即套用缓存 rect
    }
    void this.loadForNotice(record, initialUrl ?? ABOUT_BLANK, ws.workspaceId);
    return record;
  }

  /** 销毁视图集合并清空缓冲（不重置 current / takeover——由 closeBrowser / onWorkspaceDeactivated 决定） */
  private destroyTabs(ws: ActiveWorkspace): void {
    for (const tab of ws.tabs) this.factory.destroy(tab.view);
    ws.tabs = [];
    ws.consoleBuffer.clear();
  }

  /** 按 stash 重建视图——内部恢复（不重过策略）；owners 随清单还原归属（spec §6.5） */
  private restoreTabs(ws: ActiveWorkspace, stash: TabStash): void {
    stash.urls.forEach((url, i) => {
      const record = this.createTab(ws, stash.owners[i] ?? 'user');
      ws.ownerCurrent.set(record.owner, i); // 各 owner 光标指向自己最后一个 tab（resolveOwnerCurrent 的 owner 校验对同 owner 任意有效下标等价）
      void this.loadForNotice(record, url, ws.workspaceId);
    });
    ws.current = Math.min(Math.max(stash.current, 0), Math.max(ws.tabs.length - 1, 0));
    this.applyLastRect(ws); // 恢复后的 current 视图立即套用缓存 rect
  }

  /**
   * 把缓存的 sidebar rect 套用到「刚成为 current」的视图：真实 WebContentsView 默认
   * bounds 0,0,0,0（不可见），新视图不等 renderer 重报——browser:state 推送不一定触发
   * 其 ResizeObserver。lastRect 为 null（从未上报）时 no-op。隐藏期（viewsHidden）
   * no-op（spec §6.3）——仅记录 ws.current，显示时恢复。
   */
  private applyLastRect(ws: ActiveWorkspace): void {
    if (ws.viewsHidden) return;
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
      this.hooks.pushNotice('crash-reloaded', '页面渲染进程崩溃，已自动重载', ws.workspaceId);
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
      // 真实用户输入（含 user 态持续输入）刷新空闲计时——判定自愈用（spec §4.2）
      ws.lastUserInputAt = Date.now();
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
      this.hooks.pushNotice('popup-blocked', `弹窗已拦截：${errorMessage(err)}`, ws.workspaceId);
      return;
    }
    // popup 由用户页面触发，归 user（spec §4.1）；focusVisible=true——用户可感知的新 tab
    this.openTabInternal(ws, url, 'user', true);
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
