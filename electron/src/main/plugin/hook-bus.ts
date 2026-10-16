// electron/src/main/plugin/hook-bus.ts
//
// HookBus 类型化事件总线（spec §5.1-5.2）：15 事件 × 三分发模式
//  - emit：fire-and-forget（dispatch 同步即刻返回，handler 异步排队——storage
//    层事务内调用绝不持锁等待，Review Focus #5）
//  - parallel：全并发等齐（postToolUse 域用 dispatchAwait）
//  - waterfall：仅 preToolUse，洋葱式 deny 短路 / rewrite 链式透传
// fail-open 铁律（spec §5.4）：handler 抛错 = 该订阅者本次跳过 + logger.error，
// 不外泄、不拖垮其余订阅者与主流程。
import { logger as mainLogger } from '../logger';

/** spec §5.1 事件目录（15，刻意收窄；messageAppended 高频事件排除） */
export const PLUGIN_HOOK_EVENTS = [
  'appReady',
  'workspaceOpened',
  'workspaceClosed',
  'sessionStarted',
  'sessionEnded',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'taskCreated',
  'taskStatusChanged',
  'taskCompleted',
  'resourceInstalled',
  'resourceRemoved',
  'pluginEnabled',
  'pluginDisabled',
] as const;

export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number];

export interface PluginHookCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  logger: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
}

export interface HookDecision {
  action: 'deny' | 'rewrite';
  reason?: string;
  args?: Record<string, unknown>;
}

export type HookHandler = (
  event: PluginHookEvent,
  pluginCtx: PluginHookCtx,
  payload: unknown,
) => Promise<HookDecision | null>;

export interface HookSubscription {
  pluginId: string;
  event: PluginHookEvent;
  /** preToolUse 订阅时的工具名 matcher（如 git_*——matchToolPattern 同款通配） */
  matcher?: string;
  modulePath: string;
  handler: HookHandler;
  /** 注册方（hook-sync）注入的插件上下文；缺省走 ctxStub */
  pluginCtx?: PluginHookCtx;
}

export interface PreToolUsePayload {
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface BusLogger {
  error(msg: string, meta?: unknown): void;
}

/** 通配后缀匹配（permission.ts matchToolPattern 同款语义，子集复制避免跨层依赖） */
function matchPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/** 分发观察记录（hook_calls 审计归因面——每 handler 一条，spec §5.4） */
export interface HookDispatchRecord {
  pluginId: string;
  event: PluginHookEvent;
  matcher?: string;
  decision?: HookDecision | null;
  durationMs: number;
  success: boolean;
}

export class HookBus {
  private readonly subs: HookSubscription[] = [];
  private readonly log: BusLogger;
  private observer: ((rec: HookDispatchRecord) => void) | null = null;

  constructor(opts: { logger?: BusLogger } = {}) {
    this.log = opts.logger ?? mainLogger;
  }

  /** 注册分发观察者（hook_calls 审计落库方使用；单一槽位） */
  setDispatchObserver(fn: ((rec: HookDispatchRecord) => void) | null): void {
    this.observer = fn;
  }

  register(sub: HookSubscription): void {
    this.unregisterOne(sub.pluginId, sub.event, sub.modulePath);
    this.subs.push(sub);
  }

  /** emit 模式：同步即刻返回，handler 异步跑（错误吞日志） */
  dispatch(event: PluginHookEvent, payload: unknown): void {
    for (const sub of this.subs) {
      if (sub.event !== event) continue;
      void this.runOne(sub, event, payload).catch(() => undefined);
    }
  }

  /** parallel 模式：全并发等齐（fire-and-forget 语义仍不抛错到调用方） */
  async dispatchAwait(event: PluginHookEvent, payload: unknown): Promise<void> {
    await Promise.allSettled(
      this.subs.filter((s) => s.event === event).map((s) => this.runOne(s, event, payload)),
    );
  }

  /** waterfall（仅 preToolUse）：deny 短路；rewrite 改写 payload.args 透传下游。
   * 订阅者抛错 fail-open 跳过该层继续洋葱。无匹配订阅者 → null（直通） */
  async dispatchPreToolUse(payload: PreToolUsePayload): Promise<HookDecision | null> {
    let running: PreToolUsePayload = payload;
    for (const sub of this.subs) {
      if (sub.event !== 'preToolUse') continue;
      if (sub.matcher && !matchPattern(running.toolName, sub.matcher)) continue;
      const t0 = Date.now();
      try {
        const d = await sub.handler('preToolUse', sub.pluginCtx ?? ctxStub, running);
        this.observer?.({
          pluginId: sub.pluginId,
          event: 'preToolUse',
          matcher: sub.matcher,
          decision: d,
          durationMs: Date.now() - t0,
          success: true,
        });
        if (d?.action === 'deny') return d;
        if (d?.action === 'rewrite' && d.args) {
          running = { ...running, args: d.args };
        }
      } catch (err) {
        this.observer?.({
          pluginId: sub.pluginId,
          event: 'preToolUse',
          matcher: sub.matcher,
          durationMs: Date.now() - t0,
          success: false,
        });
        this.log.error('插件 hook 处理失败（fail-open 跳过该层）', {
          pluginId: sub.pluginId,
          event: 'preToolUse',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (running === payload) return null;
    return { action: 'rewrite', args: running.args };
  }

  unregisterPlugin(pluginId: string): void {
    for (let i = this.subs.length - 1; i >= 0; i--) {
      if (this.subs[i]!.pluginId === pluginId) this.subs.splice(i, 1);
    }
  }

  listSubscriptions(pluginId?: string): HookSubscription[] {
    return pluginId === undefined ? [...this.subs] : this.subs.filter((s) => s.pluginId === pluginId);
  }

  private unregisterOne(pluginId: string, event: PluginHookEvent, modulePath: string): void {
    const i = this.subs.findIndex(
      (s) => s.pluginId === pluginId && s.event === event && s.modulePath === modulePath,
    );
    if (i >= 0) this.subs.splice(i, 1);
  }

  private async runOne(sub: HookSubscription, event: PluginHookEvent, payload: unknown): Promise<void> {
    const t0 = Date.now();
    try {
      await sub.handler(event, sub.pluginCtx ?? ctxStub, payload);
      this.observer?.({
        pluginId: sub.pluginId,
        event,
        matcher: sub.matcher,
        durationMs: Date.now() - t0,
        success: true,
      });
    } catch (err) {
      this.observer?.({
        pluginId: sub.pluginId,
        event,
        matcher: sub.matcher,
        durationMs: Date.now() - t0,
        success: false,
      });
      this.log.error('插件 hook 处理失败（fail-open）', {
        pluginId: sub.pluginId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 订阅未带 pluginCtx 时的兜底（hook-sync 注册时都会带上） */
const ctxStub: PluginHookCtx = {
  getConfig: () => ({}),
  getDataDir: () => '',
  logger: {
    warn: (msg, meta) => mainLogger.warn(`[plugin] ${msg}`, meta),
    info: (msg, meta) => mainLogger.info(`[plugin] ${msg}`, meta),
    error: (msg, meta) => mainLogger.error(`[plugin] ${msg}`, meta),
  },
};
