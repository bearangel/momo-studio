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
//   - P2.1 Task 4 分页：hasMore 驱动尾部「加载更多」；点击 → page+1 追加条目（按 id
//     去重）；加载中按钮禁用 + 文案「加载中…」；query 输入 300ms 防抖后以 page=1
//     重新拉取并替换（不追加）——服务端搜索语义（smithery q 参数 / builtin 本地过滤）
//
// Mock 方式遵循 ResourceLibraryView.test.tsx 既有形态（组件渲染测试变体）：不 vi.mock
// ipc/client 模块，而是在真实 jsdom window 上装 window.api 属性——ipc.client 是真实
// Proxy，组件经真通道消费；整窗替换（store 测试的 window = {...} 写法）会抹掉
// window.HTMLIFrameElement 等 DOM 构造器导致 react-dom 崩溃（momo-test-rules：
// mock 收窄到 IPC 边界 + 仿真真实运行时语义，且免疫 vi.mock 提升时序问题）。
// 防抖用例走真实定时器（jsdom 默认）——fireEvent 后同步断言窗口内零调用锁防抖，
// waitFor 轮询等 300ms 后的下发调用，不做 fake timers（与 waitFor/React 批处理互嵌易flaky）。
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

/** 与主进程 registryProviders 返回同构的元信息（可按用例覆写 degraded） */
function mkProviders(overrides?: Partial<RegistryProviderMeta>[]): RegistryProviderMeta[] {
  const base: RegistryProviderMeta[] = [
    { key: 'builtin', label: '内置市场', region: 'local', types: ['agent', 'mcp', 'skill'], degraded: false },
    { key: 'smithery', label: 'Smithery', region: 'intl', types: ['mcp'], degraded: false },
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
    // registryList 返回三字段契约（P2.1 Task 4 起 hasMore 必有——与主进程 HubListResult 对齐）
    registryListMock.mockResolvedValue({ entries: [] as RegistryListEntry[], degraded: false, hasMore: false });
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    localStorage.clear();
    // 组件订阅 store.items 派生已安装态 + 读 registryProviderKey——逐测复位防跨用例泄漏
    useResourceStore.setState({
      items: [], loading: false, error: null, installNotice: null,
      registryProviderKey: 'builtin',
    });
  });

  it('挂载即经 registryList("builtin", type) 拉取并渲染行与 provider 选择器', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('builtin', 'mcp', undefined, 1);
    expect(registryProvidersMock).toHaveBeenCalledTimes(1);
    expect(providerSelect()).toBeTruthy();
    expect(providerSelect().value).toBe('builtin');
  });

  it('provider 选择器在 mcp 页渲染两个来源 option', async () => {
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: '内置市场' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Smithery' })).toBeTruthy();
  });

  it('type 过滤：agent 页仅渲染内置市场（hub 仅支持 mcp）', async () => {
    render(<RegistryBrowse type="agent" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: '内置市场' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Smithery' })).toBeNull();
  });

  it('切到 Smithery → registryList("smithery", type) 取数渲染 hub 条目 + 记忆持久化', async () => {
    registryListMock.mockResolvedValueOnce({ entries: [], degraded: false, hasMore: false });
    registryListMock.mockResolvedValueOnce({ entries: [mkSmitheryEntry()], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Smithery' })).toBeTruthy());
    fireEvent.change(providerSelect(), { target: { value: 'smithery' } });
    await waitFor(() => expect(screen.getByText('天气服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('smithery', 'mcp', undefined, 1);
    // 切换即记忆（localStorage 契约 key）
    expect(localStorage.getItem('momo.resourceLibrary.providerKey')).toBe('smithery');
  });

  it('记忆恢复：store 已记忆 smithery → 挂载直接以 smithery 取数', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValue({ entries: [mkSmitheryEntry()], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('天气服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('smithery', 'mcp', undefined, 1);
    expect(providerSelect().value).toBe('smithery');
  });

  it('记忆源不支持当前 type → 回退 builtin 取数（不发生错配 IPC）', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    render(<RegistryBrowse type="agent" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledWith('builtin', 'agent', undefined, 1);
    // 全程只以 builtin 取数——记忆的 smithery 在 agent 页被 type 过滤挡下
    expect(registryListMock.mock.calls.every(([key]) => key === 'builtin')).toBe(true);
    expect(providerSelect().value).toBe('builtin');
  });

  it('meta.degraded 的 option 置灰并标注不可达（初值参考，Task 4 审查裁定）', async () => {
    registryProvidersMock.mockResolvedValue(
      mkProviders([{ key: 'smithery', degraded: true }]),
    );
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    const smithery = await waitFor(() =>
      screen.getByRole('option', { name: /Smithery（当前网络不可达）/ }),
    );
    expect(smithery.hasAttribute('disabled')).toBe(true);
    // builtin 恒可用（本地 catalog 零网络）
    const builtin = screen.getByRole('option', { name: '内置市场' });
    expect(builtin.hasAttribute('disabled')).toBe(false);
  });

  it('degraded 结果驱动空态：不可达文案 + 重试；重试成功恢复条目并解灰 option', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValueOnce({ entries: [], degraded: true, hasMore: false });
    registryListMock.mockResolvedValueOnce({ entries: [mkSmitheryEntry()], degraded: false, hasMore: false });
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
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    const onInstall = vi.fn();
    render(<RegistryBrowse type="mcp" onInstall={onInstall} />);
    await waitFor(() => screen.getByText('X服务'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('marketplace-mcp-x');
  });

  it('store 出现该条目后行翻转「已安装」（终审 Important-1 回归锁）', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    // 安装成功 → store.items 刷新出该条目 → 行实时翻转（非挂载时快照）
    useResourceStore.setState({ items: [mkItem({ id: 'marketplace-mcp-x', installed: true })] });
    await waitFor(() => expect(screen.getByText('已安装')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
  });

  it('点击行挂载详情面板，关闭按钮卸载（spec §4.4，终审 Important-2 回归锁）', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => screen.getByText('X服务'));
    expect(screen.queryByLabelText('关闭详情')).toBeNull();
    fireEvent.click(screen.getByText('X服务'));
    await waitFor(() => expect(screen.getByLabelText('关闭详情')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('关闭详情'));
    await waitFor(() => expect(screen.queryByLabelText('关闭详情')).toBeNull());
  });

  // ---- P2.1 Task 4：分页（加载更多 + 服务端搜索防抖）----

  /** 生成 n 条互异 smithery 条目（id/name 带前缀区分页；name 须注入 item——行渲染取 item.name） */
  function mkPage(prefix: string, n: number): RegistryListEntry[] {
    return Array.from({ length: n }, (_, i) => {
      const id = `smithery-mcp-${prefix}-${i}`;
      const name = `${prefix}${i}`;
      return mkEntry({
        id,
        name,
        item: mkItem({ id, source: 'smithery', slug: `${prefix}/${i}`, name }),
      });
    });
  }

  it('hasMore=true 渲染「加载更多」；点击 → page=2 调用 + 条目累加（30+30）；hasMore=false 后按钮消失', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValueOnce({ entries: mkPage('首页', 30), degraded: false, hasMore: true });
    registryListMock.mockResolvedValueOnce({ entries: mkPage('次页', 30), degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('首页0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(screen.getByText('次页0')).toBeTruthy());
    expect(registryListMock).toHaveBeenLastCalledWith('smithery', 'mcp', undefined, 2);
    // 累加不替换：两页首尾条目同时在列
    expect(screen.getByText('首页29')).toBeTruthy();
    expect(screen.getByText('次页29')).toBeTruthy();
    // 末页 hasMore=false → 按钮不再渲染
    await waitFor(() => expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull());
  });

  it('hasMore=false（builtin / 末页）不渲染「加载更多」按钮', async () => {
    registryListMock.mockResolvedValue({ entries: [mkEntry({})], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  });

  it('追加页按 id 去重：跨页重复条目只渲染一次', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    const first = mkEntry({
      id: 'smithery-mcp-dup', name: '重复条目',
      item: mkItem({ id: 'smithery-mcp-dup', source: 'smithery', slug: 'dup', name: '重复条目' }),
    });
    const second = mkEntry({
      id: 'smithery-mcp-new', name: '新条目',
      item: mkItem({ id: 'smithery-mcp-new', source: 'smithery', slug: 'new', name: '新条目' }),
    });
    registryListMock.mockResolvedValueOnce({ entries: [first], degraded: false, hasMore: true });
    registryListMock.mockResolvedValueOnce({ entries: [first, second], degraded: false, hasMore: false });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('重复条目')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(screen.getByText('新条目')).toBeTruthy());
    expect(screen.getAllByText('重复条目')).toHaveLength(1);
  });

  it('分页加载中按钮禁用并显示「加载中…」，完成后恢复可再次点击', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    registryListMock.mockResolvedValueOnce({ entries: mkPage('首页', 2), degraded: false, hasMore: true });
    let resolvePage2: (v: { entries: RegistryListEntry[]; degraded: boolean; hasMore: boolean }) => void = () => {};
    registryListMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage2 = resolve; }),
    );
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('首页0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    // 加载中：按钮禁用 + 文案切换，列表保持已加载条目
    const loadingBtn = await waitFor(() => screen.getByRole('button', { name: '加载中…' }));
    expect(loadingBtn.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('首页1')).toBeTruthy();
    resolvePage2({ entries: mkPage('次页', 2), degraded: false, hasMore: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy());
    expect(screen.getByText('次页1')).toBeTruthy();
  });

  it('query 输入 300ms 防抖：窗口内零新调用；停顿后以新词 + page=1 重新拉取并替换列表', async () => {
    useResourceStore.setState({ registryProviderKey: 'smithery' });
    const p1 = mkEntry({
      id: 'smithery-mcp-a', name: '服务甲',
      item: mkItem({ id: 'smithery-mcp-a', source: 'smithery', slug: 'a', name: '服务甲' }),
    });
    const p2 = mkEntry({
      id: 'smithery-mcp-b', name: '服务乙',
      item: mkItem({ id: 'smithery-mcp-b', source: 'smithery', slug: 'b', name: '服务乙' }),
    });
    const searched = mkEntry({
      id: 'smithery-mcp-hit', name: '命中天气',
      item: mkItem({ id: 'smithery-mcp-hit', source: 'smithery', slug: 'hit', name: '命中天气' }),
    });
    registryListMock.mockResolvedValueOnce({ entries: [p1], degraded: false, hasMore: true });
    registryListMock.mockResolvedValueOnce({ entries: [p2], degraded: false, hasMore: true });
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('服务甲')).toBeTruthy());
    // 先翻到第 2 页，让后续搜索触发 page 重置路径
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(screen.getByText('服务乙')).toBeTruthy());
    expect(registryListMock).toHaveBeenCalledTimes(2);
    // 输入搜索词——防抖窗口内（<300ms）不下发任何新调用
    fireEvent.change(screen.getByPlaceholderText('搜索名称 / 描述 / slug…'), {
      target: { value: '天气' },
    });
    expect(registryListMock).toHaveBeenCalledTimes(2);
    // 停顿后：以新词 + page=1 重新拉取；结果替换（不追加）已加载两页
    registryListMock.mockResolvedValueOnce({ entries: [searched], degraded: false, hasMore: false });
    await waitFor(
      () => expect(registryListMock).toHaveBeenLastCalledWith('smithery', 'mcp', '天气', 1),
      { timeout: 2000 },
    );
    await waitFor(() => expect(screen.getByText('命中天气')).toBeTruthy());
    expect(screen.queryByText('服务甲')).toBeNull();
    expect(screen.queryByText('服务乙')).toBeNull();
  });
});
