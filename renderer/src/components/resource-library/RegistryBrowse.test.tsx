// renderer/src/components/resource-library/RegistryBrowse.test.tsx
//
// RegistryBrowse 行为（spec §4.4 网络获取模式）：
//   - 挂载即经 marketplaceCatalogProvider 拉取该类型 marketplace 条目并渲染行 + 来源标注
//   - 未安装行点「安装」→ onInstall(条目 id)（透传 Provider 给的 resource id，禁止重生成）
//   - store.items 出现条目 id → 行翻转「已安装」（实时派生，非挂载快照）
//   - 点行 → 右栏挂载 ResourceDetail；关闭按钮卸载（spec §4.4 行点击详情）
//   - Provider 抛错 → 错误态 + 重试按钮（attempt 递增重挂 effect）
//   - 空目录 → 空态文案
//
// Mock 方式遵循 ResourceLibraryView.test.tsx 既有形态（组件渲染测试变体）：不 vi.mock
// ipc/client 模块，而是在真实 jsdom window 上装 window.api 属性——ipc.client 是真实
// Proxy，Provider 走真通道；整窗替换（store 测试的 window = {...} 写法）会抹掉
// window.HTMLIFrameElement 等 DOM 构造器导致 react-dom 崩溃（momo-test-rules：
// mock 收窄到 IPC 边界 + 仿真真实运行时语义，且免疫 vi.mock 提升时序问题）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegistryBrowse } from './RegistryBrowse';
import { useResourceStore } from '../../stores/resource.store';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn();

const mockApi = {
  resource: {
    list: listMock,
  },
};

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'marketplace-mcp-x', type: 'mcp', source: 'marketplace', slug: 'x', name: 'X服务',
    description: 'd', installed: false, installable: true, removable: false,
    marketplace: { author: 'a', readme: '', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: ['t'], category: 'c' },
    ...over,
  } as ResourceItem;
}

describe('RegistryBrowse', () => {
  beforeEach(() => {
    listMock.mockReset();
    listMock.mockResolvedValue([] as ResourceItem[]);
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // 组件订阅 store.items 派生已安装态——逐测复位防跨用例泄漏
    useResourceStore.setState({ items: [], loading: false, error: null, installNotice: null });
  });

  it('挂载即拉取该类型 marketplace 条目并渲染行与来源标注', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(listMock).toHaveBeenCalledWith({ type: 'mcp', source: 'marketplace' });
    expect(screen.getByText('来源：内置市场')).toBeTruthy();
  });

  it('未安装行点安装触发 onInstall(id)', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    const onInstall = vi.fn();
    render(<RegistryBrowse type="mcp" onInstall={onInstall} />);
    await waitFor(() => screen.getByText('X服务'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('marketplace-mcp-x');
  });

  it('Provider 抛错渲染错误态与重试按钮', async () => {
    listMock.mockRejectedValue(new Error('catalog 加载失败'));
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/加载失败：catalog 加载失败/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('空目录渲染空态', async () => {
    listMock.mockResolvedValue([]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('目录中没有匹配项')).toBeTruthy());
  });

  it('store 出现该条目后行翻转「已安装」（终审 Important-1 回归锁）', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    // 安装成功 → store.items 刷新出该条目 → 行实时翻转（非挂载时快照）
    useResourceStore.setState({ items: [mkItem({ id: 'marketplace-mcp-x', installed: true })] });
    await waitFor(() => expect(screen.getByText('已安装')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
  });

  it('点击行挂载详情面板，关闭按钮卸载（spec §4.4，终审 Important-2 回归锁）', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.queryByLabelText('关闭详情')).toBeNull();
    fireEvent.click(screen.getByText('X服务'));
    await waitFor(() => expect(screen.getByLabelText('关闭详情')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('关闭详情'));
    await waitFor(() => expect(screen.queryByLabelText('关闭详情')).toBeNull());
  });
});
