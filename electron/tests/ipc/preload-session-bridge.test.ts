// electron/tests/ipc/preload-session-bridge.test.ts
//
// v2.0 P1 Task 12：preload 通道契约测试（Matrix 全家删除后）。
//   - session.onMessage 单通道：只监听 session:message——反向桥（dual-listen im:message）
//     已移除，最后一个 im:message 发送方（p2p）已改发 session:message。
//   - im 命名空间仅剩 onConflict 推送订阅（发送方 session-service，通道名留待 P2 收敛）。
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
    onConflict: (cb: (conflict: unknown) => void) => () => void;
  };
  agent: Record<string, unknown>;
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

describe('preload session.onMessage 单通道（Task 12 反向桥移除）', () => {
  it('只订阅 session:message（不再桥接 im:message）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    api.session.onMessage(vi.fn());

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).toContain('session:message');
    expect(channels).not.toContain('im:message');
  });

  it('session:message 通道推送触发 session 订阅回调', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const cb = vi.fn();
    api.session.onMessage(cb);

    const handler = handlerOf('session:message');
    expect(handler).toBeDefined();
    const msg = { id: 'm1', sessionId: 's1', body: 'hi' };
    handler?.({}, msg);
    expect(cb).toHaveBeenCalledWith(msg);
  });

  it('unsubscribe 只解绑 session:message', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    const off = api.session.onMessage(vi.fn());
    const before = ipcRendererOff.mock.calls.length;
    off();
    const offChannels = ipcRendererOff.mock.calls.slice(before).map((c) => c[0]);
    expect(offChannels).toContain('session:message');
    expect(offChannels).not.toContain('im:message');
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

describe('preload im 命名空间收缩（Task 12）', () => {
  it('im 仅暴露 onConflict，订阅 im:conflict 通道', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();
    expect(Object.keys(api.im)).toEqual(['onConflict']);

    const cb = vi.fn();
    api.im.onConflict(cb);

    const handler = handlerOf('im:conflict');
    expect(handler).toBeDefined();
    const conflict = { newTaskId: 't2', currentTaskId: 't1', currentRoomId: 's1' };
    handler?.({}, conflict);
    expect(cb).toHaveBeenCalledWith(conflict);
  });
});

describe('preload agent:stream 死通道删除（P2 Task 10）', () => {
  it('不再暴露 agent.onStream，也不再订阅 agent:stream 通道（实时显示走 message_event_batch）', async () => {
    await import('../../src/preload/index');
    const api = getExposedApi();

    expect('onStream' in api.agent).toBe(false);

    const channels = ipcRendererOn.mock.calls.map((c) => c[0]);
    expect(channels).not.toContain('agent:stream');
  });
});
