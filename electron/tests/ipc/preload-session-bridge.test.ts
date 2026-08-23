// electron/tests/ipc/preload-session-bridge.test.ts
//
// v2.0 P1 Task 9：preload 通道桥接契约测试。
//   - session.onMessage 反向桥：同时监听 session:message 与 im:message——
//     session-service 已发新通道，但 sync-manager / p2p / im.ipc.handlers 仍发
//     im:message（发送方在 Task 11/12 删除/改名）。不桥接则 Matrix /sync 与
//     P2P 消息不达 session.store。
//   - im.onMessage / im.onMessageEventBatch 回退单通道：Task 8 的兼容桥
//     （dual-listen）随 im.store 删除一并移除，旧命名空间只听旧通道。
//
// 实现方式：vi.mock('electron') 捕获 contextBridge.exposeInMainWorld 暴露的
// api 对象 + ipcRenderer.on/off 的注册记录，断言通道注册与回调分发。
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ChannelHandler = (_evt: unknown, payload: unknown) => void;

const ipcRendererOn = vi.fn();
const ipcRendererOff = vi.fn();
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeInMainWorld },
  ipcRenderer: {
    on: ipcRendererOn,
    off: ipcRendererOff,
    invoke: vi.fn().mockResolvedValue(undefined),
  },
}));

/** 从 exposeInMainWorld 捕获的 api 对象中取出订阅方法（结构化最小类型，避免 any） */
interface ExposedApi {
  im: {
    onMessage: (cb: (msg: unknown) => void) => () => void;
    onMessageEventBatch: (cb: (batch: unknown) => void) => () => void;
  };
  session: {
    onMessage: (cb: (msg: unknown) => void) => () => void;
    onMessageEventBatch: (cb: (batch: unknown) => void) => () => void;
  };
}

function getExposedApi(): ExposedApi {
  expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [, api] = exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
  return api;
}

/** 取某通道当前注册的 handler（最后注册的那个） */
function handlerOf(channel: string): ChannelHandler | undefined {
  const calls = ipcRendererOn.mock.calls.filter((c) => c[0] === channel);
  const last = calls[calls.length - 1];
  return last ? (last[1] as ChannelHandler) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 重新加载 preload 模块，让顶层的 exposeInMainWorld 在干净的 mock 上执行
  vi.resetModules();
});

describe('preload session.onMessage 反向桥（Task 9）', () => {
  it('同时订阅 session:message 与 im:message 两个通道', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const cb = vi.fn();
    api.session.onMessage(cb);

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).toContain('session:message');
    expect(channels).toContain('im:message');
  });

  it('im:message 通道的推送（sync-manager / p2p 路径）也能触发 session 订阅回调', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const cb = vi.fn();
    api.session.onMessage(cb);

    const handler = handlerOf('im:message');
    expect(handler).toBeDefined();
    const msg = { id: 'm1', sessionId: 's1', body: 'hi' };
    handler?.({}, msg);
    expect(cb).toHaveBeenCalledWith(msg);
  });

  it('session:message 通道的推送（session-service 路径）触发 session 订阅回调', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const cb = vi.fn();
    api.session.onMessage(cb);

    const handler = handlerOf('session:message');
    expect(handler).toBeDefined();
    const msg = { id: 'm2', sessionId: 's1', body: 'hello' };
    handler?.({}, msg);
    expect(cb).toHaveBeenCalledWith(msg);
  });

  it('unsubscribe 同时解绑两个通道', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const off = api.session.onMessage(vi.fn());
    const before = ipcRendererOff.mock.calls.length;
    off();
    const offChannels = ipcRendererOff.mock.calls.slice(before).map((c) => c[0]);
    expect(offChannels).toContain('session:message');
    expect(offChannels).toContain('im:message');
  });
});

describe('preload im 命名空间回退单通道（Task 8 兼容桥删除）', () => {
  it('im.onMessage 只订阅 im:message（不再桥接 session:message）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    api.im.onMessage(vi.fn());

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).toContain('im:message');
    expect(channels).not.toContain('session:message');
  });

  it('im.onMessageEventBatch 只订阅 im:message_event_batch（不再桥接新通道）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    api.im.onMessageEventBatch(vi.fn());

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).toContain('im:message_event_batch');
    expect(channels).not.toContain('session:message_event_batch');
  });

  it('im:message_event_batch 推送仍达 im 订阅回调（旧通道自身可用）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const cb = vi.fn();
    api.im.onMessageEventBatch(cb);

    const handler = handlerOf('im:message_event_batch');
    expect(handler).toBeDefined();
    const batch = [{ id: 'e1', messageId: 'm1', seq: 0 }];
    handler?.({}, batch);
    expect(cb).toHaveBeenCalledWith(batch);
  });
});

describe('preload session.onMessageEventBatch 单通道', () => {
  it('只订阅 session:message_event_batch（stream-relay 唯一发送方已用新通道）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    api.session.onMessageEventBatch(vi.fn());

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).toContain('session:message_event_batch');
    expect(channels).not.toContain('im:message_event_batch');
  });
});
