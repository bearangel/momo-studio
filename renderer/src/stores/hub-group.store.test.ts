// renderer/src/stores/hub-group.store.test.ts
//
// 工作组 store 契约（M2b T4）：动作 → ipc 调用映射 / 动作后权威重拉 /
// groupChanged 推送 → 重拉 / 错误不吞（error 呈现 + rethrow）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHubGroupStore } from './hub-group.store';
import type { HubGroupChangedEvent, HubGroupInfo } from '../ipc/types';

let groupChangedCb: ((e: HubGroupChangedEvent) => void) | undefined;

const GROUP: HubGroupInfo = {
  groupId: 'g1',
  groupName: 'TeamA',
  leaderNodeId: 'node-a',
  members: [
    { nodeId: 'node-a', name: '办公室 MacBook', online: true },
    { nodeId: 'node-b', name: '客厅小主机', online: false },
  ],
};

const mockApi = {
  hub: {
    groupList: vi.fn(),
    groupCreate: vi.fn(),
    groupInvite: vi.fn(),
    groupJoin: vi.fn(),
    groupLeave: vi.fn(),
    groupTransfer: vi.fn(),
    onGroupChanged: vi.fn((cb: (e: HubGroupChangedEvent) => void) => {
      groupChangedCb = cb;
      return () => undefined;
    }),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  groupChangedCb = undefined;
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  mockApi.hub.groupList.mockResolvedValue({ groups: [GROUP] });
  useHubGroupStore.setState({ groups: [], loading: false, error: null, inviteCodes: {} });
});

describe('hub-group store 动作映射与重拉', () => {
  it('init → 订阅 onGroupChanged + 首拉列表', async () => {
    useHubGroupStore.getState().init();
    await vi.waitFor(() => expect(useHubGroupStore.getState().groups).toEqual([GROUP]));
    expect(mockApi.hub.onGroupChanged).toHaveBeenCalledTimes(1);
  });

  it('create → ipc.groupCreate({groupName})；成功后重拉列表（trim 在面板表单层）', async () => {
    mockApi.hub.groupCreate.mockResolvedValueOnce({ groupId: 'g2', nodeId: 'n1' });
    await useHubGroupStore.getState().create('TeamA');
    expect(mockApi.hub.groupCreate).toHaveBeenCalledWith({ groupName: 'TeamA' });
    expect(mockApi.hub.groupList).toHaveBeenCalledTimes(1); // 动作后重拉
  });

  it('join/leave/transfer → 对应 ipc 通道原样载荷', async () => {
    mockApi.hub.groupJoin.mockResolvedValueOnce({ groupId: 'g1' });
    await useHubGroupStore.getState().join('code-1');
    expect(mockApi.hub.groupJoin).toHaveBeenCalledWith({ inviteCode: 'code-1' });
    mockApi.hub.groupLeave.mockResolvedValueOnce({ ok: true });
    await useHubGroupStore.getState().leave('g1');
    expect(mockApi.hub.groupLeave).toHaveBeenCalledWith({ groupId: 'g1' });
    mockApi.hub.groupTransfer.mockResolvedValueOnce({ ok: true });
    await useHubGroupStore.getState().transfer('g1', 'node-b');
    expect(mockApi.hub.groupTransfer).toHaveBeenCalledWith({ groupId: 'g1', toNodeId: 'node-b' });
  });

  it('invite → 邀请码入 inviteCodes 展示态并返回', async () => {
    mockApi.hub.groupInvite.mockResolvedValueOnce({ inviteCode: 'code-9' });
    const code = await useHubGroupStore.getState().invite('g1');
    expect(code).toBe('code-9');
    expect(useHubGroupStore.getState().inviteCodes['g1']).toBe('code-9');
  });

  it('groupChanged 推送 → 重拉（事件只当失效信号）', async () => {
    useHubGroupStore.getState().init();
    await vi.waitFor(() => expect(mockApi.hub.groupList).toHaveBeenCalledTimes(1));
    const changed: HubGroupInfo = { ...GROUP, leaderNodeId: 'node-b' };
    mockApi.hub.groupList.mockResolvedValueOnce({ groups: [changed] });
    groupChangedCb?.({ groupId: 'g1', kind: 'leaderChanged', nodeId: 'node-b' });
    await vi.waitFor(() => expect(useHubGroupStore.getState().groups).toEqual([changed]));
  });

  it('动作失败 → error 呈现 hub 人话 + rethrow；列表仍重拉', async () => {
    mockApi.hub.groupLeave.mockRejectedValueOnce(new Error('组长需先转移组长身份再退组'));
    await expect(useHubGroupStore.getState().leave('g1')).rejects.toThrow('组长需先转移组长身份再退组');
    expect(useHubGroupStore.getState().error).toBe('组长需先转移组长身份再退组');
    expect(mockApi.hub.groupList).toHaveBeenCalledTimes(1);
  });

  it('M4.1 前缀剥除：RpcRemoteError 编码 `[code] 原文` rejection → error 呈现剥前缀人话，rethrow 保留原始前缀（错误身份不篡改）', async () => {
    mockApi.hub.groupTransfer.mockRejectedValueOnce(new Error('[forbidden] 仅组长（leader）可执行该操作'));
    await expect(useHubGroupStore.getState().transfer('g1', 'node-b'))
      .rejects.toThrow('[forbidden] 仅组长（leader）可执行该操作');
    expect(useHubGroupStore.getState().error).toBe('仅组长（leader）可执行该操作');
  });

  it('列表拉取失败 → error 呈现（不吞错）；重试成功即清', async () => {
    mockApi.hub.groupList.mockRejectedValueOnce(new Error('hub 未连接，请稍后重试'));
    await useHubGroupStore.getState().load();
    expect(useHubGroupStore.getState().error).toBe('hub 未连接，请稍后重试');
    mockApi.hub.groupList.mockResolvedValueOnce({ groups: [GROUP] });
    await useHubGroupStore.getState().load();
    expect(useHubGroupStore.getState().error).toBeNull();
    expect(useHubGroupStore.getState().groups).toEqual([GROUP]);
  });
});
