// renderer/src/components/resource-library/ResourceLibraryView.test.tsx
//
// v1.7 Task 9：ResourceLibraryView 主视图测试——双层 tab（type × source）AND 过滤 +
// 前端搜索 + 主网格卡片 + 选中右侧详情面板 + 三类添加弹窗（RegisterMcp / UploadSkill /
// DefinitionEditor）+ 删除刷新 + onSuccess 刷新。
//
// 行为约定（对齐 task-9-brief）：
//   - 顶部 header：「📚 资源库」标题 + AddResourceMenu 按钮 + 搜索框（placeholder 含"搜索"）
//   - 双层 tab：第一行 4 个 type tab（全部/Agent/MCP/Skill），第二行 4 个 source tab
//     （全部/系统预置/我的上传/网络资源）。两层 AND：filter = { type?, source? }
//   - 主网格：filteredItems 渲染为 ResourceCard 列表（grid auto-fill）
//   - 选中卡片 → 右侧 ResourceDetail 面板滑出，含 item.name 与「×」关闭按钮
//   - 卡片删除按钮（aria-label `删除 ${name}`）→ ipc.resource.delete(id) + load() 刷新
//   - 三类弹窗由 AddResourceMenu 触发；RegisterMcp/UploadSkill 的 onSuccess → load() 刷新
//
// Mock 策略：window.api 桩（resource + mcp + skill + provider + agent 全 surface）+
// useResourceStore.setState 重置 + useWorkspaceStore.setState 注入 activeWorkspaceId。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceLibraryView } from './ResourceLibraryView';
import { useResourceStore } from '../../stores/resource.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { ResourceItem, Workspace } from '../../ipc/types';

// ---- mock IPC 桩 ----
const resourceList = vi.fn();
const resourceDelete = vi.fn();
const resourceInstall = vi.fn();
const resourceGetDetail = vi.fn();
// P3 Task 7：注册面收敛——registerMcp / uploadSkill 走 resource 命名空间
const resourceRegisterMcp = vi.fn();
const resourceUploadSkill = vi.fn();
const mcpStart = vi.fn();
// DefinitionEditor 在 create 模式挂载时会拉取 provider 列表 + agent 列表（仅 ref 不调）
const providerList = vi.fn();
const agentListDefinitions = vi.fn();
const agentCreateCustom = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
    delete: resourceDelete,
    install: resourceInstall,
    getDetail: resourceGetDetail,
    registerMcp: resourceRegisterMcp,
    uploadSkill: resourceUploadSkill,
  },
  mcp: {
    start: mcpStart,
  },
  provider: {
    list: providerList,
  },
  agent: {
    list: agentListDefinitions,
    createCustom: agentCreateCustom,
  },
};

// 默认 active workspace（RegisterMcpDialog 等需要）
const WS: Workspace = {
  id: 'ws-active',
  name: '当前工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  teamSessionId: '!team:server',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

/** 构造一个填好所有必填字段的 ResourceItem，允许部分覆盖 */
const baseItem = (overrides: Partial<ResourceItem> = {}): ResourceItem => ({
  id: 'builtin-agent-pm',
  type: 'agent',
  source: 'builtin',
  slug: 'pm',
  name: '项目经理',
  description: '协调',
  installed: true,
  installable: false,
  removable: false,
  ...overrides,
});

beforeEach(() => {
  // 重置所有 IPC 桩
  [
    resourceList,
    resourceDelete,
    resourceInstall,
    resourceGetDetail,
    resourceRegisterMcp,
    resourceUploadSkill,
    mcpStart,
    providerList,
    agentListDefinitions,
    agentCreateCustom,
  ].forEach((fn) => fn.mockReset());

  resourceList.mockResolvedValue([] as ResourceItem[]);
  resourceDelete.mockResolvedValue(undefined);
  resourceInstall.mockResolvedValue(undefined);
  resourceGetDetail.mockResolvedValue(null);
  resourceRegisterMcp.mockResolvedValue(null);
  resourceUploadSkill.mockResolvedValue([
    { slug: 'x', name: 'x', description: '' },
  ]);
  mcpStart.mockResolvedValue(undefined);
  providerList.mockResolvedValue([]);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api =
    mockApi;

  // 重置 resource store 状态（store 没有 reset，直接 setState 清空）
  useResourceStore.setState({
    items: [],
    loading: false,
    error: null,
    installNotice: null,
    typeFilter: 'all',
    sourceFilter: 'all',
    query: '',
  });

  // 注入 active workspace（RegisterMcpDialog 启动 MCP 时需要）
  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-active',
    loading: false,
    error: null,
  });
});

describe('ResourceLibraryView — 双层 tab + 主网格 + 详情面板 + 弹窗', () => {
  it('渲染默认双层 tab：type 4 项 + source 5 项（含 P2P 共享）', async () => {
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalled());

    // 行标签
    expect(screen.getByText('类型')).toBeInTheDocument();
    expect(screen.getByText('来源')).toBeInTheDocument();

    // type tabs：全部 / Agent / MCP / Skill
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('MCP')).toBeInTheDocument();
    expect(screen.getByText('Skill')).toBeInTheDocument();

    // source tabs：系统预置 / 我的上传 / 网络资源 / P2P 共享（P4 Task 4 启用）
    expect(screen.getByText('系统预置')).toBeInTheDocument();
    expect(screen.getByText('我的上传')).toBeInTheDocument();
    expect(screen.getByText('网络资源')).toBeInTheDocument();
    expect(screen.getByText('P2P 共享')).toBeInTheDocument();

    // 「全部」在 type 和 source 两行都出现 → 2 个
    expect(screen.getAllByText('全部')).toHaveLength(2);
  });

  it('点击 P2P 共享 tab → filter={ source: "p2p" } 下发', async () => {
    resourceList.mockResolvedValue([]);
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalled());

    fireEvent.click(screen.getByText('P2P 共享'));
    await waitFor(() => {
      expect(resourceList).toHaveBeenLastCalledWith({ source: 'p2p' });
    });
  });

  it('点击 type tab 与 source tab 触发 ipc.resource.list，filter 为两者 AND', async () => {
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalled());

    // 初始 filter = {}
    expect(resourceList).toHaveBeenLastCalledWith({});

    // 点击 Agent → filter = { type: 'agent' }
    fireEvent.click(screen.getByText('Agent'));
    await waitFor(() => {
      expect(resourceList).toHaveBeenLastCalledWith({ type: 'agent' });
    });

    // 点击 我的上传 → filter = { type: 'agent', source: 'custom' }（AND）
    fireEvent.click(screen.getByText('我的上传'));
    await waitFor(() => {
      expect(resourceList).toHaveBeenLastCalledWith({
        type: 'agent',
        source: 'custom',
      });
    });
  });

  it('搜索框输入关键词后，前端过滤主网格（无新 IPC）', async () => {
    resourceList.mockResolvedValue([
      baseItem({ id: 'a', name: 'Alpha Search', description: 'first agent' }),
      baseItem({ id: 'b', name: 'Beta Tools', description: 'second mcp', type: 'mcp' }),
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('Alpha Search')).toBeInTheDocument());
    expect(screen.getByText('Beta Tools')).toBeInTheDocument();

    const initialCallCount = resourceList.mock.calls.length;

    // 输入 "alpha" → 仅 Alpha Search 可见
    fireEvent.change(screen.getByPlaceholderText(/搜索/), {
      target: { value: 'alpha' },
    });

    expect(screen.getByText('Alpha Search')).toBeInTheDocument();
    expect(screen.queryByText('Beta Tools')).not.toBeInTheDocument();

    // 搜索是前端 in-memory，不应触发新的 ipc.resource.list
    expect(resourceList.mock.calls.length).toBe(initialCallCount);
  });

  it('点击卡片 → 右侧详情面板滑出（item.name 在卡片和详情都出现）', async () => {
    resourceList.mockResolvedValue([
      baseItem({ id: 'a', name: '可点击项', description: '描述' }),
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('可点击项')).toBeInTheDocument());

    // 点击卡片
    fireEvent.click(screen.getByText('可点击项'));

    // 详情面板出现——item.name 在卡片与详情头部都出现 → 2 处
    await waitFor(() => {
      expect(screen.getAllByText('可点击项')).toHaveLength(2);
    });
  });

  it('点删除按钮 → ipc.resource.delete(id) + ipc.resource.list 再次刷新', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        id: 'custom-mcp-github',
        source: 'custom',
        type: 'mcp',
        slug: 'github',
        name: 'GitHub',
        description: 'mcp server',
        installed: true,
        removable: true,
      }),
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('GitHub')).toBeInTheDocument());

    const initialCallCount = resourceList.mock.calls.length;

    // ResourceCard 渲染的删除按钮 aria-label = `删除 ${name}`
    fireEvent.click(screen.getByLabelText(/删除 GitHub/));

    await waitFor(() => {
      expect(resourceDelete).toHaveBeenCalledWith('custom-mcp-github');
    });
    // 刷新触发新一轮 list
    await waitFor(() => {
      expect(resourceList.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('点 + 添加资源 → 弹出三类下拉菜单', async () => {
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalled());

    // 初始折叠
    expect(screen.queryByText(/创建自定义 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/添加 MCP Server/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上传 Skill 包/)).not.toBeInTheDocument();

    // 点 + 添加资源 ▼
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));

    // 三项均出现
    expect(screen.getByText(/创建自定义 Agent/)).toBeInTheDocument();
    expect(screen.getByText(/添加 MCP Server/)).toBeInTheDocument();
    expect(screen.getByText(/上传 Skill 包/)).toBeInTheDocument();
  });

  it('RegisterMcpDialog 提交 onSuccess → 触发 ipc.resource.list 再次刷新', async () => {
    render(<ResourceLibraryView />);
    await waitFor(() => expect(resourceList).toHaveBeenCalledTimes(1));

    // 打开 + 菜单 → 点 MCP
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));
    fireEvent.click(screen.getByText(/添加 MCP Server/));

    // 弹窗出现
    expect(screen.getByText('注册自定义 MCP server')).toBeInTheDocument();

    // 填表 + 提交
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: 'new-mcp' },
    });
    fireEvent.change(screen.getByLabelText('命令'), {
      target: { value: 'cmd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    // onSuccess → load() 刷新
    await waitFor(() => {
      expect(resourceList).toHaveBeenCalledTimes(2);
    });
  });

  it('详情面板 × 关闭按钮 → 面板收起（item.name 只剩卡片一处）', async () => {
    resourceList.mockResolvedValue([
      baseItem({ id: 'a', name: '可关闭项', description: '描述' }),
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('可关闭项')).toBeInTheDocument());

    // 选中
    fireEvent.click(screen.getByText('可关闭项'));
    await waitFor(() => {
      expect(screen.getAllByText('可关闭项')).toHaveLength(2);
    });

    // 点 × 关闭详情
    fireEvent.click(screen.getByRole('button', { name: '×' }));

    // 仅卡片一处
    await waitFor(() => {
      expect(screen.getAllByText('可关闭项')).toHaveLength(1);
    });
  });

  it('install 成功 → 绿色 installNotice 横幅（一次性），filter 切换即清掉', async () => {
    // 第一次 list 返回空（让卡片区有「+ 添加资源」之外的安装入口 = P2P 共享源）
    resourceList.mockResolvedValue([
      baseItem({
        id: 'p2p-agent-x1y2z3w4-research-helper',
        source: 'p2p',
        slug: 'research-helper',
        name: '远端研究助手',
        description: '远端共享',
        installed: false,
        installable: true,
        removable: false,
      }),
    ]);
    // install 走 resource.install(id) → 成功 → list 再调一次（refresh）
    resourceInstall.mockResolvedValue(undefined);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('远端研究助手')).toBeInTheDocument());

    // 点安装按钮（卡片按钮文案 = 安装）
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    // 成功横幅出现
    await waitFor(() => {
      expect(screen.getByTestId('install-notice')).toHaveTextContent('已导入至「我的上传」');
    });

    // 切换 source tab → installNotice 应被清掉
    fireEvent.click(screen.getByText('系统预置'));
    await waitFor(() => {
      expect(screen.queryByTestId('install-notice')).not.toBeInTheDocument();
    });
  });

  it('install 失败（rejected IPC）→ 主网格区显示红色错误横幅（不被吞成 unhandled rejection）', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        id: 'p2p-agent-x1y2z3w4-gone',
        source: 'p2p',
        slug: 'gone',
        name: '离线资源',
        description: '不可达',
        installed: false,
        installable: true,
        removable: false,
      }),
    ]);
    // 模拟 p2p 离线 / not-found / 超时：handler reject 抛错
    resourceInstall.mockRejectedValueOnce(new Error('对端节点可能已离线'));

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('离线资源')).toBeInTheDocument());

    // 点安装按钮——不应抛 unhandled rejection
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    // 错误横幅出现：主网格区显示「导入失败：...」
    await waitFor(() => {
      expect(screen.getByText(/导入失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/导入失败/)).toHaveTextContent('对端节点可能已离线');
    // installNotice 不应同时出现（错误应清掉陈旧成功提示）
    expect(screen.queryByTestId('install-notice')).not.toBeInTheDocument();
  });
});
