// hub HubManager 回归锁（fix round 1 F2）——推送通道名 + 载荷形状 + 生命周期次序。
//
// 锁什么：
// 1. 推送通道名与载荷键集（hub:stateChanged / hub:nodePresence）——生产者侧
//    （hub/index.ts 的 broadcast）真实产出，断言落在 webContents.send 上。
// 2. wsUrlOf 的 http→ws / https→wss + /ws 路径变换（经 createHubClient 的 url 实参观察）。
// 3. hubForget 的四步次序：停连接 → 清 kv 配置 → 清 keychain → 广播。
// 4. startClient 先停旧连接（连续两次 enroll 不留双连接）。
// 5. hubConfigure 的换址分叉（换址强制重新接入 / 同址仅改名保留凭证）。
// 6. 信任源撤销（F2）：forget / 换址收回旧 hub origin 的下载授权。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../src/main/hub/protocol';
import {
  isTrustedDownloadUrl,
  registerTrustedDownloadOrigin,
  __resetTrustedDownloadOriginsForTest,
} from '../../src/main/marketplace/installer';

interface CapturedOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  onStateChange(state: string, err?: string): void;
  onEvent(evt: EventEnvelope): void;
  onHelloSnapshot?: (nodes: Array<{ nodeId: string; nodeName: string }>) => void;
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
  __resetTrustedDownloadOriginsForTest();
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

  it('group.changed 事件 → 广播 hub:groupChanged（M2b 桥：三字段显式挑出）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'group.changed',
      payload: { groupId: 'g1', kind: 'leaderChanged', nodeId: 'n2', extra: '不透传' },
    });
    expect(m.sent).toContainEqual({
      channel: 'hub:groupChanged',
      payload: { groupId: 'g1', kind: 'leaderChanged', nodeId: 'n2' },
    });
  });

  it('task.progress 事件 → 广播 hub:taskProgress（M2e T12 桥：四字段全须，异形丢弃）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.progress',
      payload: { taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 42, excerpt: '正在重构登录模块', extra: '不透传' },
    });
    expect(m.sent).toEqual([
      {
        channel: 'hub:taskProgress',
        payload: { taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 42, excerpt: '正在重构登录模块' },
      },
    ]);

    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.progress',
      payload: { taskId: 'tk-1', sessionId: 'sess-1', lastSeq: '异形', excerpt: 'x' },
    });
    expect(m.sent).toEqual([]);
  });

  it('task.completed/failed/interrupted → 各自通道；failed 携 reason、interrupted 无 reason、异形 taskId 丢弃', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.completed',
      payload: { taskId: 'tk-1', reason: '终态不携带也透传防杂——不应出现' },
    });
    expect(m.sent).toEqual([{ channel: 'hub:taskCompleted', payload: { taskId: 'tk-1' } }]);

    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.failed',
      payload: { taskId: 'tk-2', reason: 'declined:并发已达上限（2）' },
    });
    expect(m.sent).toEqual([
      { channel: 'hub:taskFailed', payload: { taskId: 'tk-2', reason: 'declined:并发已达上限（2）' } },
    ]);

    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.interrupted',
      payload: { taskId: 'tk-3' },
    });
    expect(m.sent).toEqual([{ channel: 'hub:taskInterrupted', payload: { taskId: 'tk-3' } }]);

    m.sent.length = 0;
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'task.failed',
      payload: { taskId: 42 },
    });
    expect(m.sent).toEqual([]);
  });

  it('hello 快照 → 逐节点广播 presence 种子，排除本机 nodeId（不与自合成行重复）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    // enroll 派生的本机 nodeId = 'node-1'（mock enroll 第 1 次返回）——必须被排除
    m.clients[0]!.opts.onHelloSnapshot!([
      { nodeId: 'node-1', nodeName: '本机' },
      { nodeId: 'node-2', nodeName: '客厅小主机' },
    ]);
    expect(m.sent).toEqual([
      {
        channel: 'hub:nodePresence',
        payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' },
      },
    ]);
  });

  it('hello 快照含多个对端 → 各播一条 presence 种子（本机缺席时全量播）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.sent.length = 0;
    m.clients[0]!.opts.onHelloSnapshot!([
      { nodeId: 'node-2', nodeName: '客厅小主机' },
      { nodeId: 'node-3', nodeName: '书房台式机' },
    ]);
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' } },
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-3', nodeName: '书房台式机' } },
    ]);
  });

  it('种子随事件维护：node.online 入集合、node.offline 出集合，重播反映最新集合', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    // hello 后新节点上线 → 进种子（否则重播漏行）
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'node.online',
      payload: { nodeId: 'node-3', nodeName: '书房台式机', at: 7 },
    });
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' } },
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-3', nodeName: '书房台式机' } },
    ]);
    // 下线 → 出种子（否则重播推幽灵行）
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'node.offline',
      payload: { nodeId: 'node-2', at: 8 },
    });
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-3', nodeName: '书房台式机' } },
    ]);
  });

  it('node.online 事件带本机 nodeId → 不入种子（重播不与自合成行重复）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    m.clients[0]!.opts.onEvent({
      v: 1, kind: 'evt', method: 'node.online',
      payload: { nodeId: 'node-1', nodeName: '本机', at: 9 },
    });
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' } },
    ]);
  });

  it('重播种子 → 面板挂载晚于 hello 时仍见全量在线节点', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' } },
    ]);
  });

  it('重播种子 → 排除本机节点（与自合成行不重复）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([
      { nodeId: 'node-1', nodeName: '本机' },
      { nodeId: 'node-2', nodeName: '客厅小主机' },
    ]);
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([
      { channel: 'hub:nodePresence', payload: { kind: 'online', nodeId: 'node-2', nodeName: '客厅小主机' } },
    ]);
  });

  it('忘记接入 → 种子清空（重播不推陈旧节点）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    await manager.hubForget();
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([]);
  });

  it('新连接开始 → 旧种子作废（重播不推上个连接的陈旧节点）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't2', nodeName: 'n' });
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([]);
  });

  it('换 hub 地址 → 旧快照作废（重播不推上个 hub 的节点）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://a:8787', enrollmentToken: 't', nodeName: 'n' });
    m.clients[0]!.opts.onHelloSnapshot!([{ nodeId: 'node-2', nodeName: '客厅小主机' }]);
    await manager.hubConfigure({ hubUrl: 'https://b:8787', nodeName: 'n' });
    m.sent.length = 0;
    manager.replayPresenceSeed();
    expect(m.sent).toEqual([]);
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

  it('换址后 lastError 清零（换址重置陈旧错误，不留历史错误）', async () => {
    await manager.hubEnroll({ hubUrl: 'https://a:8787', enrollmentToken: 't', nodeName: 'n1' });
    m.clients[0]!.opts.onStateChange('connecting', '连接超时');
    expect(manager.hubGetStatus().lastError).toBe('连接超时');
    const status = await manager.hubConfigure({ hubUrl: 'https://b:8787', nodeName: 'n2' });
    expect(status.lastError).toBeNull();
    expect(manager.hubGetStatus().lastError).toBeNull();
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

describe('hub manager 信任源撤销（F2）', () => {
  it('hubForget → 撤当前 hubUrl 的下载信任（授权随接入收回）', async () => {
    await manager.hubEnroll({ hubUrl: 'http://a:8787', enrollmentToken: 't', nodeName: 'n' });
    // 模拟目录拉取时的 origin 登记（生产路径：momo-hub load() 调 register）
    registerTrustedDownloadOrigin('http://a:8787');
    expect(isTrustedDownloadUrl('http://a:8787/resources/x/download')).toBe(true);

    await manager.hubForget();

    expect(isTrustedDownloadUrl('http://a:8787/resources/x/download')).toBe(false);
  });

  it('换址 → 旧 origin 撤销、新 origin 登记', async () => {
    await manager.hubEnroll({ hubUrl: 'http://a:8787', enrollmentToken: 't', nodeName: 'n' });
    registerTrustedDownloadOrigin('http://a:8787');

    await manager.hubConfigure({ hubUrl: 'http://b:8787', nodeName: 'n' });

    expect(isTrustedDownloadUrl('http://a:8787/resources/x/download')).toBe(false);
    expect(isTrustedDownloadUrl('http://b:8787/resources/x/download')).toBe(true);
  });

  it('同址改名 → 信任保持（不撤销也不重复登记）', async () => {
    await manager.hubEnroll({ hubUrl: 'http://a:8787', enrollmentToken: 't', nodeName: 'n1' });
    registerTrustedDownloadOrigin('http://a:8787');

    await manager.hubConfigure({ hubUrl: 'http://a:8787/', nodeName: 'n2' });

    expect(isTrustedDownloadUrl('http://a:8787/resources/x/download')).toBe(true);
  });
});
