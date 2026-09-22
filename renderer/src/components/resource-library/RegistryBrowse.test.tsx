// renderer/src/components/resource-library/RegistryBrowse.test.tsx
//
// RegistryBrowse 行为（spec §4.4 网络获取模式 + P2 双轨 hub Task 6）：
//   - 挂载即经 ipc.resource.registryList(providerKey, type) 拉取条目并渲染行 + provider 选择器
//     （默认 builtin；v1 的 marketplaceCatalogProvider 直连已退役）
//   - provider 选择器：mount 拉一次 registryProviders 并按当前 type 过滤（hub 仅支持 mcp）
//   - 切换 provider → 经新 providerKey 重新取数 + localStorage 记忆（store 契约）
//   - 置灰语义（Task 4 审查裁定）：option disabled 由最新已知 degraded 驱动——
//     未探测取 meta.degraded 初值；registryList 结果双向更新（恢复即解灰）
//   - degraded 且空条目 → 「该来源当前网络不可达…」空态 + 重试按钮（attempt 递增）
//   - 未安装行点「安装」→ onInstall(条目 id)（透传 Provider 给的 resource id，禁止重生成）
//   - store.items 出现条目 id → 行翻转「已安装」（实时派生，非挂载快照）
//   - 点行 → 右栏挂载 ResourceDetail；关闭按钮卸载
//   - registryList 抛错 → 错误态 + 重试按钮；空目录（非降级）→ 空态文案
//
// Mock 方式遵循 ResourceLibraryView.test.tsx 既有形态（组件渲染测试变体）：不 vi.mock
// ipc/client 模块，而是在真实 jsdom window 上装 window.api 属性——ipc.client 是真实
// Proxy，组件经真通道消费；整窗替换（store 测试的 window = {...} 写法）会抹掉
// window.HTMLIFrameElement 等 DOM 构造器导致 react-dom 崩溃（momo-test-rules：
// mock 收窄到 IPC 边界 + 仿真真实运行时语义，且免疫 vi.mock 提升时序问题）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegistryBrowse } from './RegistryBrowse';
import { useResourceStore } from '../../stores/resource.store';
import type {
  ResourceItem,
  RegistryProviderMeta,
  RegistryListEntry,
} from '../../ipc/types';

const listMock = vi.fn();
const registryProvidersMock = vi.fn();
const registryListMock = vi.fn();

const mockApi = {
  resource: {
    list: listMock,
    registryProviders: registryProvidersMock,
    registryList: registryListMock,
  },
};

/** 与主进程 registryProviders 返回同构的三源元信息（可按用例覆写 degraded） */
function mkProviders(overrides?: Partial<RegistryProviderMeta>[]): RegistryProviderMeta[] {
  const base: RegistryProviderMeta[] = [
    { key: 'builtin', label: '内置市场', region: 'local', types: ['agent', 'mcp', 'skill'], degraded: false },
    { key: 'smithery', label: 'Smithery', region: 'intl', types: ['mcp'], degraded: false },
    { key: 'modelscope', label: '魔搭社区', region: 'cn', types: ['mcp'], degraded: false },
  ];
  if (!overrides) return base;
  return base.map((p) => ({ ...p, ...overrides.find((o) => o.key === p.key) }));
}

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'marketplace-mcp-x', type: 'mcp', source: 'marketplace', slug: 'x', name: 'X服务',
    description: 'd', installed: false, installable: true, removable: false,
    marketplace: { author: 'a', readme: '', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: ['t'], category: 'c' },
    ...over,
  } as ResourceItem;
}

/** registryList 返回条目（与主进程 HubEntry/RegistryListEntry 同构） */
function mkEntry(over: Partial<RegistryListEntry>): RegistryListEntry {
  return {
    id: 'marketplace-mcp-x', type: 'mcp', name: 'X服务', description: 'd',
    tags: ['t'], item: mkItem({}), ...over,
  };
}

/** Smithery hub 条目（qualifiedName 作 slug，hosted 条目不可安装——Task 0 实测形状） */
function mkSmitheryEntry(): RegistryListEntry {
  const item = mkItem({
    id: 'smithery-mcp-@owner/weather', source: 'smithery', slug: '@owner/weather',
    name: '天气服务', installable: false,
  });
  return { id: item.id, type: 'mcp', name: item.name, description: 'd', tags: [], item };
}

function providerSelect(): HTMLSelectElement {
  return screen.getByLabelText('registry provider') as HTMLSelectElement;
}

describe('RegistryBrowse', () => {
  beforeEach(() => {
    listMock.mockReset();
    listMock.mockResolvedValue([] as ResourceItem[]);
    registryProvidersMock.mockReset();
    registryProvidersMock.mockResolvedValue(mkProviders());
    registryListMock.mockReset();
    registryListMock.mockResolvedValue({ entries: [] as RegistryListEntry[], degraded: false });
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    localStorage.clear();
    // 组件订阅 store.items 派生已安装态 + 读 registryProviderKey——逐测复位防跨用例泄漏
    useResourceStore.setState({
      items: [], loading: false, error: null, installNotice: null,
      registryProviderKey: 'builtin',
    });
  });

  it('挂载即经 registryList("builtin", type) 拉取并渲染行与 provider 选择器', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('builtin', 'mcp');
    expect(registryProvidersMock).toHaveBeenCalledTimes(1);
    expect(providerSelect()).toBeTruthy();
    expect(providerSelect().value).toBe('builtin');
  });

  it('provider 选择器在 mcp 页渲染三个来源 option', async () => {
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: '内置市场' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Smithery' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '魔搭社区' })).toBeTruthy();
  });

  it('type 过滤：agent 页仅渲染内置市场（hub 仅支持 mcp）', async () => {
    render(<RegistryBrowse type="agent" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: '内置市场' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Smithery' })).toBeNull();
    expect(screen.queryByRole('option', { name: '魔搭社区' })).toBeNull();
  });

  it('切到 Smithery → registryList("smithery", type) 取数渲染 hub 条目 + 记忆持久化', async () => {
    registryListMock.mockResolvedValueOnce({ entries: [], degraded: false });
    registryListMock.mockResolvedValueOnce({ entries: [mkSmitheryEntry()], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Smithery' })).toBeTruthy());
    fireEvent.change(providerSelect(), { target: { value: 'smithery' } });
    await waitFor(() => expect(screen.getByText('天气服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('smithery', 'mcp');
    // 切换即记忆（localStorage 契约 key）
    expect(localStorage.getItem('momo.resourceLibrary.providerKey')).toBe('smithery');
  });

  it('记忆恢复：store 已记忆 smithery → 挂载直接以 smithery 取数', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValue({ entries: [mkSmitheryEntry()], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('天气服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('smithery', 'mcp');
    expect(providerSelect().value).toBe('smithery');
  });

  it('记忆源不支持当前 type → 回退 builtin 取数（不发生错配 IPC）', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false });
    render(<RegistryBrowse type="agent" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('builtin', 'agent');
    // 全程只以 builtin 取数——记忆的 smithery 在 agent 页被 type 过滤挡下
    expect(registryListMock.mock.calls.every(([key]) => key === 'builtin')).toBe(true);
    expect(providerSelect().value).toBe('builtin');
  });

  it('meta.degraded 的 option 置灰并标注不可达（初值参考，Task 4 审查裁定）', async () => {
    registryProvidersMock.mockResolvedValue(
      mkProviders([{ key: 'smithery', degraded: true }, { key: 'modelscope', degraded: true }]),
    );
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    const smithery = await waitFor(() =>
      screen.getByRole('option', { name: /Smithery（当前网络不可达）/ }),
    );
    expect(smithery.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('option', { name: /魔搭社区（当前网络不可达）/ }).hasAttribute('disabled')).toBe(true);
    // builtin 恒可用（本地 catalog 零网络）
    const builtin = screen.getByRole('option', { name: '内置市场' });
    expect(builtin.hasAttribute('disabled')).toBe(false);
  });

  it('degraded 结果驱动空态：不可达文案 + 重试；重试成功恢复条目并解灰 option', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValueOnce({ entries: [], degraded: true });
    registryListMock.mockResolvedValueOnce({ entries: [mkSmitheryEntry()], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    // 结果态置灰：registryList 的 degraded 让 option 拿到不可达标注（meta 初值本是 false）
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Smithery（当前网络不可达）/ })).toBeTruthy(),
    );
    // degraded 且空条目 → 不可达空态文案（Task 4 审查裁定措辞）
    await waitFor(() =>
      expect(screen.getByText('该来源当前网络不可达，可稍后重试或切换来源')).toBeTruthy(),
    );
    // 重试按钮保留（attempt 递增重挂 effect）
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('天气服务')).toBeTruthy());
    // 恢复即解灰——「短暂 degraded 不永久禁用」回归锁
    await waitFor(() => expect(screen.getByRole('option', { name: 'Smithery' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Smithery' }).hasAttribute('disabled')).toBe(false);
  });

  it('registryList 抛错渲染错误态与重试按钮', async () => {
    registryListMock.mockRejectedValue(new Error('catalog 加载失败'));
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/加载失败：catalog 加载失败/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('空目录（非降级）渲染空态', async () => {
    registryListMock.mockResolvedValue({ entries: [], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('目录中没有匹配项')).toBeTruthy());
  });

  it('未安装行点安装触发 onInstall(id)', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false });
    const onInstall = vi.fn();
    render(<RegistryBrowse type="mcp" onInstall={onInstall} />);
    await waitFor(() => screen.getByText('X服务'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('marketplace-mcp-x');
  });

  it('store 出现该条目后行翻转「已安装」（终审 Important-1 回归锁）', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    // 安装成功 → store.items 刷新出该条目 → 行实时翻转（非挂载时快照）
    useResourceStore.setState({ items: [mkItem({ id: 'marketplace-mcp-x', installed: true })] });
    await waitFor(() => expect(screen.getByText('已安装')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
  });

  it('点击行挂载详情面板，关闭按钮卸载（spec §4.4，终审 Important-2 回归锁）', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.queryByLabelText('关闭详情')).toBeNull();
    fireEvent.click(screen.getByText('X服务'));
    await waitFor(() => expect(screen.getByLabelText('关闭详情')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('关闭详情'));
    await waitFor(() => expect(screen.queryByLabelText('关闭详情')).toBeNull());
  });
});
