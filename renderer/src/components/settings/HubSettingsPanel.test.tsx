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
  useHubStore.setState({ status: null, nodes: [] });
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
});
