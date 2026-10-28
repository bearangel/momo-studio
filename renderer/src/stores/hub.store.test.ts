// renderer/src/stores/hub.store.test.ts
//
// hub store 节点表对账契约（fix round 1 · F2）：
//   - stateChanged 进入非 online 态（connecting / disconnected）→ 节点表清空。
//     断连期间收不到 peer 上下线事件，列表必陈旧——不清则重连后幽灵行复现
//     （面板非 online 态本就隐藏列表，重连后的 hello 快照种子重新填充）
//   - stateChanged 为 online → 不清（presence 事件与快照种子是节点表的唯一来源）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHubStore } from './hub.store';
import type { HubNodePresenceEvent, HubStateChangedEvent, HubStatus } from '../ipc/types';

let stateChangedCb: ((e: HubStateChangedEvent) => void) | undefined;
let presenceCb: ((e: HubNodePresenceEvent) => void) | undefined;

const mockApi = {
  hub: {
    getStatus: vi.fn(),
    getNodes: vi.fn(),
    configure: vi.fn(),
    enroll: vi.fn(),
    forget: vi.fn(),
    onStateChanged: vi.fn((cb: (e: HubStateChangedEvent) => void) => {
      stateChangedCb = cb;
      return () => undefined;
    }),
    onNodePresence: vi.fn((cb: (e: HubNodePresenceEvent) => void) => {
      presenceCb = cb;
      return () => undefined;
    }),
  },
};

const ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: '办公室 MacBook',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
};

/** 订阅落地 + 状态快照落地（快照在途期间到达的事件会被暂存，故须等它落地） */
async function initStore(): Promise<void> {
  useHubStore.getState().init();
  await vi.waitFor(() => expect(useHubStore.getState().status).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  stateChangedCb = undefined;
  presenceCb = undefined;
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  mockApi.hub.getStatus.mockResolvedValue(ONLINE);
  mockApi.hub.getNodes.mockResolvedValue([]);
  useHubStore.setState({ status: null, nodes: [], loadError: null });
});

describe('hub store 节点表对账', () => {
  it('stateChanged → connecting：节点表清空（断线后列表不再陈旧）', async () => {
    await initStore();
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });
    expect(useHubStore.getState().nodes).toHaveLength(1);

    stateChangedCb?.({ state: 'connecting', lastError: '连接超时' });
    expect(useHubStore.getState().nodes).toEqual([]);
    expect(useHubStore.getState().status?.state).toBe('connecting');
  });

  it('stateChanged → disconnected：节点表清空', async () => {
    await initStore();
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });
    expect(useHubStore.getState().nodes).toHaveLength(1);

    stateChangedCb?.({ state: 'disconnected', lastError: null });
    expect(useHubStore.getState().nodes).toEqual([]);
  });

  it('断线清空后重连：online 种子重新填充节点表（幽灵行不复现）', async () => {
    await initStore();
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });
    stateChangedCb?.({ state: 'connecting', lastError: '连接超时' });
    expect(useHubStore.getState().nodes).toEqual([]);

    // 重连成功 → 快照种子重填（stale 节点不复活）
    stateChangedCb?.({ state: 'online', lastError: null });
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 2 });
    expect(useHubStore.getState().nodes).toEqual([
      { nodeId: 'b7d204ff', nodeName: '客厅小主机' },
    ]);
  });

  it('stateChanged → online：节点表保留（不清）', async () => {
    await initStore();
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });

    stateChangedCb?.({ state: 'online', lastError: null });
    expect(useHubStore.getState().nodes).toHaveLength(1);
  });
});

// M2.5 T3（A6）：冷启动/面板重挂载只靠推送会漏「已在线的其他节点」——补拉主进程权威集合。
// 合并语义只增不删：快照与事件两路到达，快照可能旧于事件，删行只归 kind:'offline'。
describe('hub store 节点清单补拉（M2.5 T3）', () => {
  it('pullNodes → 以权威集合落表（本机行 + 在线对端）', async () => {
    useHubStore.setState({ status: ONLINE, nodes: [], loadError: null });
    mockApi.hub.getNodes.mockResolvedValue([
      { nodeId: 'a3f9c2e1deadbeef', nodeName: '办公室 MacBook' },
      { nodeId: 'b7d204ff', nodeName: '客厅小主机' },
    ]);

    await useHubStore.getState().pullNodes();

    expect(useHubStore.getState().nodes).toEqual([
      { nodeId: 'a3f9c2e1deadbeef', nodeName: '办公室 MacBook' },
      { nodeId: 'b7d204ff', nodeName: '客厅小主机' },
    ]);
  });

  it('并集：种子缺但事件已到的新节点保留（旧快照不覆盖新事件）', async () => {
    mockApi.hub.getNodes.mockResolvedValue([{ nodeId: 'b7d204ff', nodeName: '客厅小主机' }]);
    useHubStore.getState().init();
    await vi.waitFor(() => expect(mockApi.hub.getNodes).toHaveBeenCalled());
    await vi.waitFor(() => expect(useHubStore.getState().nodes).toHaveLength(1));

    // hello 之后上线的新节点只经事件路到达（种子尚未含它）
    presenceCb?.({ kind: 'online', nodeId: 'c9f31a02', nodeName: '书房台式机', at: 5 });
    await useHubStore.getState().pullNodes();

    const nodes = useHubStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes).toContainEqual({ nodeId: 'b7d204ff', nodeName: '客厅小主机' });
    expect(nodes).toContainEqual({ nodeId: 'c9f31a02', nodeName: '书房台式机' });
  });

  it('同 nodeId 不双行（种子与事件重复时只留一行）', async () => {
    mockApi.hub.getNodes.mockResolvedValue([{ nodeId: 'b7d204ff', nodeName: '客厅小主机' }]);
    useHubStore.getState().init();
    presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });

    await useHubStore.getState().pullNodes();

    expect(useHubStore.getState().nodes).toEqual([{ nodeId: 'b7d204ff', nodeName: '客厅小主机' }]);
  });

  it('补拉失败：不清空已有节点、不置 loadError（事件路仍维护节点表）', async () => {
    useHubStore.setState({
      status: ONLINE,
      nodes: [{ nodeId: 'b7d204ff', nodeName: '客厅小主机' }],
      loadError: null,
    });
    mockApi.hub.getNodes.mockRejectedValue(new Error('Error invoking remote method: boom'));

    await useHubStore.getState().pullNodes();

    expect(useHubStore.getState().nodes).toEqual([{ nodeId: 'b7d204ff', nodeName: '客厅小主机' }]);
    expect(useHubStore.getState().loadError).toBeNull();
  });
});
