// renderer/src/components/resource-library/ResourceLibraryView.test.tsx
//
// 资源库壳重写测试（spec §2.1 三页结构）：TypeSidebar 二级菜单 + TypePageShell 组合。
//   - 默认渲染 Agent 页（导航 landmark + 页标题「智能体」）
//   - 切 MCP 页：标题与「＋」按钮文案随类型切换
//   - MCP 页「＋」下拉三条本地路径（快速创建 / 导入 JSON / 导入包；P2.3 Task 1
//     起「从网络获取」项已移除——单态负例断言）
//   - localStorage 持久化恢复上次激活页
//   - mount 时自动首拉 resource.list（旧视图同语义回归锁）
//   - 安装链路：onInstall 直连 store.installResource（registry 侧包装流已删——
//     成功横幅仍在，marketplace agent 不再自动弹配置引导）
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
// P2.2 Task 7：MCP 页 installed 模式挂载 DanglingRefsCard → mount 拉一次悬空引用
const resourceDanglingMcpRefs = vi.fn();
// P2.3 Task 4：预置库弹窗挂载拉预置清单
const resourceListBuiltinPresets = vi.fn();
const agentList = vi.fn();
const agentBuiltinSuggestions = vi.fn();
const providerList = vi.fn();
const settingsGetGlobal = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
    install: resourceInstall,
    delete: resourceDelete,
    danglingMcpRefs: resourceDanglingMcpRefs,
    listBuiltinPresets: resourceListBuiltinPresets,
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
  resourceDanglingMcpRefs.mockReset().mockResolvedValue([]);
  resourceListBuiltinPresets.mockReset().mockResolvedValue([]);
  agentList.mockReset().mockResolvedValue([] as AgentDefinition[]);
  agentBuiltinSuggestions.mockReset().mockResolvedValue({});
  providerList.mockReset().mockResolvedValue([]);
  settingsGetGlobal.mockReset().mockResolvedValue({});
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  localStorage.clear();
  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'agent', sourceFilter: 'all', query: '',
    activeType: 'agent',
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

  it('MCP 页下拉含三条本地路径，无「从网络获取」（P2.3 Task 1 单态）', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    expect(screen.getByText('快速创建…')).toBeTruthy();
    expect(screen.getByText('导入 JSON…')).toBeTruthy();
    expect(screen.getByText('导入 DXT / MCPB 包')).toBeTruthy();
    expect(screen.queryByText('从网络获取…')).toBeNull();
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

// ── 安装链路回归锁（终审 Important-3；P2.3 Task 1 起单态语义）─────────────
// 链路：ResourceRow 安装按钮 → View.onInstall → store.installResource（真实实现，
// 经 mock IPC 边界）→ 成功横幅。registry 侧包装流（smithery needsConfig 弹窗 /
// marketplace agent 配置引导）已随网络获取模式移除——onInstall 只剩本地安装语义。
describe('安装链路回归锁（单态）', () => {
  it('marketplace agent 安装成功 → install 调用 + 成功横幅；不弹配置引导（registry 侧接线已删）', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-agent-g', type: 'agent', slug: 'agent-g', name: '市场智能体' })],
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-agent-g')).getByRole('button', { name: '安装' }),
    );
    await waitFor(() => expect(resourceInstall).toHaveBeenCalledWith('marketplace-agent-g'));
    // 成功横幅经真实 store 链路渲染（installNotice → shell 横幅）
    await waitFor(() => expect(screen.getByTestId('install-notice')).toBeTruthy());
    // 配置引导（openPresetDialog → agent.list）不再随安装自动触发
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(agentList).not.toHaveBeenCalled();
  });

  it('marketplace MCP 安装成功 → install 调用 + 成功横幅（无 agent 引导）', async () => {
    useResourceStore.setState({
      items: [mkInstallable({ id: 'marketplace-mcp-g', type: 'mcp', slug: 'mcp-g', name: '市场MCP' })],
    });
    render(<ResourceLibraryView />);
    fireEvent.click(
      within(screen.getByTestId('resource-row-marketplace-mcp-g')).getByRole('button', { name: '安装' }),
    );
    await waitFor(() => expect(resourceInstall).toHaveBeenCalledWith('marketplace-mcp-g'));
    await waitFor(() => expect(screen.getByTestId('install-notice')).toBeTruthy());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(agentList).not.toHaveBeenCalled();
  });
});

// ── DXT/MCPB 本地包导入入口（P2.1 Task 6；smithery 连接配置弹窗已随安装流移除）──
describe('DXT/MCPB 导入入口', () => {
  it('MCP「＋」菜单点「导入 DXT / MCPB 包」→ 挂载 ImportBundleDialog', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.click(screen.getByText('导入 DXT / MCPB 包'));
    expect(screen.getByRole('dialog', { name: '导入 DXT / MCPB 包' })).toBeTruthy();
  });
});

// ── 预置库入口与接线（P2.3 Task 4）─────────────────────────────────────────
// 链路：AddMenu「启用预置库」（仅 agent 页组装，Task 0 裁定：只有 agent 有
// YAML→落库启用管线）→ PresetLibraryDialog（mount 拉 listBuiltinPresets）→
// 选中 slug → 关预置库 + openPresetBySlug（builtin-<slug> def 反查，与
// openPresetDialog 同形状）→ EnablePresetDialog（presetTarget 挂载位，enable 模式）。
describe('预置库入口与接线（P2.3 Task 4）', () => {
  it('Agent 页「＋」菜单含「启用预置库」；MCP / Skill 页无（仅 agent 有启用语义）', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: '新建 / 导入' }));
    expect(screen.getByText('启用预置库')).toBeTruthy();
    // 关菜单 → 切 MCP 页：下拉无该入口
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    expect(screen.queryByText('启用预置库')).toBeNull();
    // 切 Skill 页：同样无
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
    fireEvent.click(screen.getByRole('button', { name: '添加技能' }));
    expect(screen.queryByText('启用预置库')).toBeNull();
  });

  it('入口打开预置库 → 选中 → 关预置库并打开 EnablePresetDialog（enable 模式）', async () => {
    // 展示名来源：resource.list 返回的 builtin agent 清单项（真实语义：agent 页
    // 已安装列表本就含 4 个预置 agent，catalog 是展示名权威——mount 首拉后 items
    // 即为该清单）
    resourceList.mockResolvedValueOnce([
      {
        id: 'agent-coder',
        type: 'agent',
        source: 'builtin',
        slug: 'coder',
        name: '程序员',
        description: '根据需求实现代码，支持多种编程语言',
        installed: true,
        installable: false,
        removable: false,
      } as ResourceItem,
    ]);
    resourceListBuiltinPresets.mockResolvedValueOnce([
      { slug: 'coder', name: '程序员', description: '根据需求实现代码，支持多种编程语言', iconEmoji: '💻' },
    ]);
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: '新建 / 导入' }));
    fireEvent.click(screen.getByText('启用预置库'));
    // 预置库弹窗挂载并按当前 activeType 拉清单
    await waitFor(() => expect(resourceListBuiltinPresets).toHaveBeenCalledWith('agent'));
    const libDialog = await screen.findByRole('dialog', { name: '启用预置库' });
    expect(within(libDialog).getByText('程序员')).toBeTruthy();
    // 选中 → def 反查走 agent.list（builtin-<slug> ?? slug 形状）→ EnablePresetDialog
    // 以 enable 模式打开（agent.list 返回空 = 未启用，def undefined；标题名取自
    // store 同 slug 清单项）
    fireEvent.click(within(libDialog).getByRole('button', { name: '选择' }));
    await screen.findByRole('dialog', { name: '启用预设 Agent：程序员' });
    expect(screen.queryByRole('dialog', { name: '启用预置库' })).toBeNull();
    await waitFor(() => expect(agentList).toHaveBeenCalled());
  });
});
