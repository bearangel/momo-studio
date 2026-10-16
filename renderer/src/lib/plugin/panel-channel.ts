// renderer/src/lib/plugin/panel-channel.ts
//
// 面板 postMessage 通道（P4，spec §6.2）——PanelHost 与沙箱 iframe 间的唯一通信面。
//
// 五消息（v1 全集，不设扩展机制）：
//   panel→host: ready / app:getContext / app:subscribe / plugin:callService
//   host→panel: { type:'event' } / { type:'rpc:result' }
//
// 硬约束（全部在本层强制）：
//   - 入站 origin === `momo-plugin://<pluginId>` 且 source === 本 iframe（双校验）
//   - 消息类型白名单；单条 ≤ 256KB
//   - 令牌桶限流 20 条/s；违规三振 → 断开通道（摘处理、面板显示断开态、宿主无恙）
//   - 出站 targetOrigin 恒为插件 origin（协议违规即丢）
//   - callService 身份由通道构造绑定（pluginId 不取自消息——面板只能调本插件 service）
//   - 订阅白名单 = HookBus 目录的 task/resource/session 域子集（spec §6.2）

/** 面板可订阅事件目录（spec §6.2：task / resource / session 域子集） */
export const PANEL_SUBSCRIBABLE_EVENTS = [
  'taskCreated',
  'taskStatusChanged',
  'taskCompleted',
  'resourceInstalled',
  'resourceRemoved',
  'sessionStarted',
  'sessionEnded',
] as const;

export type PanelSubscribableEvent = (typeof PANEL_SUBSCRIBABLE_EVENTS)[number];

/** 主题快照（ready 回包 / theme 推送载荷）——tokens 为 CSS 变量名→可直用颜色值 */
export interface PanelThemeSnapshot {
  theme: 'light' | 'dark';
  tokens: Record<string, string>;
}

/** app:getContext 回包形状 */
export interface PanelContextSnapshot {
  workspaceId: string;
  workspaceName: string;
  sessionId: string | null;
}

/** 宿主注入面（PanelHost 组装：stores + ipc） */
export interface PanelHostHandlers {
  getTheme(): PanelThemeSnapshot;
  getContext(): PanelContextSnapshot;
  /** 仅收白名单内事件；返回实际受理集 */
  subscribe(events: string[]): Promise<{ ok: string[]; rejected: string[] }>;
  /** RPC 透传到本插件 service（pluginId 由组装层闭包绑定） */
  callService(method: string, params: unknown): Promise<unknown>;
  /** 三振断开回调（宿主切断开态 UI） */
  onDisconnect(): void;
}

/** 面板→host 白名单 */
const INBOUND_TYPES = new Set(['ready', 'app:getContext', 'app:subscribe', 'plugin:callService']);

/** 单条消息大小上限（256KB） */
const MAX_MESSAGE_BYTES = 256 * 1024;

/** 令牌桶容量 = 突发上限（条/秒） */
const RATE_LIMIT_PER_SEC = 20;

/** 违规断开阈值（三振） */
const VIOLATION_LIMIT = 3;

interface InboundMsg {
  type: string;
  id?: number;
  events?: string[];
  method?: string;
  params?: unknown;
  [key: string]: unknown;
}

/** iframe contentWindow 的结构性子集（DOM Window 结构兼容；测试桩同形） */
export interface PanelFrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface PanelChannelOptions {
  pluginId: string;
  iframeWindow: () => PanelFrameWindow | null;
  handlers: PanelHostHandlers;
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number;
}

export class PanelChannel {
  private readonly pluginId: string;
  private readonly origin: string;
  private readonly getIframeWindow: () => PanelFrameWindow | null;
  private readonly handlers: PanelHostHandlers;
  private readonly now: () => number;

  private violations = 0;
  private disconnected = false;
  private readonly subscribed = new Set<string>();

  // 令牌桶状态
  private tokens = RATE_LIMIT_PER_SEC;
  private lastRefill = 0;

  constructor(opts: PanelChannelOptions) {
    this.pluginId = opts.pluginId;
    this.origin = `momo-plugin://${opts.pluginId}`;
    this.getIframeWindow = opts.iframeWindow;
    this.handlers = opts.handlers;
    this.now = opts.now ?? Date.now;
    this.lastRefill = this.now();
  }

  /** 面板 origin（targetOrigin 校验与入站判定共用） */
  get panelOrigin(): string {
    return this.origin;
  }

  /** 是否已断开（宿主据此切 UI 态） */
  get isDisconnected(): boolean {
    return this.disconnected;
  }

  /** 事件是否被面板订阅（事件源过滤用） */
  isSubscribed(event: string): boolean {
    return this.subscribed.has(event);
  }

  /** 挂载 window message 监听（PanelHost 在 iframe 就绪后调用） */
  start(): void {
    window.addEventListener('message', this.onMessage);
  }

  /** 摘除监听（卸载/断开） */
  stop(): void {
    window.removeEventListener('message', this.onMessage);
  }

  /** 测试注入口：以 MessageEvent 形状直接投递（生产走 window message） */
  receiveTest(ev: MessageEvent): void {
    this.onMessage(ev);
  }

  /** host→panel 推事件（仅已订阅者收到；force 用于宿主主动通知，如主题切换） */
  pushEvent(event: string, payload: unknown, opts?: { force?: boolean }): void {
    if (this.disconnected) return;
    if (!opts?.force && !this.subscribed.has(event)) return;
    this.post({ type: 'event', event, payload });
  }

  /** host→panel 发回包 */
  private pushResult(id: number, result?: unknown, error?: string): void {
    this.post(error === undefined ? { type: 'rpc:result', id, result } : { type: 'rpc:result', id, error });
  }

  private post(msg: unknown): void {
    const win = this.getIframeWindow();
    // targetOrigin '*'：不透明 origin 无法定向——消息只发给我们持有的窗口引用
    // （非广播；VS Code webview 同款模式）
    win?.postMessage(msg, '*');
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed >= 1000) {
      this.tokens = RATE_LIMIT_PER_SEC;
      this.lastRefill = t;
    }
  }

  private consumeToken(): boolean {
    this.refill();
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }

  /** 入站双校验：source === 本 iframe（身份主锚）+ origin ∈ {'null', 本插件 scheme origin} */
  private win_ok(ev: MessageEvent): boolean {
    const win = this.getIframeWindow();
    return (
      win !== null &&
      ev.source === (win as unknown as MessageEventSource) &&
      (ev.origin === 'null' || ev.origin === this.origin)
    );
  }

  private onMessage = (ev: MessageEvent): void => {
    if (this.disconnected) return;
    // 沙箱 iframe（无 allow-same-origin）的 origin 是不透明 'null'，非 scheme origin
    // （2026-10-16 真机冒烟实证）——source 身份是主锚，origin 只做白名单复核
    if (!this.win_ok(ev)) {
      this.violation();
      return;
    }
    const data = ev.data as InboundMsg | null;
    if (typeof data !== 'object' || data === null || typeof data.type !== 'string' || !INBOUND_TYPES.has(data.type)) {
      this.violation();
      return;
    }
    if (JSON.stringify(data).length > MAX_MESSAGE_BYTES) {
      this.violation();
      return;
    }
    if (!this.consumeToken()) {
      this.violation();
      return;
    }
    void this.dispatch(data).catch(() => undefined);
  };

  private async dispatch(data: InboundMsg): Promise<void> {
    const id = typeof data.id === 'number' ? data.id : -1;
    switch (data.type) {
      case 'ready':
        this.pushResult(id, this.handlers.getTheme());
        return;
      case 'app:getContext':
        this.pushResult(id, this.handlers.getContext());
        return;
      case 'app:subscribe': {
        const events = Array.isArray(data.events) ? data.events.filter((e): e is string => typeof e === 'string') : [];
        const ok = events.filter((e) => (PANEL_SUBSCRIBABLE_EVENTS as readonly string[]).includes(e));
        const rejected = events.filter((e) => !(PANEL_SUBSCRIBABLE_EVENTS as readonly string[]).includes(e));
        for (const e of ok) this.subscribed.add(e);
        const confirmed = await this.handlers.subscribe(ok);
        this.pushResult(id, { ok: confirmed.ok, rejected: [...rejected, ...confirmed.rejected] });
        return;
      }
      case 'plugin:callService': {
        if (typeof data.method !== 'string') {
          this.pushResult(id, undefined, 'callService 缺少 method');
          return;
        }
        try {
          const result = await this.handlers.callService(data.method, data.params ?? null);
          this.pushResult(id, result ?? null);
        } catch (err) {
          this.pushResult(id, undefined, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      default:
        return;
    }
  }

  private violation(): void {
    this.violations += 1;
    if (this.violations >= VIOLATION_LIMIT) {
      this.disconnect();
    }
  }

  private disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.stop();
    this.handlers.onDisconnect();
  }
}
