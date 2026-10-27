// renderer/src/components/resource-library/ResourceDetail.test.tsx
// ResourceDetail 行为：右侧滑出详情面板，按 source 分支显示不同字段：
//   - builtin/marketplace（含 marketplace 元数据）: README + author + 校验状态 + downloadUrl
//   - custom MCP: command + args + env(KEY=*** 隐藏值) + installedAt
//   - custom Skill: frontmatter + installedAt
//   - custom Agent: systemPromptHash + installedAt + 定义预览（YAML-ish，反查 def）
// 底部按钮区按 installed / installable / removable 三态切换。
//
// v2.1 Task 15：内容区三段式（状态/配置预览/元数据）+ custom agent 定义预览。
// Mock 方式遵循 TypePageShell.test.tsx 既有形态：不 vi.mock ipc/client 模块，而是在
// 真实 jsdom window 上装 window.api 属性——ipc.client 是真实 Proxy，组件经
// ipc.agent.list 反查 custom agent def 走真通道（momo-test-rules：mock 收窄到 IPC 边界）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceDetail } from './ResourceDetail';
import type { AgentDefinition, ResourceItem } from '../../ipc/types';
import { useUiStore } from '../../stores/ui.store';

/** 测试用基线 item，默认为 builtin agent */
const baseItem = (overrides: Partial<ResourceItem> = {}): ResourceItem => ({
  id: 'builtin-agent-pm',
  type: 'agent',
  source: 'builtin',
  slug: 'pm',
  name: '项目经理',
  description: '协调子 agent',
  installed: true,
  installable: false,
  removable: false,
  ...overrides,
});

// window.api 属性安装（ipc.client 是真实 Proxy，装组件触达的 agent/resource 命名空间）
const agentListMock = vi.fn();
// 2026-10-08 能力预览：默认给最小可用形状（builtin agent 面板挂载即拉，老用例无感）
const previewBuiltinPresetMock = vi.fn();

const pluginGetDetailMock = vi.fn();

const providerListMock = vi.fn();

const mockApi = {
  agent: {
    list: agentListMock,
  },
  resource: {
    previewBuiltinPreset: previewBuiltinPresetMock,
  },
  plugin: {
    getDetail: pluginGetDetailMock,
  },
  provider: {
    list: providerListMock,
  },
};

beforeEach(() => {
  pluginGetDetailMock.mockReset();
  agentListMock.mockReset();
  // 默认空库：custom agent 反查不到 def → 不渲染定义预览（错误路径基线）
  agentListMock.mockResolvedValue([] as AgentDefinition[]);
  previewBuiltinPresetMock.mockReset().mockResolvedValue({
    slug: 'pm', name: '项目经理', iconEmoji: '👔', description: '',
    systemPrompt: '协调', tools: ['read_file'], mcps: [], skills: [],
  });
  providerListMock.mockReset().mockResolvedValue([]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('ResourceDetail - 按 source 分支显示', () => {
  it('builtin（含 catalog 元数据）: 显示 README + author', () => {
    const item = baseItem({
      marketplace: {
        author: 'momo-studio',
        readme: '# PM\n协调子 agent 的内置角色',
        downloadUrl: '',
        checksum: '',
        verificationStatus: 'official',
        tags: ['coordination'],
        category: 'agent',
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    expect(screen.getByText('momo-studio')).toBeInTheDocument();
    expect(screen.getByText(/协调子 agent 的内置角色/)).toBeInTheDocument();
    // README Markdown 渲染（组③ B7）：'# PM' 解析为 h1，无裸 # 直出
    expect(screen.getByRole('heading', { level: 1, name: 'PM' })).toBeInTheDocument();
    expect(screen.queryByText(/^# PM/)).toBeNull();
  });

  it('marketplace: 显示 README + author + 校验状态 + downloadUrl + 安装按钮', () => {
    const onInstall = vi.fn();
    const item = baseItem({
      id: 'marketplace-skill-git-workflow',
      source: 'marketplace',
      type: 'skill',
      name: 'Git Workflow',
      description: 'Git 操作技能包',
      installed: false,
      installable: true,
      marketplace: {
        author: 'open-creator',
        readme: '# git-workflow\n规范化 commit 流程',
        downloadUrl: 'https://example.com/git-workflow.zip',
        checksum: 'abc123',
        verificationStatus: 'verified',
        tags: ['git'],
        category: 'skill',
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} onInstall={onInstall} />);
    expect(screen.getByText('open-creator')).toBeInTheDocument();
    expect(screen.getByText(/规范化 commit 流程/)).toBeInTheDocument();
    expect(screen.getByText('已验证')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/git-workflow.zip')).toBeInTheDocument();
    const installBtn = screen.getByRole('button', { name: /安装/ });
    fireEvent.click(installBtn);
    expect(onInstall).toHaveBeenCalledWith('marketplace-skill-git-workflow');
  });

  it('校验状态本地化徽章：official→官方 / unverified→未验证（走查 A4：禁原始枚举直出）', () => {
    const mkVerifiedItem = (status: 'official' | 'unverified'): ResourceItem =>
      baseItem({
        marketplace: {
          author: 'momo-studio',
          readme: 'r',
          downloadUrl: '',
          checksum: '',
          verificationStatus: status,
          tags: [],
          category: 'agent',
        },
      });
    const { unmount } = render(<ResourceDetail item={mkVerifiedItem('official')} onClose={() => {}} />);
    expect(screen.getByText('官方')).toBeInTheDocument();
    expect(screen.queryByText('official')).toBeNull();
    unmount();
    render(<ResourceDetail item={mkVerifiedItem('unverified')} onClose={() => {}} />);
    expect(screen.getByText('未验证')).toBeInTheDocument();
    expect(screen.queryByText('unverified')).toBeNull();
  });

  it('custom MCP: 显示命令 + 参数 + 环境变量(KEY=***) + 安装时间', () => {
    const item = baseItem({
      id: 'custom-mcp-github',
      source: 'custom',
      type: 'mcp',
      name: 'GitHub MCP',
      description: '自定义注册',
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: '2026-08-12T03:00:00.000Z',
        mcpConfig: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_secret_token', API_KEY: 'sk-abc123=def' },
        },
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    expect(screen.getByText('npx')).toBeInTheDocument();
    expect(screen.getByText('-y @modelcontextprotocol/server-github')).toBeInTheDocument();
    // 环境变量：KEY=*** 格式，值必须被隐藏
    expect(screen.getByText('GITHUB_TOKEN=***')).toBeInTheDocument();
    expect(screen.getByText('API_KEY=***')).toBeInTheDocument();
    // 关键安全断言：原始 token / key 不得出现在 DOM 中
    expect(screen.queryByText('ghp_secret_token')).not.toBeInTheDocument();
    expect(screen.queryByText('sk-abc123=def')).not.toBeInTheDocument();
    // 值含 = 时不截断 KEY=*** 格式（KEY 部分完整）
    expect(screen.getByText('API_KEY=***')).toBeInTheDocument();
  });

  it('custom Skill: 显示 frontmatter + 安装时间', () => {
    const item = baseItem({
      id: 'custom-skill-my-helper',
      source: 'custom',
      type: 'skill',
      name: 'My Helper',
      description: '上传的 zip 包',
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: '2026-08-12T03:00:00.000Z',
        skillFrontmatter: { name: 'my-helper', version: '1.0.0' },
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    expect(screen.getByText(/my-helper/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument();
  });

  it('custom Agent: 显示 system prompt hash + 安装时间', () => {
    const item = baseItem({
      id: 'custom-agent-researcher',
      source: 'custom',
      type: 'agent',
      name: 'Researcher',
      description: '自定义 agent',
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: '2026-08-12T03:00:00.000Z',
        agentSystemPromptHash: 'sha256:abcdef1234567890',
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    expect(screen.getByText('sha256:abcdef1234567890')).toBeInTheDocument();
  });

  // P2 终审 Important-1 回归锁（spec §4.4）：hub 源须复用 marketplace 元数据段
  it('smithery（含 marketplace 元数据）: 显示 README + author + 校验状态', () => {
    const item = baseItem({
      id: 'smithery-mcp-github',
      source: 'smithery',
      type: 'mcp',
      name: 'GitHub MCP (Smithery)',
      description: 'Smithery registry 安装项',
      installed: true,
      installable: false,
      removable: true,
      marketplace: {
        author: 'smithery-community',
        readme: '# github\n走 Smithery 注册的 MCP',
        downloadUrl: 'https://smithery.example/server-github',
        checksum: 'def456',
        verificationStatus: 'community',
        tags: ['github'],
        category: 'mcp',
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    expect(screen.getByText('smithery-community')).toBeInTheDocument();
    expect(screen.getByText(/走 Smithery 注册的 MCP/)).toBeInTheDocument();
    expect(screen.getByText('社区')).toBeInTheDocument();
  });

  it('状态段文字行不重复来源词（走查 N3）：类型用中文标签，不带 source 前缀', () => {
    const item = baseItem({
      version: '1.1.0',
      marketplace: {
        author: 'momo-studio',
        readme: 'r',
        downloadUrl: '',
        checksum: '',
        verificationStatus: 'official',
        tags: [],
        category: 'agent',
      },
    });
    render(<ResourceDetail item={item} onClose={() => {}} />);
    // 来源已由 SourceBadge 表达；文字行只报类型 + 版本
    expect(screen.getByText('智能体 · v1.1.0')).toBeInTheDocument();
    expect(screen.queryByText(/系统预置 · agent/)).toBeNull();
  });

});


describe('ResourceDetail - 插件组件清单（spec 2026-10-21 §9②：getDetail 五组分组）', () => {
  function pluginItem(): ResourceItem {
    return baseItem({
      id: 'custom-plugin-cg', type: 'plugin', slug: 'cg',
      plugin: { id: 'cg', state: 'active', devSource: true, sourcePath: '/x', components: ['mcp', 'skills'], enabled: true },
    });
  }

  it('渲染五组：MCP Server / 工具 / Skill / Agent / 其他组件（空组显示「无」）', async () => {
    pluginGetDetailMock.mockResolvedValue({
      pluginId: 'cg',
      mcps: [{ name: 'codegraph' }],
      tools: [{ fullName: 'plugin:codegraph/查询符号', description: '查', pluginName: 'cg' }],
      skills: [{ slug: 'codegraph-usage' }],
      agents: [{ id: 'plugin:codegraph:code-navigator', name: '代码导航员' }],
      panels: [{ panelId: 'main', title: '图谱' }],
      service: true,
      config: true,
    });
    render(<ResourceDetail item={pluginItem()} onClose={vi.fn()} />);
    expect(await screen.findByText('codegraph', { selector: '[data-testid="plugin-cap-mcp"] *' })).toBeTruthy();
    expect(screen.getByTestId('plugin-cap-tool').textContent).toContain('plugin:codegraph/查询符号');
    expect(screen.getByTestId('plugin-cap-skill').textContent).toContain('codegraph-usage');
    expect(screen.getByTestId('plugin-cap-agent').textContent).toContain('代码导航员');
    expect(screen.getByTestId('plugin-cap-other').textContent).toContain('面板');
    expect(screen.getByTestId('plugin-cap-other').textContent).toContain('service');
  });

  it('getDetail 失败 → 内联错误不崩面板（键名 chips 降级不保留——错误文案）', async () => {
    pluginGetDetailMock.mockRejectedValue(new Error('boom'));
    render(<ResourceDetail item={pluginItem()} onClose={vi.fn()} />);
    expect(await screen.findByText(/组件清单加载失败/)).toBeTruthy();
  });
});

describe('ResourceDetail — 详情面板验收缺陷回归锁（2026-10-23 D2/D3/D4/D5）', () => {
  function pluginDetailFixture(): void {
    pluginGetDetailMock.mockResolvedValue({
      pluginId: 'cg',
      mcps: [{ name: 'codegraph' }],
      tools: [],
      skills: [],
      agents: [],
      panels: [],
      service: false,
      config: false,
    });
  }

  it('D2: 元数据节无任何行（dev 源插件无 installedAt、无 marketplace 段）→ 整节隐藏不留空悬标题', () => {
    pluginDetailFixture();
    const item = baseItem({
      id: 'custom-plugin-cg', type: 'plugin', slug: 'cg',
      plugin: { id: 'cg', state: 'active', devSource: true, sourcePath: '/x', components: [], enabled: true },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(screen.queryByText('元数据')).not.toBeInTheDocument();
  });

  it('D2 反向: custom 项有 installedAt → 元数据节保留', () => {
    const item = baseItem({
      source: 'custom', type: 'skill',
      custom: { installedAt: '2026-08-12T03:00:00.000Z' },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(screen.getByText('元数据')).toBeInTheDocument();
  });

  it('D3: 源目录长路径按斜杠断行——含 <wbr> 断点且不逐字符断词（无 break-all）', () => {
    pluginDetailFixture();
    const item = baseItem({
      id: 'custom-plugin-cg', type: 'plugin', slug: 'cg',
      plugin: {
        id: 'cg', state: 'active', devSource: true,
        sourcePath: '/Users/foo/dev/AiProject/plugins/codegraph',
        components: [], enabled: true,
      },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    const code = screen.getByTestId('plugin-source-path');
    expect(code.textContent).toBe('/Users/foo/dev/AiProject/plugins/codegraph');
    expect(code.querySelectorAll('wbr').length).toBeGreaterThanOrEqual(5);
    expect(code.className).not.toContain('break-all');
  });

  it('D4: 定义预览 model 行显示供应商名称，不出现裸 UUID', async () => {
    providerListMock.mockResolvedValue([{
      id: 'prov-uuid-1', name: '智谱 GLM', baseUrl: 'https://a', defaultModel: null,
      isDefault: false, createdAt: '', platform: 'openai' as const, presetKey: null,
    }]);
    agentListMock.mockResolvedValue([{
      id: 'def-1', name: '边界助手', slug: '边界助手', version: '1.0.0', runtime: 'local',
      systemPrompt: '你是边界助手', defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      source: 'custom', description: '', iconEmoji: '🤖', workspaceId: null,
      modelProviderId: 'prov-uuid-1', modelName: 'glm-5.3',
    } as AgentDefinition]);
    const item = baseItem({
      id: 'custom-agent-def-1', source: 'custom', type: 'agent', slug: 'def-1',
      installed: true, removable: true,
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'h' },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(await screen.findByText(/model: 智谱 GLM \/ glm-5\.3/)).toBeInTheDocument();
    expect(screen.queryByText(/prov-uuid-1/)).not.toBeInTheDocument();
  });

  it('D4 错误路径: 供应商列表拉取失败 → UUID 原样直出（不空白、不崩面板）', async () => {
    providerListMock.mockRejectedValue(new Error('IPC 不可用'));
    agentListMock.mockResolvedValue([{
      id: 'def-2', name: '回落助手', slug: '回落助手', version: '1.0.0', runtime: 'local',
      systemPrompt: 'x', defaultTools: [], source: 'custom', description: '',
      iconEmoji: '🤖', workspaceId: null, modelProviderId: 'prov-uuid-2', modelName: 'glm-4.7',
    } as AgentDefinition]);
    const item = baseItem({
      id: 'custom-agent-def-2', source: 'custom', type: 'agent', slug: 'def-2',
      installed: true, removable: true,
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'h' },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(await screen.findByText(/model: prov-uuid-2 \/ glm-4\.7/)).toBeInTheDocument();
  });

  it('D5: mcp 停用态徽标「已停用」（不再「已禁用」）+ 启停按钮文案「停用」', () => {
    const onToggleMcp = vi.fn();
    const item = baseItem({
      source: 'custom', type: 'mcp', installed: true, removable: true,
      mcp: { enabled: false },
      custom: { installedAt: '2026-08-12T03:00:00.000Z', mcpConfig: { command: 'npx', args: [] } },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} onToggleMcp={onToggleMcp} />);
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.queryByText('已禁用')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /启用/ })).toBeInTheDocument();
  });

  it('D5: mcp 启用态启停按钮文案「停用」（不再「禁用」）', () => {
    const onToggleMcp = vi.fn();
    const item = baseItem({
      source: 'custom', type: 'mcp', installed: true, removable: true,
      mcp: { enabled: true },
      custom: { installedAt: '2026-08-12T03:00:00.000Z', mcpConfig: { command: 'npx', args: [] } },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} onToggleMcp={onToggleMcp} />);
    expect(screen.getByRole('button', { name: /停用/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^禁用$/ })).not.toBeInTheDocument();
  });

  it('D5: 插件停用态徽标「已停用」+ 启停按钮「启用」（与卡片/开关措辞同一族）', () => {
    const onTogglePlugin = vi.fn();
    pluginDetailFixture();
    const item = baseItem({
      id: 'custom-plugin-cg', type: 'plugin', slug: 'cg', installed: true,
      plugin: { id: 'cg', state: 'active', devSource: true, sourcePath: null, components: [], enabled: false },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} onTogglePlugin={onTogglePlugin} />);
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.queryByText('已禁用')).not.toBeInTheDocument();
  });
});

describe('ResourceDetail 发布到 hub 入口（M1 Task 14 + M2.2 Task 2：custom 限定 + marketplace 已装 skill + 未接入引导）', () => {
  const noop = (): void => undefined;
  const customAgent = (): ResourceItem =>
    baseItem({
      id: 'custom-agent-def-9', source: 'custom', type: 'agent', slug: 'def-9',
      name: '代码评审员', installed: true, removable: true,
    });

  it('custom 项渲染「发布到 hub」；点击回传整 item', () => {
    const onPublish = vi.fn();
    const item = customAgent();
    render(<ResourceDetail item={item} onClose={noop} onPublishToHub={onPublish} hubEnrolled />);
    fireEvent.click(screen.getByRole('button', { name: /发布到 hub/ }));
    expect(onPublish).toHaveBeenCalledWith(item);
  });

  it('marketplace 已装 skill 渲染「发布到 hub」；点击回传整 item（M2.2 Task 2 开放）', () => {
    const onPublish = vi.fn();
    const item = baseItem({
      id: 'marketplace-skill-superpowers-brainstorm', source: 'marketplace', type: 'skill',
      slug: 'superpowers-brainstorm', name: '头脑风暴', installed: true, removable: true,
      version: '1.4.0',
    });
    render(<ResourceDetail item={item} onClose={noop} onPublishToHub={onPublish} hubEnrolled />);
    fireEvent.click(screen.getByRole('button', { name: /发布到 hub/ }));
    expect(onPublish).toHaveBeenCalledWith(item);
  });

  it('marketplace 已装 skill 未接入：按钮禁用 + 引导条在场（gating 与按钮同源）', () => {
    useUiStore.setState({ activeView: 'im' });
    render(
      <ResourceDetail
        item={baseItem({
          id: 'marketplace-skill-superpowers-brainstorm', source: 'marketplace', type: 'skill',
          slug: 'superpowers-brainstorm', name: '头脑风暴', installed: true, removable: true,
        })}
        onClose={noop} onPublishToHub={vi.fn()} hubEnrolled={false}
      />,
    );
    const btn = screen.getByRole('button', { name: /发布到 hub/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/未接入 momo-hub/)).toBeTruthy();
  });

  it('marketplace 未装 skill：入口与引导条双不渲染（无本地包可打）', () => {
    render(
      <ResourceDetail
        item={baseItem({
          id: 'marketplace-skill-y', source: 'marketplace', type: 'skill', slug: 'y',
          name: '未装技能', installed: false, installable: true, removable: false,
        })}
        onClose={noop} onPublishToHub={vi.fn()} hubEnrolled={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /发布到 hub/ })).toBeNull();
    expect(screen.queryByText(/未接入 momo-hub/)).toBeNull();
  });

  it('marketplace 已装 agent 不渲染发布入口（C3 维持仅 custom）', () => {
    render(
      <ResourceDetail
        item={baseItem({
          id: 'marketplace-agent-y', source: 'marketplace', type: 'agent', slug: 'y',
          name: '市场智能体', installed: true, removable: false,
        })}
        onClose={noop} onPublishToHub={vi.fn()} hubEnrolled
      />,
    );
    expect(screen.queryByRole('button', { name: /发布到 hub/ })).toBeNull();
  });

  it('未接入：按钮禁用 + 引导条「未接入 momo-hub——去设置」；点去设置切 settings 视图', () => {
    useUiStore.setState({ activeView: 'im' });
    render(<ResourceDetail item={customAgent()} onClose={noop} onPublishToHub={vi.fn()} hubEnrolled={false} />);
    const btn = screen.getByRole('button', { name: /发布到 hub/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/未接入 momo-hub/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /去设置/ }));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('已接入：不渲染引导条', () => {
    render(<ResourceDetail item={customAgent()} onClose={noop} onPublishToHub={vi.fn()} hubEnrolled />);
    expect(screen.queryByText(/未接入 momo-hub/)).toBeNull();
  });

  it('非 custom 源（builtin）不渲染发布入口与引导条', () => {
    render(<ResourceDetail item={baseItem({})} onClose={noop} onPublishToHub={vi.fn()} hubEnrolled={false} />);
    expect(screen.queryByRole('button', { name: /发布到 hub/ })).toBeNull();
    expect(screen.queryByText(/未接入 momo-hub/)).toBeNull();
  });
});
