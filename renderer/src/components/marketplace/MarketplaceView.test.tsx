// renderer/src/components/marketplace/MarketplaceView.test.tsx
//
// v1.6 Task 15：MarketplaceView 顶部「+ 添加 MCP / + 上传 Skill」按钮 +
// 底部自定义资源管理区（折叠 details，列 listRegistered + listInstalled，custom 可删）。
//
// 行为约定：
//   - 顶部 header 在「Marketplace」标题与搜索框之间新增两个 Button：
//       「+ 添加 MCP」  → setRegisterMcpOpen(true) → 渲染 RegisterMcpDialog
//       「+ 上传 Skill」 → setUploadSkillOpen(true) → 渲染 UploadSkillDialog
//   - 弹窗 onSuccess（用户提交成功）→ 刷新 catalog + listRegistered + listInstalled（三者并行）
//   - 弹窗 onClose（取消或成功后）→ 仅关闭弹窗
//   - 底部 details（默认折叠，但 DOM 仍渲染）：
//       MCP 区：列出 ipc.mcp.listRegistered() 结果，source==='custom' 有「删除」按钮
//               → confirm → ipc.mcp.deleteRegistered(name) → 刷新
//       Skill 区：列出 ipc.skill.listInstalled() 结果，source==='custom' 有「删除」按钮
//                → confirm → ipc.skill.deleteCustom(slug) → 刷新
//       marketplace / builtin 项展示但无删除按钮
//
// Mock 策略：window.api 桩（marketplace + mcp + skill 全 surface）+ useMarketplaceStore.reset() 隔离。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarketplaceView } from './MarketplaceView';
import { useMarketplaceStore } from '../../stores/marketplace.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type {
  MarketplaceCatalog,
  RegisteredMcp,
  InstalledSkill,
  InstalledPackage,
  Workspace,
} from '../../ipc/types';

// ---- mock IPC 桩 ----
const getCatalog = vi.fn();
const listInstalledPackages = vi.fn();
const marketplaceInstall = vi.fn();
const marketplaceUninstall = vi.fn();
const marketplaceSearch = vi.fn();
const mcpRegister = vi.fn();
const mcpStart = vi.fn();
const listRegisteredMcps = vi.fn();
const deleteRegisteredMcp = vi.fn();
const listInstalledSkills = vi.fn();
const deleteCustomSkill = vi.fn();
const skillUploadZip = vi.fn();

const mockApi = {
  marketplace: {
    getCatalog,
    listInstalled: listInstalledPackages,
    install: marketplaceInstall,
    uninstall: marketplaceUninstall,
    search: marketplaceSearch,
  },
  mcp: {
    register: mcpRegister,
    start: mcpStart,
    listRegistered: listRegisteredMcps,
    deleteRegistered: deleteRegisteredMcp,
  },
  skill: {
    listInstalled: listInstalledSkills,
    uploadZip: skillUploadZip,
    deleteCustom: deleteCustomSkill,
  },
};

const EMPTY_CATALOG: MarketplaceCatalog = {
  version: '1',
  updatedAt: '',
  items: [],
};

const WS: Workspace = {
  id: 'ws-active',
  name: '当前工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  matrixSpaceId: '!space:server',
  teamRoomId: '!team:server',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

beforeEach(() => {
  // 重置所有 IPC 桩 + 设默认返回值
  [
    getCatalog,
    listInstalledPackages,
    marketplaceInstall,
    marketplaceUninstall,
    marketplaceSearch,
    mcpRegister,
    mcpStart,
    listRegisteredMcps,
    deleteRegisteredMcp,
    listInstalledSkills,
    deleteCustomSkill,
    skillUploadZip,
  ].forEach((fn) => fn.mockReset());

  getCatalog.mockResolvedValue(EMPTY_CATALOG);
  listInstalledPackages.mockResolvedValue([] as InstalledPackage[]);
  listRegisteredMcps.mockResolvedValue([] as RegisteredMcp[]);
  listInstalledSkills.mockResolvedValue([] as InstalledSkill[]);
  deleteRegisteredMcp.mockResolvedValue(undefined);
  deleteCustomSkill.mockResolvedValue(undefined);
  mcpRegister.mockResolvedValue(undefined);
  mcpStart.mockResolvedValue(undefined);
  skillUploadZip.mockResolvedValue({ slug: 'x', description: '' });

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api =
    mockApi;

  // 隔离 store 状态（避免跨用例污染）
  useMarketplaceStore.getState().reset();
  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-active',
    loading: false,
    error: null,
  });

  // confirm 默认同意（删除按钮测试可覆盖）
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('MarketplaceView — 顶部按钮 + 自定义资源管理区', () => {
  it('渲染顶部「+ 添加 MCP」「+ 上传 Skill」按钮', async () => {
    render(<MarketplaceView />);
    await waitFor(() => expect(getCatalog).toHaveBeenCalled());
    expect(
      screen.getByRole('button', { name: '+ 添加 MCP' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '+ 上传 Skill' }),
    ).toBeInTheDocument();
  });

  it('点击「+ 添加 MCP」打开 RegisterMcpDialog（弹窗标题出现）', async () => {
    render(<MarketplaceView />);
    await waitFor(() => expect(getCatalog).toHaveBeenCalled());
    expect(
      screen.queryByText('注册自定义 MCP server'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ 添加 MCP' }));
    expect(
      screen.getByText('注册自定义 MCP server'),
    ).toBeInTheDocument();
  });

  it('点击「+ 上传 Skill」打开 UploadSkillDialog（弹窗标题出现）', async () => {
    render(<MarketplaceView />);
    await waitFor(() => expect(getCatalog).toHaveBeenCalled());
    expect(screen.queryByText('上传自定义 Skill')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ 上传 Skill' }));
    expect(screen.getByText('上传自定义 Skill')).toBeInTheDocument();
  });

  it('自定义资源区显示已注册 MCP 列表（含 source 标识）', async () => {
    const mcps: RegisteredMcp[] = [
      {
        id: '1',
        name: 'github',
        version: '1.0',
        command: 'npx',
        args: [],
        source: 'custom',
        installedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: '2',
        name: 'official-mcp',
        version: '1.0',
        command: 'x',
        args: [],
        source: 'marketplace',
        installedAt: '2026-01-02T00:00:00Z',
      },
    ];
    listRegisteredMcps.mockResolvedValueOnce(mcps);
    render(<MarketplaceView />);
    await waitFor(() => {
      expect(screen.getByText(/github/)).toBeInTheDocument();
    });
    expect(screen.getByText(/official-mcp/)).toBeInTheDocument();
  });

  it('custom MCP 项有删除按钮，点击触发 ipc.mcp.deleteRegistered(name)', async () => {
    const mcps: RegisteredMcp[] = [
      {
        id: '1',
        name: 'github',
        version: '1.0',
        command: 'npx',
        args: [],
        source: 'custom',
        installedAt: '',
      },
    ];
    listRegisteredMcps.mockResolvedValueOnce(mcps);
    render(<MarketplaceView />);
    await waitFor(() => expect(screen.getByText(/github/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '删除 MCP github' }));

    await waitFor(() => {
      expect(deleteRegisteredMcp).toHaveBeenCalledWith('github');
    });
  });

  it('marketplace MCP 项不可删除（无删除按钮）', async () => {
    const mcps: RegisteredMcp[] = [
      {
        id: '1',
        name: 'official-mcp',
        version: '1.0',
        command: 'x',
        args: [],
        source: 'marketplace',
        installedAt: '',
      },
    ];
    listRegisteredMcps.mockResolvedValueOnce(mcps);
    render(<MarketplaceView />);
    await waitFor(() =>
      expect(screen.getByText(/official-mcp/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: '删除 MCP official-mcp' }),
    ).not.toBeInTheDocument();
  });

  it('custom Skill 项有删除按钮，点击触发 ipc.skill.deleteCustom(slug)', async () => {
    const skills: InstalledSkill[] = [
      {
        slug: 'my-skill',
        name: 'My Skill',
        description: '',
        source: 'custom',
        installedAt: '',
      },
    ];
    listInstalledSkills.mockResolvedValueOnce(skills);
    render(<MarketplaceView />);
    await waitFor(() =>
      expect(screen.getByText(/my-skill/)).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole('button', { name: '删除 Skill my-skill' }),
    );

    await waitFor(() => {
      expect(deleteCustomSkill).toHaveBeenCalledWith('my-skill');
    });
  });

  it('builtin / marketplace Skill 项不可删除（无删除按钮）', async () => {
    const skills: InstalledSkill[] = [
      {
        slug: 'builtin1',
        name: 'Builtin',
        description: '',
        source: 'builtin',
        installedAt: null,
      },
      {
        slug: 'mp1',
        name: 'Marketplace',
        description: '',
        source: 'marketplace',
        installedAt: '',
      },
    ];
    listInstalledSkills.mockResolvedValueOnce(skills);
    render(<MarketplaceView />);
    await waitFor(() =>
      expect(screen.getByText(/builtin1/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: '删除 Skill builtin1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '删除 Skill mp1' }),
    ).not.toBeInTheDocument();
  });

  it('RegisterMcpDialog 提交成功 → onSuccess 触发 catalog + listRegistered + listInstalled 三重刷新', async () => {
    render(<MarketplaceView />);
    await waitFor(() => expect(getCatalog).toHaveBeenCalled());
    // 初始挂载调用一次
    expect(listRegisteredMcps).toHaveBeenCalledTimes(1);
    expect(listInstalledSkills).toHaveBeenCalledTimes(1);

    // 打开弹窗 → 填表 → 提交
    fireEvent.click(screen.getByRole('button', { name: '+ 添加 MCP' }));
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: 'new-mcp' },
    });
    fireEvent.change(screen.getByLabelText('命令'), {
      target: { value: 'cmd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    // onSuccess 应触发 catalog + 自定义资源双刷新
    await waitFor(() => {
      expect(getCatalog).toHaveBeenCalledTimes(2);
    });
    expect(listRegisteredMcps).toHaveBeenCalledTimes(2);
    expect(listInstalledSkills).toHaveBeenCalledTimes(2);
  });

  it('UploadSkillDialog 提交成功 → onSuccess 同样触发三重刷新', async () => {
    render(<MarketplaceView />);
    await waitFor(() => expect(getCatalog).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '+ 上传 Skill' }));
    // 模拟选 zip + 上传
    const input = screen.getByLabelText('选择文件') as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'x.zip', {
      type: 'application/zip',
    });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(skillUploadZip).toHaveBeenCalled();
    });
    // onSuccess 触发刷新（catalog + listRegistered + listInstalled 各被调第二次）
    await waitFor(() => {
      expect(getCatalog).toHaveBeenCalledTimes(2);
    });
    expect(listRegisteredMcps).toHaveBeenCalledTimes(2);
    expect(listInstalledSkills).toHaveBeenCalledTimes(2);
  });

  it('删除 MCP 后触发 listRegistered 刷新（更新列表）', async () => {
    // 第一次返回 1 项；删除后第二次返回空列表
    listRegisteredMcps
      .mockResolvedValueOnce([
        {
          id: '1',
          name: 'github',
          version: '1.0',
          command: 'npx',
          args: [],
          source: 'custom',
          installedAt: '',
        },
      ])
      .mockResolvedValueOnce([]);

    render(<MarketplaceView />);
    await waitFor(() => expect(screen.getByText(/github/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '删除 MCP github' }));

    await waitFor(() => {
      expect(deleteRegisteredMcp).toHaveBeenCalledWith('github');
    });
    // 删除后 listRegistered 被再次调用
    await waitFor(() => {
      expect(listRegisteredMcps).toHaveBeenCalledTimes(2);
    });
  });

  it('取消 confirm → 不触发删除', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    listRegisteredMcps.mockResolvedValueOnce([
      {
        id: '1',
        name: 'github',
        version: '1.0',
        command: 'npx',
        args: [],
        source: 'custom',
        installedAt: '',
      },
    ]);
    render(<MarketplaceView />);
    await waitFor(() => expect(screen.getByText(/github/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '删除 MCP github' }));

    // confirm 返回 false → deleteRegistered 不被调用
    expect(deleteRegisteredMcp).not.toHaveBeenCalled();
  });
});
