// renderer/src/components/settings/HubSettingsPanel.test.tsx
//
// 节点互联面板（momo-hub M0 Task 11）行为测试——按已批预览三态 + brief Step 2 清单：
// - 未接入：三输入 + 接入按钮；提交调 api.hub.enroll（trim 后）；reject 展示错误文案原文
// - 已接入：徽章 / hub 地址 / 本机身份短码 / 在线节点列表（本机标记）；onStateChanged
//   置 online 后徽章「连接中 → 已连接」切换
// - onNodePresence online 增 / offline 减 / 本机 id 去重
// - 两步确认忘记：首击亮「再次点击确认」、再击才调 api.hub.forget；成功后回未接入表单
// - enroll 错误「加入凭证无效」原文展示（经 ipc 代理剥 Electron 包装前缀——D11 纪律）
// - 换址重接（configured && nodeId === null）：提示行 + 预填表单
// - 连接中断：连接中徽章 + lastError 原文 + 重试提示 + 列表降级占位行
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HubSettingsPanel } from './HubSettingsPanel';
import { useHubStore } from '../../stores/hub.store';
import type { HubNodePresenceEvent, HubStateChangedEvent, HubStatus } from '../../ipc/types';

// 推送回调捕获——mock 订阅时截下回调供测试手动派发（仿真主进程 webContents.send）
let stateChangedCb: ((e: HubStateChangedEvent) => void) | undefined;
let presenceCb: ((e: HubNodePresenceEvent) => void) | undefined;

const api = {
  hub: {
    getStatus: vi.fn(),
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
    // 工作组面板（M2b）挂载在已接入视图内——mock 面补齐组通道面（默认空组）
    groupList: vi.fn(async () => ({ groups: [] })),
    groupCreate: vi.fn(),
    groupInvite: vi.fn(),
    groupJoin: vi.fn(),
    groupLeave: vi.fn(),
    groupTransfer: vi.fn(),
    onGroupChanged: vi.fn(() => () => undefined),
    // 委派子节点区段（M2e T10）——默认接受开/并发 2；set 回显归一化值
    getDelegationSettings: vi.fn(async () => ({ acceptTasks: true, maxConcurrent: 2 })),
    setDelegationSettings: vi.fn(async (input: { acceptTasks: boolean; maxConcurrent: number }) => input),
    onMirrorResult: vi.fn(() => () => undefined),
    onWorkspaceMirrored: vi.fn(() => () => undefined),
    // 委派面板区段（M2e T12）挂载在 GroupPanel 内——mock 面补齐 task.* 通道（默认空账本）
    taskList: vi.fn(async () => ({ tasks: [] })),
    taskDelegate: vi.fn(),
    taskCancel: vi.fn(),
    onTaskProgress: vi.fn(() => () => undefined),
    onTaskCompleted: vi.fn(() => () => undefined),
    onTaskFailed: vi.fn(() => () => undefined),
    onTaskInterrupted: vi.fn(() => () => undefined),
  },
};

const UNENROLLED: HubStatus = {
  configured: false,
  state: 'disconnected',
  hubUrl: null,
  nodeName: null,
  nodeId: null,
  lastError: null,
};

const ENROLLED_ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'https://hub.example.com:8787',
  nodeName: '办公室 MacBook',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
};

const ENROLLED_CONNECTING: HubStatus = {
  ...ENROLLED_ONLINE,
  state: 'connecting',
  lastError: '无法连接 hub',
};

function fillEnrollForm(): void {
  fireEvent.change(screen.getByLabelText('hub 地址'), {
    target: { value: ' https://hub.example.com:8787 ' },
  });
  fireEvent.change(screen.getByLabelText('节点名'), {
    target: { value: ' 办公室 MacBook ' },
  });
  fireEvent.change(screen.getByLabelText('加入凭证'), {
    target: { value: ' join-7f3k-q2x9 ' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stateChangedCb = undefined;
  presenceCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  useHubStore.setState({ status: null, nodes: [], loadError: null });
});

describe('HubSettingsPanel', () => {
  it('未接入：渲染三输入 + 接入按钮；提交调 enroll（trim 后入参），成功后翻到已接入视图', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    api.hub.enroll.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);

    await screen.findByLabelText('hub 地址');
    expect(screen.getByLabelText('节点名')).toBeInTheDocument();
    expect(screen.getByLabelText('加入凭证')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接入' })).toBeInTheDocument();

    fillEnrollForm();
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    await waitFor(() =>
      expect(api.hub.enroll).toHaveBeenCalledTimes(1),
    );
    expect(api.hub.enroll).toHaveBeenCalledWith({
      hubUrl: 'https://hub.example.com:8787',
      enrollmentToken: 'join-7f3k-q2x9',
      nodeName: '办公室 MacBook',
    });
    // enroll 返回快照覆盖 store → 面板切已接入视图（身份区在场）
    await screen.findByText('本机节点');
  });

  it('已接入：连接中徽章 + 地址 + 身份 + 本机列表行；onStateChanged 置 online 后徽章切换', async () => {
    api.hub.getStatus.mockResolvedValue({ ...ENROLLED_CONNECTING, lastError: null });
    render(<HubSettingsPanel />);

    expect(await screen.findByText('连接中')).toBeInTheDocument();
    expect(screen.getByText('https://hub.example.com:8787')).toBeInTheDocument();
    // connecting 态列表降级占位：节点名/短码仅身份行在场（预览态 3 定值）
    expect(screen.getAllByText('办公室 MacBook').length).toBe(1);
    expect(screen.getAllByText('a3f9c2e1').length).toBe(1);
    expect(screen.queryByText('本机')).not.toBeInTheDocument();

    act(() => {
      stateChangedCb?.({ state: 'online', lastError: null });
    });
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.queryByText('连接中')).not.toBeInTheDocument();
    // online 态本机行合成到场：身份行 + 列表本机行（「本机」Badge）双在场
    expect(screen.getAllByText('办公室 MacBook').length).toBe(2);
    expect(screen.getAllByText('a3f9c2e1').length).toBe(2);
    expect(screen.getByText('本机')).toBeInTheDocument();
  });

  it('已连接：在线列表 helper 文案改为「连接时同步」（OBS-1：快照随连接下发）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);
    expect(await screen.findByText(/在线状态在连接时同步/)).toBeInTheDocument();
    expect(screen.queryByText(/上线通知驱动/)).not.toBeInTheDocument();
  });

  it('已接入态：修改 hub 地址入口 → 确认后调 configure（新地址）→ 落到换址引导态', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    api.hub.configure.mockResolvedValue({
      ...ENROLLED_ONLINE,
      state: 'disconnected',
      hubUrl: 'https://new.example.com:8787',
      nodeId: null,
    });
    render(<HubSettingsPanel />);

    // 入口：已接入态身份区的次级按钮
    fireEvent.click(await screen.findByRole('button', { name: '修改 hub 地址' }));

    // 弹确认：警告文案 + 新地址输入（预填当前地址）
    expect(screen.getByText('修改地址后将断开并需要重新接入')).toBeInTheDocument();
    const input = screen.getByLabelText('新 hub 地址') as HTMLInputElement;
    expect(input.value).toBe('https://hub.example.com:8787');
    // 第一步不调 configure（确认前不换址）
    expect(api.hub.configure).not.toHaveBeenCalled();

    // 第二步：改地址 + 确认
    fireEvent.change(input, { target: { value: ' https://new.example.com:8787 ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    await waitFor(() => expect(api.hub.configure).toHaveBeenCalledTimes(1));
    expect(api.hub.configure).toHaveBeenCalledWith({
      hubUrl: 'https://new.example.com:8787',
      nodeName: '办公室 MacBook',
    });
    // 换址后落到换址引导态（configured && nodeId 归零）
    expect(await screen.findByText('地址已变更，需重新接入')).toBeInTheDocument();
  });

  it('修改 hub 地址：取消确认 → 不调 configure（面板留在已接入态）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '修改 hub 地址' }));
    expect(screen.getByText('修改地址后将断开并需要重新接入')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() =>
      expect(screen.queryByText('修改地址后将断开并需要重新接入')).not.toBeInTheDocument(),
    );
    expect(api.hub.configure).not.toHaveBeenCalled();
    expect(screen.getByText('本机节点')).toBeInTheDocument();
  });

  it('修改 hub 地址：configure 失败 → 弹窗内错误原文展示，可重试', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    // 仿真真实运行时语义：Electron 会把 ipcMain.handle 的 throw 包上前缀再 reject（D11）
    api.hub.configure.mockRejectedValue(
      new Error("Error invoking remote method 'hub:configure': Error: 地址非法"),
    );
    render(<HubSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '修改 hub 地址' }));
    fireEvent.change(screen.getByLabelText('新 hub 地址'), {
      target: { value: 'https://new.example.com:8787' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('地址非法');
    expect(alert).not.toHaveTextContent('Error invoking');
    // 失败不换址——仍留在已接入态
    expect(screen.getByText('本机节点')).toBeInTheDocument();
  });

  it('修改 hub 地址：地址为空 → 确认钮禁用（不调 configure）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '修改 hub 地址' }));
    fireEvent.change(screen.getByLabelText('新 hub 地址'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '确认修改' })).toBeDisabled();
    expect(api.hub.configure).not.toHaveBeenCalled();
  });

  it('断线清空：connecting 清节点表，重连后种子重填（幽灵行不复现）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);
    await screen.findByText('在线节点');

    act(() => {
      presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });
    });
    expect(await screen.findByText('客厅小主机')).toBeInTheDocument();
    expect(screen.getByText('2 台')).toBeInTheDocument();

    // 断线 → 列表降级占位（节点表清空）
    act(() => {
      stateChangedCb?.({ state: 'connecting', lastError: '连接超时' });
    });
    expect(screen.getByText('连接中断——在线节点列表暂停更新')).toBeInTheDocument();

    // 重连 → online；对端未再上报则不再出现（幽灵行不复现）
    act(() => {
      stateChangedCb?.({ state: 'online', lastError: null });
    });
    expect(screen.getByText('1 台')).toBeInTheDocument();
    expect(screen.queryByText('客厅小主机')).not.toBeInTheDocument();

    // 新快照种子到达 → 重新填充
    act(() => {
      presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 2 });
    });
    expect(await screen.findByText('客厅小主机')).toBeInTheDocument();
    expect(screen.getByText('2 台')).toBeInTheDocument();
  });

  it('订阅先于快照（防丢事件：onStateChanged/onNodePresence 注册先于 getStatus 调用）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<HubSettingsPanel />);
    await screen.findByLabelText('hub 地址');
    // 未调用时以 ±Infinity 兜底——任一缺失都让比较必然失败（红），免非空断言
    const stateOrder = api.hub.onStateChanged.mock.invocationCallOrder[0] ?? Infinity;
    const presenceOrder = api.hub.onNodePresence.mock.invocationCallOrder[0] ?? Infinity;
    const snapshotOrder = api.hub.getStatus.mock.invocationCallOrder[0] ?? -Infinity;
    expect(stateOrder).toBeLessThan(snapshotOrder);
    expect(presenceOrder).toBeLessThan(snapshotOrder);
  });

  it('onNodePresence：online 增行、offline 减行；本机 id 重复上线不去重失败（不双行）', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);
    await screen.findByText('在线节点');
    expect(screen.getByText('1 台')).toBeInTheDocument(); // 快照合成的本机行

    act(() => {
      presenceCb?.({ kind: 'online', nodeId: 'b7d204ff', nodeName: '客厅小主机', at: 1 });
    });
    expect(await screen.findByText('客厅小主机')).toBeInTheDocument();
    expect(screen.getByText('2 台')).toBeInTheDocument();

    // 本机 id 再上线（hub 回显自己）——不产生重复行
    act(() => {
      presenceCb?.({ kind: 'online', nodeId: 'a3f9c2e1deadbeef', nodeName: '办公室 MacBook', at: 2 });
    });
    expect(screen.getByText('2 台')).toBeInTheDocument();
    expect(screen.getAllByText('办公室 MacBook').length).toBe(2);

    act(() => {
      presenceCb?.({ kind: 'offline', nodeId: 'b7d204ff' });
    });
    await waitFor(() => expect(screen.queryByText('客厅小主机')).not.toBeInTheDocument());
    expect(screen.getByText('1 台')).toBeInTheDocument();
  });

  it('两步确认忘记：首击亮确认态且不调 forget；再击才调 forget；成功后回未接入表单', async () => {
    api.hub.getStatus
      .mockResolvedValueOnce(ENROLLED_ONLINE) // init 快照
      .mockResolvedValue(UNENROLLED); // forget 后重拉
    api.hub.forget.mockResolvedValue(undefined);
    render(<HubSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /断开并忘记/ }));
    expect(screen.getByRole('button', { name: '再次点击确认' })).toBeInTheDocument();
    expect(screen.getByText('将删除本机的接入凭证与配置，不可恢复')).toBeInTheDocument();
    expect(api.hub.forget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '再次点击确认' }));
    await waitFor(() => expect(api.hub.forget).toHaveBeenCalledTimes(1));
    // store 重拉快照 configured=false → 回到接入表单
    await screen.findByLabelText('hub 地址');
  });

  it('enroll 失败：「加入凭证无效」原文展示（剥 IPC 包装前缀），表单保留可重试', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    // 仿真真实运行时语义：Electron 会把 ipcMain.handle 的 throw 包上前缀再 reject（D11）
    api.hub.enroll.mockRejectedValue(
      new Error("Error invoking remote method 'hub:enroll': Error: 加入凭证无效"),
    );
    render(<HubSettingsPanel />);

    await screen.findByLabelText('hub 地址');
    fillEnrollForm();
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('加入凭证无效');
    expect(alert).not.toHaveTextContent('Error invoking');
    // 表单仍在场（值保留），可改凭证重试
    expect(screen.getByRole('button', { name: '接入' })).toBeInTheDocument();
  });

  it('换址重接（configured 且 nodeId 为空）：提示行 + 预填当前 hubUrl/节点名的接入表单', async () => {
    api.hub.getStatus.mockResolvedValue({
      configured: true,
      state: 'disconnected',
      hubUrl: 'https://new.example.com:8787',
      nodeName: '旧节点名',
      nodeId: null,
      lastError: null,
    });
    render(<HubSettingsPanel />);

    expect(await screen.findByText('地址已变更，需重新接入')).toBeInTheDocument();
    expect((screen.getByLabelText('hub 地址') as HTMLInputElement).value).toBe(
      'https://new.example.com:8787',
    );
    expect((screen.getByLabelText('节点名') as HTMLInputElement).value).toBe('旧节点名');
    expect(screen.getByLabelText('加入凭证')).toBeInTheDocument();
  });

  it('连接中断：连接中徽章 + lastError 原文 + 重试提示 + 列表降级占位行；忘记按钮保留', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_CONNECTING);
    render(<HubSettingsPanel />);

    expect(await screen.findByText('连接中')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接 hub');
    expect(screen.getByText('自动重连中，恢复后将自动回到已连接')).toBeInTheDocument();
    expect(screen.getByText('连接中断——在线节点列表暂停更新')).toBeInTheDocument();
    // 断连时恰是最需要忘记的时刻——危险区保留
    expect(screen.getByRole('button', { name: /断开并忘记/ })).toBeInTheDocument();
  });

  it('快照失败：loadError 错误行 + 重试按钮出现，无「加载中」死滞', async () => {
    api.hub.getStatus.mockRejectedValue(new Error('Error invoking remote method: boom'));
    render(<HubSettingsPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('状态读取失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
  });

  it('快照失败后点重试：getStatus 转 resolve → 面板恢复正常渲染，错误行消退', async () => {
    api.hub.getStatus
      .mockRejectedValueOnce(new Error('Error invoking remote method: boom'))
      .mockResolvedValue(ENROLLED_ONLINE);
    render(<HubSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByText('已连接')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
  });

  it('委派子节点区段：开关即时保存；并发上限失焦保存且回显主进程归一化值', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    api.hub.setDelegationSettings.mockResolvedValueOnce({ acceptTasks: false, maxConcurrent: 2 })
      .mockResolvedValueOnce({ acceptTasks: false, maxConcurrent: 8 });
    render(<HubSettingsPanel />);

    expect(await screen.findByText('任务委派（子节点）')).toBeInTheDocument();
    // 开关：点击即保存（Switch role=switch）
    fireEvent.click(screen.getByRole('switch', { name: '接受任务委派' }));
    await waitFor(() =>
      expect(api.hub.setDelegationSettings).toHaveBeenCalledWith({ acceptTasks: false, maxConcurrent: 2 }),
    );
    expect((screen.getByRole('switch', { name: '接受任务委派' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');

    // 并发上限：失焦保存；主进程归一化（99 → 8）后回显
    const input = screen.getByLabelText('并发上限') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api.hub.setDelegationSettings).toHaveBeenLastCalledWith({ acceptTasks: false, maxConcurrent: 99 }),
    );
    await waitFor(() => expect((screen.getByLabelText('并发上限') as HTMLInputElement).value).toBe('8'));
  });
});
