// renderer/src/components/resource-library/ResourceLibraryView.test.tsx
//
// 资源库壳重写测试（spec §2.1 三页结构）：TypeSidebar 二级菜单 + TypePageShell 组合。
//   - 默认渲染 Agent 页（导航 landmark + 页标题「智能体」）
//   - 切 MCP 页：标题与「＋」按钮文案随类型切换
//   - MCP 页「＋」下拉三条路径（手动配置 / 粘贴 JSON / 网络获取）
//   - localStorage 持久化恢复上次激活页
//   - mount 时自动首拉 resource.list（旧视图同语义回归锁）
//
// Mock 方式遵循 TypePageShell.test.tsx 既有形态：不 vi.mock ipc/client 模块，而是在
// 真实 jsdom window 上装 window.api 属性——ipc.client 是真实 Proxy，store 的 load 经
// 真通道走桩（momo-test-rules：mock 收窄到 IPC 边界）。vitest globals:false，显式导入。
//
// 关注项修复回归锁（Task 8 收尾）：
//   - ③ mount-load：挂在 → resource.list 被调（waitFor）。锁住「冷启动首拉」语义。
//   - ① closePresetDialog 三重刷新：EnablePresetDialog 真实驱动需写表单/选模型，
//     跨子组件深交互，与本壳渲染测试范畴不成比例；代码修复为权威（见视图 commit）。
//     详见 /workspace/.superpowers/sdd/task-8-report.md「关注项修复」。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { ResourceLibraryView } from './ResourceLibraryView';
import { useResourceStore } from '../../stores/resource.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { AgentDefinition, ResourceItem, ResourceType } from '../../ipc/types';

// ---- mock IPC 桩（本壳测试触达 resource / agent / provider / settings 命名空间）----
const resourceList = vi.fn();
const resourceInstall = vi.fn();
const resourceDelete = vi.fn();
const resourceInstallSmitheryRemote = vi.fn();
const agentList = vi.fn();
const agentBuiltinSuggestions = vi.fn();
const providerList = vi.fn();
const settingsGetGlobal = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
    install: resourceInstall,
    delete: resourceDelete,
    installSmitheryRemote: resourceInstallSmitheryRemote,
  },
  agent: { list: agentList, getBuiltinSuggestions: agentBuiltinSuggestions },
  provider: { list: providerList },
  settings: { getGlobal: settingsGetGlobal },
};

// marketplace 可安装项工厂（安装链路回归锁用）
function mkInstallable(
  over: Partial<ResourceItem> & { id: string; type: ResourceType; slug: string; name: string },
): ResourceItem {
  return {
    source: 'marketplace',
    description: 'd',
    installed: false,
    installable: true,
    removable: false,
    marketplace: { author: 'a', readme: '', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: [], category: 'c' },
    ...over,
  } as ResourceItem;
}

beforeEach(() => {
  resourceList.mockReset().mockResolvedValue([] as ResourceItem[]);
  resourceInstall.mockReset().mockResolvedValue(undefined);
  resourceDelete.mockReset().mockResolvedValue(undefined);
  resourceInstallSmitheryRemote.mockReset().mockResolvedValue(undefined);
  agentList.mockReset().mockResolvedValue([] as AgentDefinition[]);
  agentBuiltinSuggestions.mockReset().mockResolvedValue({});
  providerList.mockReset().mockResolvedValue([]);
  settingsGetGlobal.mockReset().mockResolvedValue({});
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  localStorage.clear();
  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'agent', sourceFilter: 'all', query: '',
    activeType: 'agent', mode: 'installed',
  });
  // activeWorkspaceId 复位为 null——closePresetDialog 三重刷新按 null 走分支，
  // 不发 agent.listMembers，测试避免悬空 mock 引用。
  useWorkspaceStore.setState({ activeWorkspaceId: null });
});

describe('ResourceLibraryView（三页壳）', () => {
  it('渲染二级侧边菜单与默认 Agent 页', () => {
    render(<ResourceLibraryView />);
    expect(screen.getByRole('navigation', { name: '资源类型' })).toBeTruthy();
    expect(screen.getByText('智能体')).toBeTruthy();
  });

  it('切到 MCP 页标题与添加按钮文案切换', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    expect(screen.getByText('MCP 服务器')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加服务器' })).toBeTruthy();
  });

  it('MCP 页下拉含四条路径（手动配置/粘贴 JSON/导入包/网络获取）', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    expect(screen.getByText('手动配置…')).toBeTruthy();
    expect(screen.getByText('粘贴 JSON…')).toBeTruthy();
    expect(screen.getByText('导入 DXT / MCPB 包')).toBeTruthy();
    expect(screen.getByText('从网络获取…')).toBeTruthy();
  });

  it('持久化恢复上次激活页', () => {
    localStorage.setItem('momo.resourceLibrary.activeType', 'skill');
    useResourceStore.setState({ activeType: 'skill', typeFilter: 'skill' });
    render(<ResourceLibraryView />);
    expect(screen.getByText('技能')).toBeTruthy();
  });

  it('mount 时自动首拉 resource.list（旧视图冷启动语义回归锁）', async () => {
    expect(resourceList).not.toHaveBeenCalled();
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalled());
  });
});

// ── 终审 Important-3：安装链路回归锁（旧 View 测试删除后补）─────────────
// 链路：ResourceRow 安装按钮 → View.handleInstall → store.installResource（真实实现，
// 经 mock IPC 边界）→ 成功横幅；marketplace agent 成功 → openPresetDialog 引导门控。
describe('安装链路回归锁（终审 Important-3）', () => {
  it('marketplace agent 安装成功 → install 调用后触发配置引导（agent.list）+ 成功横幅', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-agent-g', type: 'agent', slug: 'agent-g', name: '市场智能体' })],
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-agent-g')).getByRole('button', { name: '安装' }),
    );
    await waitFor(() => expect(resourceInstall).toHaveBeenCalledWith('marketplace-agent-g'));
    // 引导链：install 成功 → openPresetDialog → agent.list（EnablePresetDialog 挂载前置）
    await waitFor(() => expect(agentList).toHaveBeenCalled());
    // 成功横幅经真实 store 链路渲染（installNotice → shell 横幅）
    await waitFor(() => expect(screen.getByTestId('install-notice')).toBeTruthy());
  });

  it('marketplace MCP 安装成功不触发 agent 引导（门控负例）', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-mcp-g', type: 'mcp', slug: 'mcp-g', name: '市场MCP' })],
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-mcp-g')).getByRole('button', { name: '安装' }),
    );
    await waitFor(() => expect(resourceInstall).toHaveBeenCalledWith('marketplace-mcp-g'));
    // 横幅出现 = installResource 已 resolve，handleInstall 续体（引导分支）已跑完
    await waitFor(() => expect(screen.getByTestId('install-notice')).toBeTruthy());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(agentList).not.toHaveBeenCalled();
  });
});

// ── P2.1 Task 6：smithery needsConfig 连接配置闭环 + DXT/MCPB 导入入口 ────
// 链路：安装按钮 → View.handleInstall 消费 store.installResource 透传的
// SmitheryInstallResult → needsConfig:true 时弹 McpConnectDialog（不再静默）→
// 提交 → ipc.resource.installSmitheryRemote(id, values) → load + 「已连接」横幅 + 关闭。
describe('P2.1 Task 6：smithery 连接配置闭环', () => {
  it('smithery 安装返回 needsConfig → 连接配置弹窗出现（不再静默），且不设成功横幅', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-mcp-weather', type: 'mcp', slug: 'weather', name: 'Weather MCP' })],
    });
    resourceInstall.mockResolvedValueOnce({
      needsConfig: true,
      schema: {
        required: ['apiKey'],
        properties: { apiKey: { title: 'API Key', description: 'key' } },
      },
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-mcp-weather')).getByRole('button', { name: '安装' }),
    );
    // 弹窗出现（标题「连接 {name}」——此前 needsConfig 静默无反馈，本任务闭合）
    expect(await screen.findByRole('dialog', { name: '连接 Weather MCP' })).toBeInTheDocument();
    // store 契约：needsConfig:true 时未安装——不设成功横幅
    expect(screen.queryByTestId('install-notice')).toBeNull();
  });

  it('弹窗提交 → installSmitheryRemote 收到配置 → load 刷新 + 「已连接」横幅 + 弹窗关闭', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-mcp-weather', type: 'mcp', slug: 'weather', name: 'Weather MCP' })],
    });
    resourceInstall.mockResolvedValueOnce({
      needsConfig: true,
      schema: {
        required: ['apiKey'],
        properties: { apiKey: { title: 'API Key', description: 'key' } },
      },
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-mcp-weather')).getByRole('button', { name: '安装' }),
    );
    fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: 'sk-live-7' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() =>
      expect(resourceInstallSmitheryRemote).toHaveBeenCalledWith('marketplace-mcp-weather', {
        apiKey: 'sk-live-7',
      }),
    );
    // 成功横幅复用既有 installNotice 机制（经真实 store 链路渲染）
    await waitFor(() =>
      expect(screen.getByTestId('install-notice').textContent).toContain('已连接：Weather MCP'),
    );
    // 提交成功后弹窗关闭
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('MCP「＋」菜单点「导入 DXT / MCPB 包」→ 挂载 ImportBundleDialog', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.click(screen.getByText('导入 DXT / MCPB 包'));
    expect(screen.getByRole('dialog', { name: '导入 DXT / MCPB 包' })).toBeTruthy();
  });
});
