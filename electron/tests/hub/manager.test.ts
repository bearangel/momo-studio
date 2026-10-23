// hub HubManager 回归锁（fix round 1 F2）——推送通道名 + 载荷形状 + 生命周期次序。
//
// 锁什么：
// 1. 推送通道名与载荷键集（hub:stateChanged / hub:nodePresence）——生产者侧
//    （hub/index.ts 的 broadcast）真实产出，断言落在 webContents.send 上。
// 2. wsUrlOf 的 http→ws / https→wss + /ws 路径变换（经 createHubClient 的 url 实参观察）。
// 3. hubForget 的四步次序：停连接 → 清 kv 配置 → 清 keychain → 广播。
// 4. startClient 先停旧连接（连续两次 enroll 不留双连接）。
// 5. hubConfigure 的换址分叉（换址强制重新接入 / 同址仅改名保留凭证）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../src/main/hub/protocol';

interface CapturedOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  onStateChange(state: string, err?: string): void;
  onEvent(evt: EventEnvelope): void;
}

interface CapturedClient {
  id: number;
  opts: CapturedOpts;
  state: string;
  starts: number;
  stops: number;
}

// mock 装置必须挂在 vi.hoisted 上——vitest 会把 vi.mock 工厂提到文件顶部，
// 工厂内引用的顶层 const 若不在 hoisted 作用域内会在工厂执行时命中 TDZ。
const m = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  calls: [] as string[],
  clients: [] as CapturedClient[],
  enrollCalls: [] as Array<{ hubUrl: string; enrollmentToken: string; nodeName: string }>,
  cfg: { row: null as null | { hubUrl: string; nodeName: string; nodeId: string | null } },
  token: null as string | null,
  seq: 0,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown): void => {
            m.calls.push(`broadcast:${channel}`);
            m.sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// client 层替身：只复刻状态迁移（start→connecting / stop→disconnected）与入参记录，
// 不复刻 client 内部 setState→onStateChange 的回调副作用——manager 侧的回调消费
// 由用例显式调用 opts.onStateChange(...) 覆盖；client 自身语义由 client.test.ts 锁。
vi.mock('../../src/main/hub/client', () => ({
  createHubClient: (opts: CapturedOpts) => {
    const rec: CapturedClient = { id: ++m.seq, opts, state: 'disconnected', starts: 0, stops: 0 };
    m.clients.push(rec);
    return {
      start: (): void => { rec.starts += 1; rec.state = 'connecting'; m.calls.push('client.start'); },
      stop: (): void => { rec.stops += 1; rec.state = 'disconnected'; m.calls.push('client.stop'); },
      state: (): string => rec.state,
    };
  },
  enrollOverHttp: vi.fn(async (hubUrl: string, enrollmentToken: string, nodeName: string) => {
    m.enrollCalls.push({ hubUrl, enrollmentToken, nodeName });
    return { nodeId: `node-${m.enrollCalls.length}`, deviceToken: `tok-${m.enrollCalls.length}` };
  }),
}));

vi.mock('../../src/main/hub/config-store', () => ({
  createHubConfigStore: () => ({
    read: () => m.cfg.row,
    write: (row: { hubUrl: string; nodeName: string; nodeId: string | null }): void => {
      m.calls.push('config.write');
      m.cfg.row = { ...row };
    },
    clear: (): void => { m.calls.push('config.clear'); m.cfg.row = null; },
  }),
}));

vi.mock('../../src/main/hub/creds', () => ({
  getDeviceToken: vi.fn(async () => { m.calls.push('creds.get'); return m.token; }),
  setDeviceToken: vi.fn(async (token: string) => { m.calls.push('creds.set'); m.token = token; }),
  clearDeviceToken: vi.fn(async () => { m.calls.push('creds.clear'); m.token = null; }),
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// db 仅被 config-store 消费，而 config-store 已被替身接管——mock 掉避免加载 native 绑定。
vi.mock('../../src/main/storage/db', () => ({ getDb: () => ({}) }));

import * as manager from '../../src/main/hub/index';

beforeEach(async () => {
  // hubManager 是模块级单例——用 hubForget 复位（停连接 + 清配置 + 清凭证 + 清 lastError）
  await manager.hubForget();
  m.calls.length = 0;
  m.sent.length = 0;
  m.clients.length = 0;
  m.enrollCalls.length = 0;
});

describe('hub manager 推送面', () => {
  it('连接状态变化 → 广播 hub:stateChanged（通道名 + 载荷键集）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onStateChange('online');
    expect(m.sent).toContainEqual({
      channel: 'hub:stateChanged',
      payload: { state: 'online', lastError: null },
    });
  });

  it('连接错误 → hub:stateChanged 带 lastError（人话错误进推送面）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onStateChange('connecting', '连接超时');
    expect(m.sent).toContainEqual({
      channel: 'hub:stateChanged',
      payload: { state: 'connecting', lastError: '连接超时' },
    });
  });

  it('node.online 事件 → 广播 hub:nodePresence（载荷含 at）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'node.online',
      payload: { nodeId: 'n2', nodeName: 'peer', at: 123 },
    });
    expect(m.sent).toContainEqual({
      channel: 'hub:nodePresence',
      payload: { kind: 'online', nodeId: 'n2', nodeName: 'peer', at: 123 },
    });
  });

  it('node.offline 事件 → 广播 hub:nodePresence（离线载荷无 nodeName，含 at）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'node.offline',
      payload: { nodeId: 'n2', at: 456 },
    });
    expect(m.sent).toContainEqual({
      channel: 'hub:nodePresence',
      payload: { kind: 'offline', nodeId: 'n2', at: 456 },
    });
  });
});

describe('hub manager 生命周期', () => {
  it('hubUrl → ws 地址（https→wss + /ws 路径；enroll 用去尾斜杠的 origin）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787/', enrollmentToken: 't', nodeName: 'n' });
    expect(m.clients[0]!.opts.url).toBe('wss://h:8787/ws');
    expect(m.enrollCalls[0]!.hubUrl).toBe('https://h:8787');
  });

  it('hubForget 次序：停连接 → 清 kv 配置 → 清 keychain → 广播 disconnected', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.calls.length = 0;
    m.sent.length = 0;
    await manager.hubForget();
    expect(m.calls).toEqual([
      'client.stop',
      'config.clear',
      'creds.clear',
      'broadcast:hub:stateChanged',
    ]);
    expect(m.sent).toEqual([
      { channel: 'hub:stateChanged', payload: { state: 'disconnected', lastError: null } },
    ]);
  });

  it('hubForget 后 lastError 清零（状态快照不留历史错误）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onStateChange('connecting', '连接超时');
    expect(manager.hubGetStatus().lastError).toBe('连接超时');
    await manager.hubForget();
    expect(manager.hubGetStatus().lastError).toBeNull();
  });

  it('连续两次 enroll：startClient 先停旧连接（不留双连接）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't1', nodeName: 'n' });
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't2', nodeName: 'n' });
    expect(m.clients).toHaveLength(2);
    expect(m.clients[0]!.stops).toBe(1);
    expect(m.clients[1]!.stops).toBe(0);
    expect(m.clients[1]!.opts.deviceToken).toBe('tok-2');
  });
});

describe('hub manager 换址分叉', () => {
  it('换 hub 地址：停旧连接 + 清凭证 + nodeId 归零 + 不起新连接（须重新 enroll）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://a:8787', enrollmentToken: 't', nodeName: 'n1' });
    expect(m.clients).toHaveLength(1);
    m.calls.length = 0;
    const status = await manager.hubConfigure({ hubUrl: 'https://b:8787', nodeName: 'n2' });
    expect(m.calls).toContain('creds.clear');
    expect(m.clients).toHaveLength(1);
    expect(m.clients[0]!.stops).toBe(1);
    expect(m.cfg.row).toEqual({ hubUrl: 'https://b:8787', nodeName: 'n2', nodeId: null });
    expect(status.configured).toBe(true);
    expect(status.state).toBe('disconnected');
    expect(status.nodeId).toBeNull();
  });

  it('同址仅改节点名：保留 nodeId 与凭证，照旧连接', async () => {
    await manager.hubEnroll({ hubUrl: 'https://a:8787', enrollmentToken: 't', nodeName: 'n1' });
    m.calls.length = 0;
    const status = await manager.hubConfigure({ hubUrl: 'https://a:8787/', nodeName: 'n2' });
    expect(m.calls).not.toContain('creds.clear');
    expect(m.cfg.row).toEqual({ hubUrl: 'https://a:8787', nodeName: 'n2', nodeId: 'node-1' });
    expect(m.clients).toHaveLength(2);
    expect(status.nodeId).toBe('node-1');
    expect(status.state).toBe('connecting');
  });
});
