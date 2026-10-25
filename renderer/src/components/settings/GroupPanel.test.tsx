// renderer/src/components/settings/GroupPanel.test.tsx
//
// 工作组面板行为测试（M2b T4）——RM2-3 豁免形态（复用既有表单/列表模式）：
// - 离线态：面板降级为提示行（无表单无列表）
// - 无组：创建表单（trim 提交）+ 凭码入组表单；reject 文案原文呈现
// - 有组：组卡（成员在线点/组长 Badge/本机 Badge）+ 生成邀请码（展示+复制）+
//   设为组长（transfer）+ 退组两步确认
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GroupPanel } from './GroupPanel';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import type { HubGroupChangedEvent, HubStatus } from '../../ipc/types';

let groupChangedCb: ((e: HubGroupChangedEvent) => void) | undefined;

const api = {
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
    // 委派面板区段（M2e T12）挂载在 GroupPanel 内——mock 面补齐 task.* 通道（默认空账本）
    taskList: vi.fn(async () => ({ tasks: [] })),
    taskDelegate: vi.fn(),
    taskCancel: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
    // 查看面板（M2e T14）挂载在 GroupPanel 内——mock 面补齐 view.* 通道
    //（默认不打开面板：onViewAppended 捕获回调即可，拉取面不触达）
    onViewAppended: vi.fn(() => () => undefined),
  },
  // ViewPanel 空间选择前置步按需拉本机工作空间（picking 时才调；默认空表）
  workspace: {
    list: vi.fn(async () => []),
    switch: vi.fn(async () => undefined),
  },
};

const ONLINE_STATUS: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: '办公室 MacBook',
  nodeId: 'node-a',
  lastError: null,
};

const GROUP = {
  groupId: 'g1',
  groupName: 'TeamA',
  leaderNodeId: 'node-a',
  members: [
    { nodeId: 'node-a', name: '办公室 MacBook', online: true },
    { nodeId: 'node-b', name: '客厅小主机', online: false },
  ],
};

/** 等待任一 alert 含指定文案（面板级与表单级 alert 可能同时在场——按文本断言不按唯一性） */
async function expectAlert(text: string): Promise<void> {
  await waitFor(() => {
    const alerts = screen.getAllByRole('alert').map((el) => el.textContent ?? '');
    expect(alerts.join('\n')).toContain(text);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  groupChangedCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  useHubStore.setState({ status: ONLINE_STATUS, nodes: [], loadError: null });
  useHubGroupStore.setState({ groups: [], loading: false, error: null, inviteCodes: {} });
  api.hub.groupList.mockResolvedValue({ groups: [] });
});

describe('GroupPanel 离线与空态', () => {
  it('非 online → 提示行，无表单无列表', async () => {
    useHubStore.setState({ status: { ...ONLINE_STATUS, state: 'connecting' }, nodes: [], loadError: null });
    render(<GroupPanel />);
    expect(screen.getByText('连接建立后可创建或加入工作组')).toBeInTheDocument();
    expect(screen.queryByLabelText('组名')).not.toBeInTheDocument();
    expect(api.hub.groupList).not.toHaveBeenCalled();
  });

  it('无组 → 创建表单 + 凭码入组表单；创建 trim 提交调 groupCreate', async () => {
    api.hub.groupCreate.mockResolvedValueOnce({ groupId: 'g1', nodeId: 'node-a' });
    api.hub.groupList.mockResolvedValueOnce({ groups: [] }).mockResolvedValueOnce({ groups: [GROUP] });
    render(<GroupPanel />);
    await screen.findByLabelText('组名');
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: ' TeamA ' } });
    fireEvent.click(screen.getByRole('button', { name: '创建工作组' }));
    await waitFor(() => expect(api.hub.groupCreate).toHaveBeenCalledWith({ groupName: 'TeamA' }));
    // 成功后重拉 → 组卡出现
    await screen.findByText('TeamA');
  });

  it('创建失败 → 错误文案原文呈现', async () => {
    api.hub.groupCreate.mockRejectedValueOnce(new Error('组名非法（1-64 个字符）'));
    render(<GroupPanel />);
    await screen.findByLabelText('组名');
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: 'x'.repeat(65) } });
    fireEvent.click(screen.getByRole('button', { name: '创建工作组' }));
    await expectAlert('组名非法（1-64 个字符）');
  });

  it('凭码入组：join 失败（撤销码）文案原文；成功入组后组卡出现', async () => {
    api.hub.groupJoin.mockRejectedValueOnce(new Error('邀请码无效或已被撤销'));
    render(<GroupPanel />);
    await screen.findByLabelText('邀请码');
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: ' stale-code ' } });
    fireEvent.click(screen.getByRole('button', { name: '凭码入组' }));
    await expectAlert('邀请码无效或已被撤销');

    api.hub.groupJoin.mockResolvedValueOnce({ groupId: 'g1' });
    api.hub.groupList.mockResolvedValueOnce({ groups: [GROUP] });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: ' code-2 ' } });
    fireEvent.click(screen.getByRole('button', { name: '凭码入组' }));
    await waitFor(() => expect(api.hub.groupJoin).toHaveBeenCalledWith({ inviteCode: 'code-2' }));
    await screen.findByText('TeamA');
  });
});

describe('GroupPanel 组卡操作', () => {
  beforeEach(async () => {
    api.hub.groupList.mockResolvedValue({ groups: [GROUP] });
  });

  async function renderWithGroup(): Promise<void> {
    render(<GroupPanel />);
    await screen.findByText('TeamA');
  }

  it('组卡渲染：成员在线点、组长 Badge（leaderNodeId 命中）、本机 Badge', async () => {
    await renderWithGroup();
    expect(screen.getByText('2 名成员')).toBeInTheDocument();
    expect(screen.getByText('组长')).toBeInTheDocument();
    expect(screen.getByText('本机')).toBeInTheDocument();
    expect(screen.getByText('客厅小主机')).toBeInTheDocument();
  });

  it('生成邀请码 → 展示 + 复制按钮；再生成提示换文案', async () => {
    api.hub.groupInvite.mockResolvedValueOnce({ inviteCode: 'code-9' });
    await renderWithGroup();
    fireEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
    await screen.findByText('code-9');
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新生成邀请码' })).toBeInTheDocument();
  });

  it('非组长成员行有「设为组长」；点击调 transfer（leader-only 由 hub 层强制）', async () => {
    api.hub.groupTransfer.mockResolvedValueOnce({ ok: true });
    api.hub.groupList.mockResolvedValueOnce({ groups: [GROUP] });
    await renderWithGroup();
    fireEvent.click(screen.getByRole('button', { name: '设为组长' }));
    await waitFor(() => expect(api.hub.groupTransfer).toHaveBeenCalledWith({ groupId: 'g1', toNodeId: 'node-b' }));
  });

  it('非 leader 调 transfer 被拒 → store.error 呈现 forbidden 人话', async () => {
    api.hub.groupTransfer.mockRejectedValueOnce(new Error('仅组长（leader）可执行该操作'));
    await renderWithGroup();
    fireEvent.click(screen.getByRole('button', { name: '设为组长' }));
    await expectAlert('仅组长（leader）可执行该操作');
  });

  it('退组两步确认：首击亮确认态、再击才调 groupLeave；leader 被拒文案呈现', async () => {
    await renderWithGroup();
    fireEvent.click(screen.getByRole('button', { name: '退组' }));
    expect(api.hub.groupLeave).not.toHaveBeenCalled();
    api.hub.groupLeave.mockRejectedValueOnce(new Error('组长需先转移组长身份再退组'));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认退组' }));
    await waitFor(() => expect(api.hub.groupLeave).toHaveBeenCalledWith({ groupId: 'g1' }));
    await expectAlert('组长需先转移组长身份再退组');
  });

  it('groupChanged 推送 → 列表重拉刷新（leader 转移后组长 Badge 移位）', async () => {
    await renderWithGroup();
    const transferred = {
      ...GROUP,
      leaderNodeId: 'node-b',
      members: GROUP.members.map((m) => ({ ...m, online: true })),
    };
    api.hub.groupList.mockResolvedValueOnce({ groups: [transferred] });
    await act(async () => {
      groupChangedCb?.({ groupId: 'g1', kind: 'leaderChanged', nodeId: 'node-b' });
    });
    await waitFor(() => {
      const row = screen.getByText('客厅小主机').closest('li');
      expect(row?.textContent).toContain('组长');
    });
  });
});
