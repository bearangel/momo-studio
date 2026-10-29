// renderer/src/components/resource-library/TypePageShell.test.tsx
//
// TypePageShell 行为（spec §2.1 页面骨架；P2.3 Task 1 起恒「已安装」单态）：
//   - 工具栏：搜索框 + 来源 chips + AddMenu（模式 Segmented 已随网络获取模式移除）
//   - 已安装空列表 → EmptyState 文案（按类型命名）
//   - 行点击选中 → 右侧详情面板挂载（「关闭详情」按钮出现）
//   - installNotice / store 错误行恒可见（原「双模式渲染」回归锁的单态化延续）
//   - 全页唯一搜索框在工具栏内（原「消除双搜索框」防回归的单态化延续）
//
// Mock 方式遵循 ResourceLibraryView.test.tsx 既有形态（组件渲染测试变体）：不 vi.mock
// ipc/client 模块，而是在真实 jsdom window 上装 window.api 属性——ipc.client 是真实
// Proxy；整窗替换（store 测试的 window = {...} 写法）会抹掉 DOM 构造器导致 react-dom
// 崩溃（momo-test-rules：mock 收窄到 IPC 边界）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { TypePageShell, buildImpactMessage } from './TypePageShell';
import { useResourceStore } from '../../stores/resource.store';
import { useHubStore } from '../../stores/hub.store';
import { useUiStore } from '../../stores/ui.store';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn();
// MCP 页挂载 DanglingRefsCard → mount 拉一次悬空引用
const danglingMcpRefsMock = vi.fn();
// P2.5 Task 4：删除确认流的 ipc delete 桩（store.deleteResource → ipc.resource.delete）
const deleteMock = vi.fn();
// D9：agent 页挂载时经 store.loadCatalogStatus 拉目录健康状态
const getCatalogStatusMock = vi.fn();

const pluginGetDetailMock = vi.fn();

const mockApi = {
  resource: {
    list: listMock,
    danglingMcpRefs: danglingMcpRefsMock,
    delete: deleteMock,
    getCatalogStatus: getCatalogStatusMock,
  },
  plugin: {
    getDetail: pluginGetDetailMock,
  },
};

/** 共享 fixture：custom / builtin 各一（组① 筛选与组③ 计数 / 拖宽用例共用） */
const itemA: ResourceItem = {
  id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
  description: '描述甲', installed: true, installable: false, removable: true,
};
const builtinItem: ResourceItem = {
  id: 'builtin-mcp-fs', type: 'mcp', source: 'builtin', slug: 'fs', name: '乙',
  description: '描述乙', installed: true, installable: false, removable: false,
};

beforeEach(() => {
  pluginGetDetailMock.mockReset();
  pluginGetDetailMock.mockResolvedValue({
    pluginId: '', mcps: [], tools: [], skills: [], agents: [], panels: [], service: false, config: false,
  });
  listMock.mockReset();
  listMock.mockResolvedValue([] as ResourceItem[]);
  danglingMcpRefsMock.mockReset();
  danglingMcpRefsMock.mockResolvedValue([]);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  getCatalogStatusMock.mockReset();
  getCatalogStatusMock.mockResolvedValue({ degraded: false });
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  localStorage.clear();

  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    catalogDegraded: false, hubDegraded: false, hubUpdates: {},
    typeFilter: 'mcp', sourceFilter: 'all', query: '',
    activeType: 'mcp',
  });
  useHubStore.setState({ status: null, nodes: [], loadError: null });
  useUiStore.setState({ activeView: 'marketplace' });
});

describe('TypePageShell（已安装单态，P2.3 Task 1）', () => {
  it('工具栏单行：搜索框 + 来源下拉（带计数）+ AddMenu（断言迁移——library-store-split：外部市场入口退场，远端获取迁 AddMenu 远端组）', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    // 单态断言：模式切换 Segmented（已安装|网络获取）整体不渲染
    expect(screen.queryByRole('radio', { name: '已安装' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '网络获取' })).toBeNull();
    expect(screen.queryByText('网络获取')).toBeNull();
    expect(screen.getByPlaceholderText('搜索名称 / 描述 / slug…')).toBeTruthy();
    // 来源筛选 = 原生 select（键盘可达）；本地三档（预览 §A 定值：全部/系统预置/自定义）
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).getByRole('option', { name: /全部/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /系统预置/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /自定义/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加服务器' })).toBeTruthy();
    // 外部市场弹层入口已随组件退场
    expect(screen.queryByRole('button', { name: '外部市场' })).toBeNull();
  });

  it('已安装空列表渲染 EmptyState 文案', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('还没有 MCP 服务器')).toBeTruthy();
  });

  it('行点击选中后挂载详情面板', () => {
    useResourceStore.setState({
      items: [{
        id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
        description: '', installed: true, installable: false, removable: true,
      }],
    });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });

  it('来源下拉计数：全部=N，各来源分组计数（断言迁移——library-store-split：标签改为 全部/系统预置/自定义）', () => {
    useResourceStore.setState({
      items: [
        { ...builtinItem, id: 'builtin-agent-1' },
        { ...builtinItem, id: 'builtin-agent-2' },
        itemA,
      ],
    });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).getByRole('option', { name: '全部 3' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: '系统预置 2' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: '自定义 1' })).toBeTruthy();
  });

  it('来源下拉切换 = 前端过滤 + 立即重拉（P2-5 / M2 D7——切换即见远程增量）', async () => {
    listMock.mockClear();
    useResourceStore.setState({ items: [itemA, builtinItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('来源筛选'), { target: { value: 'builtin' } });
    expect(useResourceStore.getState().sourceFilter).toBe('builtin');
    // P2-5：切换即重拉；IPC filter 仍只下发 type 维度（来源过滤在前端做）
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledWith({ type: 'mcp' }));
    // 列表收窄到 builtin 项
    expect(document.querySelectorAll('[data-testid^="resource-card-"]')).toHaveLength(1);
  });

  it('加载失败显示重试按钮，点击重新拉取（组③）', async () => {
    listMock.mockClear();
    useResourceStore.setState({ error: 'boom' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('加载失败：boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
  });

  it('安装成功横幅可见（单态——无模式门控）', () => {
    useResourceStore.setState({ installNotice: '已导入至「自定义」' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByTestId('install-notice')).toBeTruthy();
    expect(screen.getByText('已导入至「自定义」')).toBeTruthy();
  });

  it('store 错误行可见（导入失败反馈，单态——无模式门控）', () => {
    useResourceStore.setState({ error: '导入失败：boom' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    // A3：store 已带业务前缀 → 原样单前缀（不再拼「加载失败：」）
    expect(screen.getByText('导入失败：boom')).toBeTruthy();
  });

  // A3：已知业务前缀一律单前缀（前缀集合与 lib/error-prefix.ts 同步；契约测试在 electron 侧）
  it.each(['导入失败：', '启停失败：', '停用失败：', '重载失败：', '卸载失败：', '下载资源包失败：', '下载失败，'])(
    'store 错误已带「%s」→ 原样展示，不叠加「加载失败：」',
    (prefix) => {
      useResourceStore.setState({ error: `${prefix}boom` });
      render(
        <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
      );
      expect(screen.getByText(`${prefix}boom`)).toBeTruthy();
      expect(screen.queryByText(`加载失败：${prefix}boom`)).toBeNull();
    },
  );

  it('全页唯一搜索框且在工具栏内（原双搜索框防回归的单态延续）', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getAllByPlaceholderText('搜索名称 / 描述 / slug…')).toHaveLength(1);
    const toolbar = screen.getByText('MCP 服务器').parentElement;
    expect(toolbar).not.toBeNull();
    expect(within(toolbar as HTMLElement).getByPlaceholderText('搜索名称 / 描述 / slug…')).toBeTruthy();
  });
});

// ── P2.5 Task 3：onEditMcpEntry 透传（详情面板出现编辑按钮）──────────────
describe('TypePageShell - onEditMcpEntry 透传（P2.5 Task 3）', () => {
  it('选中 custom mcp 行 → 详情面板出现「编辑」按钮，点击触发透传回调', () => {
    const onEditMcpEntry = vi.fn();
    const item: ResourceItem = {
      id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
      description: '', installed: true, installable: false, removable: true,
      custom: { installedAt: '2026-09-24T00:00:00.000Z', transport: 'stdio' },
    };
    useResourceStore.setState({ items: [item] });
    render(
      <TypePageShell
        type="mcp"
        addItems={[]}
        onInstall={vi.fn()}
        onEditAgent={vi.fn()}
        onOpenPreset={vi.fn()}
        onEditMcpEntry={onEditMcpEntry}
      />,
    );
    fireEvent.click(screen.getByText('甲'));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onEditMcpEntry).toHaveBeenCalledWith(item);
  });
});

// ── P2.5 Task 4：删除二次确认（行/详情 onDelete 改 requestDelete 拦截）─────
describe('TypePageShell - 删除二次确认（P2.5 Task 4）', () => {
  const mcpItem: ResourceItem = {
    id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
    description: '', installed: true, installable: false, removable: true,
  };

  it('行删除钮点击 → 确认弹窗出现（标题含资源名），此时不执行删除', () => {
    useResourceStore.setState({ items: [mcpItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 甲' }));
    expect(screen.getByRole('dialog', { name: '删除 甲？' })).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('确认 → 执行删除（ipc delete 桩收到 id）且弹窗消失', async () => {
    useResourceStore.setState({ items: [mcpItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 甲' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('custom-mcp-a'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('取消 → 不删除且弹窗消失', () => {
    useResourceStore.setState({ items: [mcpItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 甲' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('MCP 类型弹窗 message 含悬空引用提示句', () => {
    useResourceStore.setState({ items: [mcpItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 甲' }));
    expect(
      screen.getByText('此操作不可撤销。引用它的智能体将出现悬空提示，需手动移除引用。'),
    ).toBeInTheDocument();
  });

  it('skill 类型弹窗 message 仅「此操作不可撤销。」（无悬空句）', () => {
    useResourceStore.setState({
      items: [{
        id: 'custom-skill-b', type: 'skill', source: 'custom', slug: 'b', name: '乙',
        description: '', installed: true, installable: false, removable: true,
      }],
    });
    render(
      <TypePageShell type="skill" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 乙' }));
    expect(screen.getByText('此操作不可撤销。')).toBeInTheDocument();
    expect(screen.queryByText(/悬空/)).toBeNull();
  });

  it('详情面板删除钮同样走确认弹窗（非直删）', () => {
    useResourceStore.setState({ items: [mcpItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    // 详情面板删除钮可访问名为「删除」（行内钮带资源名为「删除 甲」，互不冲突）
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog', { name: '删除 甲？' })).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

// ── 2026-10-09 真机走查修复：筛选状态诚实性 ──────────────────────────────
describe('TypePageShell - 筛选状态诚实性（走查 N1/N2/N4 + A2）', () => {
  it('来源下拉无远端死选项（断言迁移——library-store-split：仅本地三档，hub 档退场）', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).queryByRole('option', { name: /网络/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Smithery/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /momo-hub/ })).toBeNull();
    expect(within(select).getAllByRole('option')).toHaveLength(3);
  });

  it('搜索无匹配 → 「没有匹配的资源」+ 清除筛选按钮（不得误报空库）', () => {
    useResourceStore.setState({ items: [itemA], query: 'zzz不存在xyz' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('没有匹配的资源')).toBeTruthy();
    expect(screen.queryByText('还没有 MCP 服务器')).toBeNull();
    expect(screen.getByRole('button', { name: '清除筛选' })).toBeTruthy();
  });

  it('清除筛选 → query 清空 + sourceFilter 回 all', () => {
    useResourceStore.setState({ items: [itemA], query: 'zzz', sourceFilter: 'smithery' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(useResourceStore.getState().query).toBe('');
    expect(useResourceStore.getState().sourceFilter).toBe('all');
  });

  it('来源筛选无匹配（无该来源项）→ 同样显示无匹配空态而非「还没有…」', () => {
    // 来源筛选是前端过滤（组③：下拉计数需全量）——有 items 但无该来源项即触发
    useResourceStore.setState({ items: [itemA], sourceFilter: 'smithery' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('没有匹配的资源')).toBeTruthy();
    expect(screen.queryByText('还没有 MCP 服务器')).toBeNull();
  });

  it('选中行被搜索过滤掉 → 详情面板收起（走查 N2：空态与详情同屏矛盾）', () => {
    useResourceStore.setState({ items: [itemA] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();

    act(() => {
      useResourceStore.setState({ query: '乙' });
    });
    expect(screen.queryByLabelText('关闭详情')).toBeNull();
  });

  it('选中行仍匹配搜索 → 详情面板保持', () => {
    useResourceStore.setState({ items: [itemA] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    act(() => {
      useResourceStore.setState({ query: '甲' });
    });
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });
});

// ── 组③ B8 方案 B：详情面板可拖宽（280–560px + 持久化）───────────────────
describe('TypePageShell - 详情面板拖宽（组③ B8）', () => {
  const WIDTH_KEY = 'momo.resourceLibrary.detailWidth';

  const openDetail = (): HTMLElement => {
    useResourceStore.setState({ items: [itemA] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    return screen.getByTestId('detail-pane');
  };

  it('默认宽度 384px；手柄 role=separator 且可聚焦（键盘路径）', () => {
    const pane = openDetail();
    expect(pane.style.width).toBe('384px');
    const grip = screen.getByRole('separator', { name: '调整详情面板宽度' });
    expect(grip.getAttribute('tabindex')).toBe('0');
  });

  it('鼠标拖拽左移 50px → 宽度 +50 并持久化（mouseup 落 localStorage）', () => {
    const pane = openDetail();
    const grip = screen.getByRole('separator', { name: '调整详情面板宽度' });
    fireEvent.mouseDown(grip, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 550 });
    expect(pane.style.width).toBe('434px');
    fireEvent.mouseUp(document);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('434');
  });

  it('拖拽越界钳制在 [280, 560]', () => {
    const pane = openDetail();
    const grip = screen.getByRole('separator', { name: '调整详情面板宽度' });
    fireEvent.mouseDown(grip, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 100 }); // 右移 500 → 384+500 越界
    expect(pane.style.width).toBe('560px');
    fireEvent.mouseMove(document, { clientX: 2000 }); // 左移回 1400 → 越下界
    expect(pane.style.width).toBe('280px');
    fireEvent.mouseUp(document);
  });

  it('键盘 ←/→ ±16、Home/End 到边界，落值即持久化', () => {
    openDetail();
    const grip = screen.getByRole('separator', { name: '调整详情面板宽度' });
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(screen.getByTestId('detail-pane').style.width).toBe('400px');
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(screen.getByTestId('detail-pane').style.width).toBe('384px');
    fireEvent.keyDown(grip, { key: 'End' });
    expect(screen.getByTestId('detail-pane').style.width).toBe('560px');
    fireEvent.keyDown(grip, { key: 'Home' });
    expect(screen.getByTestId('detail-pane').style.width).toBe('280px');
    expect(localStorage.getItem(WIDTH_KEY)).toBe('280');
  });

  it('持久化值恢复：越界值钳制、垃圾值回退默认', () => {
    localStorage.setItem(WIDTH_KEY, '999');
    const pane1 = openDetail();
    expect(pane1.style.width).toBe('560px');
  });

  it('垃圾持久化值回退 384 默认', () => {
    localStorage.setItem(WIDTH_KEY, 'abc');
    const pane = openDetail();
    expect(pane.style.width).toBe('384px');
  });
});

// ── 组④ C11：列表键盘导航（卡片化 2D 升级——列数按 offsetTop 动态推导）──────
describe('TypePageShell - 列表键盘导航（组④ C11，卡片化 2D）', () => {
  it('列表容器为流式网格（定值锁）；↑/↓/Home/End 移动卡片焦点，Enter 打开详情', () => {
    useResourceStore.setState({ items: [itemA, builtinItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    const list = screen.getByRole('list', { name: '资源列表' });
    // P1 预览批准定值：流式网格容器（auto-fill minmax + content-start 防行拉伸）
    expect(list).toHaveClass('grid', 'gap-2', 'content-start', 'p-3');
    expect(list.className).toContain('grid-cols-[repeat(auto-fill,minmax(240px,1fr))]');

    const cardA = screen.getByRole('button', { name: '甲，描述甲' });
    const cardB = screen.getByRole('button', { name: '乙，描述乙' });
    // jsdom 无布局引擎——注入 offsetTop 模拟窄容器单列网格（1 卡一行），↑↓ 即相邻跳
    Object.defineProperty(cardA, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(cardB, 'offsetTop', { value: 100, configurable: true });
    cardA.focus();
    expect(document.activeElement).toBe(cardA);

    fireEvent.keyDown(cardA, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cardB);
    fireEvent.keyDown(cardB, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cardA);
    fireEvent.keyDown(cardA, { key: 'Home' });
    expect(document.activeElement).toBe(cardA);
    fireEvent.keyDown(cardA, { key: 'End' });
    expect(document.activeElement).toBe(cardB);

    fireEvent.keyDown(cardB, { key: 'Enter' });
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });
});


// ── D13：installNotice 对象形态（带「去会话」CTA）──────────────────────────
describe('TypePageShell - installNotice CTA（D13）', () => {
  it('string 旧形态完全兼容：无按钮，仅文本（存量写入点回归锁）', () => {
    useResourceStore.setState({ installNotice: '已导入至「自定义」' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByTestId('install-notice')).toBeTruthy();
    expect(screen.getByText('已导入至「自定义」')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去会话' })).not.toBeInTheDocument();
  });

  it('object 形态带 actionView → 渲染「去会话」按钮，点击切到会话视图', () => {
    useResourceStore.setState({
      installNotice: { text: '🐾 Momo 已启用并加入当前工作空间，可开始快速会话。', actionView: 'im' },
    });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText(/已启用并加入当前工作空间/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去会话' }));
    expect(useUiStore.getState().activeView).toBe('im');
  });

  it('object 形态无 actionView → 仅文本，无按钮', () => {
    useResourceStore.setState({ installNotice: { text: '纯文本对象' } });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('纯文本对象')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去会话' })).not.toBeInTheDocument();
  });
});

// ── D9 → library-store-split：市场目录降级横幅退场（语义迁 FetchDialog）──────
describe('TypePageShell - 目录降级提示退场（library-store-split §2.1）', () => {
  it('degraded=true 且 agent 页 → 横幅不再渲染（断言迁移——市场降级黄条随库页收窄退场）', () => {
    useResourceStore.setState({ catalogDegraded: true });
    render(
      <TypePageShell type="agent" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.queryByTestId('catalog-degraded-notice')).not.toBeInTheDocument();
    expect(screen.queryByText('网络目录暂时不可达（离线或网络受限），当前显示本地目录。')).toBeNull();
  });

  it('agent 页挂载仍探测目录状态（loadCatalogStatus → 播种门控数据源不变）', async () => {
    getCatalogStatusMock.mockResolvedValue({ degraded: true });
    render(
      <TypePageShell type="agent" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    await waitFor(() => expect(getCatalogStatusMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useResourceStore.getState().catalogDegraded).toBe(true),
    );
  });

  it('探测通道失败 → 不误报降级（catalogDegraded 保持 false）', async () => {
    getCatalogStatusMock.mockRejectedValue(new Error('channel not ready'));
    render(
      <TypePageShell type="agent" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    await waitFor(() => expect(getCatalogStatusMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(useResourceStore.getState().catalogDegraded).toBe(false);
    });
    expect(screen.queryByTestId('catalog-degraded-notice')).not.toBeInTheDocument();
  });
});

describe('buildImpactMessage — 披露式级联文案契约（2026-10-10）', () => {
  // 纯函数直测：文案是用户确认依据，锁死行结构（· 前缀 + 非零项才出现）
  const zeroImpact = {
    memberCount: 0, workspaceNames: [], ledTeamNames: [],
    readOnlySessionCount: 0, defaultForWorkspaceNames: [],
  };

  it('impact 为 null（预查失败）：仅返回 base，不追加任何披露行', () => {
    expect(buildImpactMessage('此操作不可撤销。', null)).toBe('此操作不可撤销。');
  });

  it('全零影响：仅返回 base', () => {
    expect(buildImpactMessage('此操作不可撤销。将同时：', zeroImpact)).toBe('此操作不可撤销。将同时：');
  });

  it('齐全影响：四行披露逐条列出（· 前缀、\n 分隔）', () => {
    const msg = buildImpactMessage('将同时：', {
      memberCount: 2,
      workspaceNames: ['空间A', '空间B'],
      ledTeamNames: ['冲锋队'],
      readOnlySessionCount: 3,
      defaultForWorkspaceNames: ['空间B'],
    });
    const lines = msg.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('将同时：');
  expect(lines[1]).toContain('从 2 个工作空间移出该智能体（空间A、空间B）');
  expect(lines[2]).toContain('解散 1 个团队（该智能体为 leader：冲锋队）');
    expect(lines[3]).toContain('3 个会话的全部成员失效，将变为只读（消息历史保留）');
    expect(lines[4]).toContain('清空 1 个工作空间的默认智能体设置');
  });

  it('部分影响：只列非零项（有成员但无团队/会话/默认影响）', () => {
    const msg = buildImpactMessage('将同时：', {
      ...zeroImpact,
      memberCount: 1,
      workspaceNames: ['空间A'],
    });
    expect(msg.split('\n')).toHaveLength(2);
    expect(msg).toContain('从 1 个工作空间移出该智能体（空间A）');
  });
});

// ── 插件页（spec 2026-10-15 P1）：启停透传 + 卸载 keepData 双按钮 ──────────────

describe('TypePageShell - 插件启停与卸载（P1）', () => {
  const pluginItem: ResourceItem = {
    id: 'custom-plugin-cg', type: 'plugin', source: 'custom', slug: 'cg',
    name: 'Codegraph 代码图谱', description: '图谱', version: '0.1.0',
    installed: true, installable: false, removable: true,
    plugin: {
      id: 'cg', state: 'active', devSource: false, sourcePath: null,
      components: ['tools', 'service', 'agents', 'skills', 'panel'], enabled: true,
    },
  };

  it('插件页空列表渲染插件空态文案', () => {
    useResourceStore.setState({ typeFilter: 'plugin', activeType: 'plugin', items: [] });
    render(<TypePageShell type="plugin" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />);
    expect(screen.getByText('还没有安装插件')).toBeTruthy();
  });

  it('选中插件行 → 详情面板出现分组能力清单与启停按钮，点击启停透传回调', async () => {
    pluginGetDetailMock.mockResolvedValue({
      pluginId: 'cg',
      mcps: [{ name: 'codegraph' }],
      tools: [{ fullName: 'plugin:cg/explore', description: '查', pluginName: 'cg' }],
      skills: [{ slug: 'cg-usage' }],
      agents: [{ id: 'plugin:cg:nav', name: '导航员' }],
      panels: [{ panelId: 'main', title: 't' }],
      service: true, config: true,
    });
    useResourceStore.setState({ typeFilter: 'plugin', activeType: 'plugin', items: [pluginItem] });
    const onTogglePlugin = vi.fn();
    render(<TypePageShell type="plugin" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} onTogglePlugin={onTogglePlugin} />);
    fireEvent.click(screen.getByText('Codegraph 代码图谱'));
    expect(await screen.findByText('提供的能力')).toBeTruthy();
    expect(screen.getByText('codegraph')).toBeTruthy();
    expect(screen.getByText('plugin:cg/explore')).toBeTruthy();
    expect(screen.getByText('cg-usage')).toBeTruthy();
    expect(screen.getByText('导航员')).toBeTruthy();
    expect(screen.getByText(/面板 ×1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /停用/ }));
    expect(onTogglePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-plugin-cg' }),
      false,
    );
  });

  it('dev 源插件详情显示源目录路径；missing 态显示降级徽章', async () => {
    const devItem: ResourceItem = {
      ...pluginItem,
      id: 'custom-plugin-dtb', slug: 'dtb', name: '内部部署工具箱',
      plugin: {
        id: 'dtb', state: 'missing', devSource: true, sourcePath: '/Users/x/dev/deploy-toolbox',
        components: ['tools'], enabled: false,
      },
    };
    useResourceStore.setState({ typeFilter: 'plugin', activeType: 'plugin', items: [devItem] });
    render(<TypePageShell type="plugin" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />);
    fireEvent.click(screen.getByText('内部部署工具箱'));
    expect(await screen.findByText('/Users/x/dev/deploy-toolbox')).toBeTruthy();
    expect(screen.getAllByText('目录缺失').length).toBeGreaterThanOrEqual(2); // 行徽标 + 详情徽章双面
  });

  it('插件卸载走 keepData 双按钮弹窗：完全卸载传 (id, false)，保留数据传 (id, true)', async () => {
    const uninstallMock = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { api: Record<string, unknown> }).api = {
      ...((window as unknown as { api: Record<string, unknown> }).api ?? {}),
      plugin: {
        uninstall: uninstallMock, setEnabled: vi.fn(), installZip: vi.fn(), installDevDir: vi.fn(),
        getDetail: pluginGetDetailMock,
      },
    };
    useResourceStore.setState({ typeFilter: 'plugin', activeType: 'plugin', items: [pluginItem] });
    render(<TypePageShell type="plugin" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />);
    fireEvent.click(screen.getByText('Codegraph 代码图谱'));
    fireEvent.click(await screen.findByRole('button', { name: /卸载/ }));
    expect(await screen.findByText(/卸载「Codegraph 代码图谱 v0\.1\.0」/)).toBeTruthy();
    expect(uninstallMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '卸载并保留数据' }));
    await waitFor(() => expect(uninstallMock).toHaveBeenCalledWith('cg', true));
    expect(await screen.findByText(/已卸载/)).toBeTruthy();
  });
});

// ── library-store-split：hub 档与两条提示横幅退场（语义迁 FetchDialog 特殊态）──
describe('TypePageShell - hub 档与提示条退场（library-store-split §2.1）', () => {
  const hubRow: ResourceItem = {
    id: 'hub-agent-meeting', type: 'mcp', source: 'hub', slug: 'meeting', name: '会议纪要',
    description: '纪要生成', version: '1.1.0', installed: true, installable: false, removable: true,
  };

  it('已装 hub 行计入「全部」计数（无 momo-hub 专属档——断言迁移）', () => {
    useResourceStore.setState({
      items: [hubRow, { ...itemA }],
      sourceFilter: 'all', query: '',
    });
    render(<TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />);
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).getByRole('option', { name: /全部 2/ })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /momo-hub/ })).toBeNull();
    // 已装 hub 卡仍在网格（来源徽标不变——矩阵 #7）
    expect(screen.getByText('会议纪要')).toBeTruthy();
  });

  it('未接入灰条与降级黄条不再渲染（断言迁移——两条横幅随库页收窄退场，语义迁弹窗）', () => {
    useResourceStore.setState({ items: [hubRow], sourceFilter: 'all', query: '', hubDegraded: true });
    useHubStore.setState({ status: {
      configured: false, state: 'disconnected', hubUrl: null, nodeName: null, nodeId: null,
      lastError: null, lastErrorCode: null, hubProtoVer: null,
    }, nodes: [], loadError: null });
    render(<TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />);
    expect(screen.queryByTestId('hub-not-enrolled-notice')).toBeNull();
    expect(screen.queryByTestId('hub-degraded-notice')).toBeNull();
    expect(screen.queryByText(/接入后可安装组内共享资源/)).toBeNull();
    expect(screen.queryByText(/hub 暂不可达/)).toBeNull();
  });
});
