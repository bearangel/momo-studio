// renderer/src/lib/plugin/panel-channel.test.ts
//
// T3：面板 postMessage 通道（spec §6.2 五消息 + 硬约束）——
// origin/source 双校验、白名单、大小上限、限流三振断开、rpc id 配对、
// targetOrigin 严格、订阅白名单、callService 绑定插件身份。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PanelChannel,
  PANEL_SUBSCRIBABLE_EVENTS,
  type PanelHostHandlers,
} from './panel-channel';

const PLUGIN_ID = 'cg';
const ORIGIN = `momo-plugin://${PLUGIN_ID}`;

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

let ch: PanelChannel | null = null;
let fakeIframe: FakeWindow = { postMessage: vi.fn() };
let handlers: PanelHostHandlers;
/** 绑定通道 iframe 的派发（source 缺省合法；可覆写 origin/source 造违规） */
let d: (data: unknown, opts?: { origin?: string; source?: unknown }) => void;

function setup(overrides: Partial<PanelHostHandlers> = {}): void {
  fakeIframe = { postMessage: vi.fn() };
  handlers = {
    getTheme: () => ({ theme: 'light', tokens: { '--bg-canvas': 'rgb(255 255 255)' } }),
    getContext: () => ({ workspaceId: 'ws1', workspaceName: '主仓', sessionId: 's1' }),
    subscribe: vi.fn().mockResolvedValue({ ok: [], rejected: [] }),
    callService: vi.fn().mockResolvedValue({ graph: true }),
    onDisconnect: vi.fn(),
    ...overrides,
  };
  ch = new PanelChannel({
    pluginId: PLUGIN_ID,
    iframeWindow: () => fakeIframe,
    handlers,
  });
  d = (data: unknown, opts: { origin?: string; source?: unknown } = {}) => {
    const ev = {
      data,
      origin: opts.origin ?? ORIGIN,
      source: (opts.source === undefined ? fakeIframe : opts.source) as MessageEventSource | null,
    } as MessageEvent;
    ch?.receiveTest(ev);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setup();
});
afterEach(() => {
  ch?.stop();
  ch = null;
  vi.useRealTimers();
});

describe('入站硬校验', () => {
  it('origin 不符 → 违规计数，不回包', () => {
    d({ type: 'ready', id: 1 }, { origin: 'https://evil.example' });
    expect(handlers.onDisconnect).not.toHaveBeenCalled();
    expect(fakeIframe.postMessage).not.toHaveBeenCalled();
  });

  it('source 不符（非本 iframe）→ 违规计数', () => {
    d({ type: 'ready', id: 1 }, { source: { postMessage: vi.fn() } });
    expect(fakeIframe.postMessage).not.toHaveBeenCalled();
  });

  it('消息类型不在白名单 → 违规计数', () => {
    d({ type: 'host:hax', id: 1 });
    expect(fakeIframe.postMessage).not.toHaveBeenCalled();
  });

  it('单条超 256KB → 违规计数', () => {
    d({ type: 'ready', id: 1, blob: 'x'.repeat(256 * 1024 + 100) });
    expect(fakeIframe.postMessage).not.toHaveBeenCalled();
  });

  it('违规三振 → onDisconnect 且后续合法消息不再处理', () => {
    d({ type: 'host:hax', id: 1 });
    d({ type: 'host:hax', id: 2 });
    expect(handlers.onDisconnect).not.toHaveBeenCalled();
    d({ type: 'host:hax', id: 3 });
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    d({ type: 'ready', id: 4 });
    expect(fakeIframe.postMessage).not.toHaveBeenCalled();
  });
});

describe('限流（20 条/s 令牌桶）', () => {
  it('1 秒内持续轰炸 → 违规累积三振断开', () => {
    for (let i = 0; i < 23; i++) d({ type: 'ready', id: i });
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('跨秒恢复令牌 → 不误伤正常使用', () => {
    for (let i = 0; i < 20; i++) d({ type: 'ready', id: i });
    vi.advanceTimersByTime(1100);
    for (let i = 0; i < 5; i++) d({ type: 'ready', id: 100 + i });
    expect(handlers.onDisconnect).not.toHaveBeenCalled();
  });
});

describe('五消息语义', () => {
  it('ready → rpc:result 回主题快照', () => {
    d({ type: 'ready', id: 7 });
    expect(fakeIframe.postMessage).toHaveBeenCalledWith(
      {
        type: 'rpc:result',
        id: 7,
        result: { theme: 'light', tokens: { '--bg-canvas': 'rgb(255 255 255)' } },
      },
      ORIGIN,
    );
  });

  it('app:getContext → rpc:result 回上下文快照', () => {
    d({ type: 'app:getContext', id: 8 });
    expect(fakeIframe.postMessage).toHaveBeenCalledWith(
      { type: 'rpc:result', id: 8, result: { workspaceId: 'ws1', workspaceName: '主仓', sessionId: 's1' } },
      ORIGIN,
    );
  });

  it('app:subscribe → 白名单外事件进 rejected，白名单内经 handler 受理', async () => {
    const sub = vi.fn().mockResolvedValue({ ok: ['taskCompleted'], rejected: [] });
    setup({ subscribe: sub });
    d({ type: 'app:subscribe', id: 9, events: ['taskCompleted', 'appReady'] });
    await vi.waitFor(() => {
      expect(fakeIframe.postMessage).toHaveBeenCalledWith(
        { type: 'rpc:result', id: 9, result: { ok: ['taskCompleted'], rejected: ['appReady'] } },
        ORIGIN,
      );
    });
    expect(sub).toHaveBeenCalledWith(['taskCompleted']);
  });

  it('plugin:callService → handler 只收 method/params（身份由通道绑定，不取自消息）', async () => {
    d({ type: 'plugin:callService', id: 10, method: 'query', params: { q: 'HookBus' }, pluginId: 'other' });
    await vi.waitFor(() => {
      expect(fakeIframe.postMessage).toHaveBeenCalledWith(
        { type: 'rpc:result', id: 10, result: { graph: true } },
        ORIGIN,
      );
    });
    expect(handlers.callService).toHaveBeenCalledWith('query', { q: 'HookBus' });
  });

  it('callService 失败 → rpc:error 回包（面板自行降级）', async () => {
    setup({ callService: vi.fn().mockRejectedValue(new Error('service 未运行')) });
    d({ type: 'plugin:callService', id: 11, method: 'query' });
    await vi.waitFor(() => {
      expect(fakeIframe.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rpc:result', id: 11, error: 'service 未运行' }),
        ORIGIN,
      );
    });
  });
});

describe('出站', () => {
  it('post 严格 targetOrigin = momo-plugin://<id>（仅已订阅事件转发）', async () => {
    d({ type: 'app:subscribe', id: 1, events: ['taskCompleted'] });
    await vi.waitFor(() => expect(ch?.isSubscribed('taskCompleted')).toBe(true));
    fakeIframe.postMessage.mockClear();
    ch?.pushEvent('taskCompleted', { id: 't1' });
    expect(fakeIframe.postMessage).toHaveBeenCalledWith(
      { type: 'event', event: 'taskCompleted', payload: { id: 't1' } },
      ORIGIN,
    );
  });

  it('未订阅事件不转发', async () => {
    d({ type: 'app:subscribe', id: 1, events: ['taskCompleted'] });
    await vi.waitFor(() => expect(ch?.isSubscribed('taskCompleted')).toBe(true));
    ch?.pushEvent('resourceInstalled', { id: 'r1' });
    expect(fakeIframe.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'resourceInstalled' }),
      ORIGIN,
    );
  });
});

describe('订阅白名单目录', () => {
  it('只含 task/resource/session 域（无 preToolUse / pluginEnabled 等内部事件）', () => {
    expect(PANEL_SUBSCRIBABLE_EVENTS).toEqual(
      expect.arrayContaining([
        'taskCreated',
        'taskStatusChanged',
        'taskCompleted',
        'resourceInstalled',
        'resourceRemoved',
        'sessionStarted',
        'sessionEnded',
      ]),
    );
    expect(PANEL_SUBSCRIBABLE_EVENTS).not.toContain('preToolUse');
    expect(PANEL_SUBSCRIBABLE_EVENTS).not.toContain('postToolUse');
  });
});
