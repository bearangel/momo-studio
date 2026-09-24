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
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
  it('工具栏含搜索框、来源 chips、AddMenu、外部市场入口；不渲染模式 Segmented 与「网络获取」', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    // 单态断言：模式切换 Segmented（已安装|网络获取）整体不渲染
    expect(screen.queryByRole('radio', { name: '已安装' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '网络获取' })).toBeNull();
    expect(screen.queryByText('网络获取')).toBeNull();
    expect(screen.getByPlaceholderText('搜索名称 / 描述 / slug…')).toBeTruthy();
    expect(screen.getByText('预置')).toBeTruthy();
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

  it('安装成功横幅可见（单态——无模式门控）', () => {
    useResourceStore.setState({ installNotice: '已导入至「我的上传」' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByTestId('install-notice')).toBeTruthy();
    expect(screen.getByText('已导入至「我的上传」')).toBeTruthy();
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

