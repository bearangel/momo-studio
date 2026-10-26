// renderer/src/components/workgroup/WorkgroupView.test.tsx
//
// 工作组视图骨架测试（momo-hub M2.1 Task 2）：
// - D2 治愈断言：无工作空间上下文也渲染未接入空态（工作组是节点级能力）
// - 未接入（!configured）：空态文案 + 「接入 hub」打开就地表单；提交走 ipc mock
//   （window.api.hub.enroll，trim 后入参）；成功翻「监控台建设中」占位
// - enroll 失败：错误原文展示（ipc 代理剥包装前缀纪律）
// - 已接入（configured）：直接监控台占位，无接入表单
// - 「什么是工作组？」非死入口：点击切换帮助文案
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkgroupView } from './WorkgroupView';
import { useHubStore } from '../../stores/hub.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubStatus } from '../../ipc/types';

const api = {
  hub: {
    getStatus: vi.fn(),
    configure: vi.fn(),
    enroll: vi.fn(),
    forget: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    onNodePresence: vi.fn(() => () => undefined),
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

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  useHubStore.setState({ status: null, nodes: [], loadError: null });
  // D2 断言前提：不准备任何工作空间（getActive() 为空）
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, loading: false, error: null });
});

describe('WorkgroupView', () => {
  it('未接入且无工作空间：渲染空态（D2 治愈——不依赖工作空间存在）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    expect(await screen.findByText('尚未接入工作组网络')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接入 hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '什么是工作组？' })).toBeInTheDocument();
  });

  it('点击「接入 hub」打开就地表单（三字段 + 提交按钮）', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));
    expect(screen.getByLabelText('hub 地址')).toBeInTheDocument();
    expect(screen.getByLabelText('节点名')).toBeInTheDocument();
    expect(screen.getByLabelText('加入凭证')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接入' })).toBeInTheDocument();
  });

  it('提交走 ipc mock（trim 后入参），成功后翻「监控台建设中」占位', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    api.hub.enroll.mockResolvedValue(ENROLLED_ONLINE);
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));

    fireEvent.change(screen.getByLabelText('hub 地址'), {
      target: { value: ' https://hub.example.com:8787 ' },
    });
    fireEvent.change(screen.getByLabelText('节点名'), { target: { value: ' 办公室 MacBook ' } });
    fireEvent.change(screen.getByLabelText('加入凭证'), { target: { value: ' join-7f3k-q2x9 ' } });
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    await waitFor(() => {
      expect(api.hub.enroll).toHaveBeenCalledWith({
        hubUrl: 'https://hub.example.com:8787',
        enrollmentToken: 'join-7f3k-q2x9',
        nodeName: '办公室 MacBook',
      });
    });
    expect(await screen.findByText('监控台建设中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接入 hub' })).not.toBeInTheDocument();
  });

  it('enroll 失败：错误原文展示（role=alert），不翻占位', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    api.hub.enroll.mockRejectedValue(new Error('加入凭证无效'));
    render(<WorkgroupView />);
    fireEvent.click(await screen.findByRole('button', { name: '接入 hub' }));
    fireEvent.change(screen.getByLabelText('hub 地址'), {
      target: { value: 'https://hub.example.com:8787' },
    });
    fireEvent.change(screen.getByLabelText('节点名'), { target: { value: '办公室 MacBook' } });
    fireEvent.change(screen.getByLabelText('加入凭证'), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: '接入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('加入凭证无效');
    expect(screen.queryByText('监控台建设中')).not.toBeInTheDocument();
  });

  it('已接入（configured）：直接渲染监控台占位，无接入表单', async () => {
    api.hub.getStatus.mockResolvedValue(ENROLLED_ONLINE);
    render(<WorkgroupView />);
    expect(await screen.findByText('监控台建设中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接入 hub' })).not.toBeInTheDocument();
  });

  it('「什么是工作组？」非死入口：点击切换帮助文案', async () => {
    api.hub.getStatus.mockResolvedValue(UNENROLLED);
    render(<WorkgroupView />);
    await screen.findByText('尚未接入工作组网络');
    expect(screen.queryByText(/跨设备节点编队/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '什么是工作组？' }));
    expect(screen.getByText(/跨设备节点编队/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '什么是工作组？' }));
    expect(screen.queryByText(/跨设备节点编队/)).not.toBeInTheDocument();
  });
});
