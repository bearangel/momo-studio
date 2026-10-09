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
import { TypePageShell } from './TypePageShell';
import { useResourceStore } from '../../stores/resource.store';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn();
// MCP 页挂载 DanglingRefsCard → mount 拉一次悬空引用
const danglingMcpRefsMock = vi.fn();
// P2.5 Task 4：删除确认流的 ipc delete 桩（store.deleteResource → ipc.resource.delete）
const deleteMock = vi.fn();

const mockApi = {
  resource: {
    list: listMock,
    danglingMcpRefs: danglingMcpRefsMock,
    delete: deleteMock,
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
  listMock.mockReset();
  listMock.mockResolvedValue([] as ResourceItem[]);
  danglingMcpRefsMock.mockReset();
  danglingMcpRefsMock.mockResolvedValue([]);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  localStorage.clear();

  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'mcp', sourceFilter: 'all', query: '',
    activeType: 'mcp',
  });
});

describe('TypePageShell（已安装单态，P2.3 Task 1）', () => {
  it('工具栏单行：搜索框 + 来源下拉（带计数）+ AddMenu、外部市场入口；不渲染模式 Segmented 与「网络获取」', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    // 单态断言：模式切换 Segmented（已安装|网络获取）整体不渲染
    expect(screen.queryByRole('radio', { name: '已安装' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '网络获取' })).toBeNull();
    expect(screen.queryByText('网络获取')).toBeNull();
    expect(screen.getByPlaceholderText('搜索名称 / 描述 / slug…')).toBeTruthy();
    // 来源筛选 = 原生 select（键盘可达）；无「网络」选项（走查 N4：死筛选不设入口）
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).getByRole('option', { name: /全部来源/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /预置/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /自定义/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /P2P/ })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /网络/ })).toBeNull();
    expect(screen.getByRole('button', { name: '添加服务器' })).toBeTruthy();
    // P2.3 Task 3：外部市场快捷打开入口挂载（原 Segmented 位）
    expect(screen.getByRole('button', { name: '外部市场' })).toBeTruthy();
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

  it('来源下拉计数：全部=N，各来源分组计数（组③——下拉标签带弱化数字）', () => {
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
    expect(within(select).getByRole('option', { name: '全部来源 3' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: '预置 2' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: '自定义 1' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: 'P2P 0' })).toBeTruthy();
  });

  it('来源下拉切换 = 前端过滤（不触发 load；列表按来源收窄）', () => {
    listMock.mockClear();
    useResourceStore.setState({ items: [itemA, builtinItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('来源筛选'), { target: { value: 'builtin' } });
    expect(useResourceStore.getState().sourceFilter).toBe('builtin');
    // 前端过滤语义：无 IPC
    expect(listMock).not.toHaveBeenCalled();
    // 列表收窄到 builtin 项
    expect(document.querySelectorAll('[data-testid^="resource-row-"]')).toHaveLength(1);
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
    expect(screen.getByText('加载失败：导入失败：boom')).toBeTruthy();
  });

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
      screen.getByText('此操作不可撤销。引用它的 agent 将出现悬空提示，需手动移除引用。'),
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
  it('来源下拉无「网络」选项（P2.3 后 marketplace 源无新增产出——死筛选不设入口）', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    const select = screen.getByLabelText('来源筛选');
    expect(within(select).queryByRole('option', { name: /网络/ })).toBeNull();
    expect(within(select).getAllByRole('option')).toHaveLength(4);
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
    useResourceStore.setState({ items: [itemA], query: 'zzz', sourceFilter: 'p2p' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(useResourceStore.getState().query).toBe('');
    expect(useResourceStore.getState().sourceFilter).toBe('all');
  });

  it('来源筛选无匹配（无该来源项）→ 同样显示无匹配空态而非「还没有…」', () => {
    // 来源筛选是前端过滤（组③：下拉计数需全量）——有 items 但无该来源项即触发
    useResourceStore.setState({ items: [itemA], sourceFilter: 'p2p' });
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

// ── 组④ C11：列表键盘导航（↑/↓/Home/End 行间移焦 + Enter 开详情）──────────
describe('TypePageShell - 列表键盘导航（组④ C11）', () => {
  it('列表容器 role=list；↑/↓/Home/End 移动行焦点，Enter 打开详情', () => {
    useResourceStore.setState({ items: [itemA, builtinItem] });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByRole('list', { name: '资源列表' })).toBeTruthy();

    const rowA = screen.getByRole('button', { name: '甲，描述甲' });
    const rowB = screen.getByRole('button', { name: '乙，描述乙' });
    rowA.focus();
    expect(document.activeElement).toBe(rowA);

    fireEvent.keyDown(rowA, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowB);
    fireEvent.keyDown(rowB, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowA);
    fireEvent.keyDown(rowA, { key: 'Home' });
    expect(document.activeElement).toBe(rowA);
    fireEvent.keyDown(rowA, { key: 'End' });
    expect(document.activeElement).toBe(rowB);

    fireEvent.keyDown(rowB, { key: 'Enter' });
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });
});

