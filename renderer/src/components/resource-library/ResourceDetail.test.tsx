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

/** 测试用基线 AgentDefinition，默认为 custom 源 */
const baseDef = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-uuid-1',
  name: 'Researcher',
  slug: 'researcher',
  version: '1.0.0',
  runtime: 'local',
  systemPrompt: '你是一个严谨的研究员，逐条给出出处。',
  defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
  source: 'custom',
  description: '',
  iconEmoji: '',
  workspaceId: null,
  modelProviderId: 'openai',
  modelName: 'gpt-4o',
  defaultMcps: [],
  defaultSkills: [],
  ...overrides,
});

// window.api 属性安装（ipc.client 是真实 Proxy，只装组件触达的 agent 命名空间）
const agentListMock = vi.fn();

const mockApi = {
  agent: {
    list: agentListMock,
  },
};

beforeEach(() => {
  agentListMock.mockReset();
  // 默认空库：custom agent 反查不到 def → 不渲染定义预览（错误路径基线）
  agentListMock.mockResolvedValue([] as AgentDefinition[]);
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
    expect(screen.getByText('verified')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/git-workflow.zip')).toBeInTheDocument();
    const installBtn = screen.getByRole('button', { name: /安装/ });
    fireEvent.click(installBtn);
    expect(onInstall).toHaveBeenCalledWith('marketplace-skill-git-workflow');
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
    expect(screen.getByText('community')).toBeInTheDocument();
  });

  it('p2p: 显示来源节点 + 「导入」按钮（走 onInstall；P4 Task 4）', () => {
    const onInstall = vi.fn();
    const item = baseItem({
      id: 'p2p-agent-a1b2c3d4-helper',
      source: 'p2p',
      type: 'agent',
      name: '远端助手',
      description: '来自对端节点的 agent',
      installed: false,
      installable: true,
      removable: false,
      p2p: { peerId: 'a1b2c3d4e5f6', peerName: '对端A' },
    });
    render(<ResourceDetail item={item} onClose={() => {}} onInstall={onInstall} />);
    // 来源节点展示 peerName
    expect(screen.getByText('对端A')).toBeInTheDocument();
    // p2p 项按钮文案为「导入」（区别于 marketplace 的「安装」）
    const importBtn = screen.getByRole('button', { name: /导入/ });
    fireEvent.click(importBtn);
    expect(onInstall).toHaveBeenCalledWith('p2p-agent-a1b2c3d4-helper');
    // 不可删除（removable=false）→ 无删除按钮
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });

  it('builtin mcp (removable=false): 不显示删除按钮，保留「已安装」静态标记', () => {
    const onDelete = vi.fn();
    const item = baseItem({ id: 'builtin-mcp-foo', type: 'mcp', removable: false });
    render(<ResourceDetail item={item} onClose={() => {}} onDelete={onDelete} />);
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });

  it('custom (removable=true): 显示删除按钮并触发回调', () => {
    const onDelete = vi.fn();
    const item = baseItem({
      id: 'custom-mcp-github',
      source: 'custom',
      removable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onDelete={onDelete} />);
    const delBtn = screen.getByRole('button', { name: /删除/ });
    fireEvent.click(delBtn);
    expect(onDelete).toHaveBeenCalledWith('custom-mcp-github');
  });

  it('onClose 触发回调', () => {
    const onClose = vi.fn();
    render(<ResourceDetail item={baseItem()} onClose={onClose} />);
    // 头部关闭按钮（X 图标，aria-label 兜底）点击触发 onClose
    const closeBtn = screen.getByRole('button', { name: '关闭详情' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ResourceDetail - custom agent 编辑按钮', () => {
  it('custom agent（installed）: 显示「编辑」按钮并触发 onEdit 回调', () => {
    const onEdit = vi.fn();
    const item = baseItem({
      id: 'custom-agent-researcher',
      source: 'custom',
      type: 'agent',
      name: 'Researcher',
      installed: true,
      removable: true,
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'sha256:abc' },
    });
    render(<ResourceDetail item={item} onClose={() => {}} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith('custom-agent-researcher');
  });

  it('builtin agent: 不显示「编辑」按钮（定义不可改）', () => {
    render(<ResourceDetail item={baseItem()} onClose={() => {}} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('custom mcp/skill: 不显示「编辑」按钮', () => {
    const item = baseItem({
      id: 'custom-mcp-github',
      source: 'custom',
      type: 'mcp',
      installed: true,
      removable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });
});

describe('ResourceDetail - 预设 agent 启用/配置（spec 2026-09-22）', () => {
  it('builtin agent 未启用：显示「启用」按钮并触发 onEnable', () => {
    const onEnable = vi.fn();
    const item = baseItem({ builtin: { agentEnabled: false } });
    render(<ResourceDetail item={item} onClose={() => {}} onEnable={onEnable} />);
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    expect(onEnable).toHaveBeenCalledWith('builtin-agent-pm');
    // 未启用不再显示误导性的「已安装」标记
    expect(screen.queryByText(/已安装/)).not.toBeInTheDocument();
  });

  it('builtin agent 已启用：显示「配置」按钮 + 「已启用」标记，无「启用」', () => {
    const onConfigure = vi.fn();
    const item = baseItem({ builtin: { agentEnabled: true } });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={onConfigure} />);
    expect(screen.getByText(/已启用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('builtin-agent-pm');
    expect(screen.queryByRole('button', { name: '启用' })).not.toBeInTheDocument();
  });

  it('marketplace agent 已安装：显示「配置」按钮', () => {
    const onConfigure = vi.fn();
    const item = baseItem({
      id: 'marketplace-agent-coder', source: 'marketplace', installed: true,
      installable: false, removable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={onConfigure} />);
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('marketplace-agent-coder');
  });

  it('marketplace agent 未安装：无「配置」按钮（先安装）', () => {
    const item = baseItem({
      id: 'marketplace-agent-coder', source: 'marketplace', installed: false,
      installable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });
});

describe('ResourceDetail - 三段式结构 + custom agent 定义预览（Task 15）', () => {
  it('三段式标签齐全：状态 / 配置预览 / 元数据', () => {
    const item = baseItem({
      id: 'custom-mcp-github',
      source: 'custom',
      type: 'mcp',
      name: 'GitHub MCP',
      description: '自定义注册',
      custom: {
        installedAt: '2026-08-12T03:00:00.000Z',
        mcpConfig: { command: 'npx', args: ['-y', 'server-github'], env: {} },
      },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(screen.getByText('状态')).toBeInTheDocument();
    expect(screen.getByText('配置预览')).toBeInTheDocument();
    expect(screen.getByText('元数据')).toBeInTheDocument();
  });

  it('custom agent 反查 def 并展示 YAML 预览（slug=def.id 口径，非 def.slug）', async () => {
    // def.slug 是 researcher 而资源 slug 是 def.id（UUID）——口径错成 def.slug 即反查失败
    agentListMock.mockResolvedValue([baseDef({ id: 'def-uuid-1', slug: 'researcher', name: 'Researcher' })]);
    const item = baseItem({
      id: 'custom-agent-researcher',
      source: 'custom',
      type: 'agent',
      name: 'Researcher',
      description: '自定义 agent',
      slug: 'def-uuid-1',
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'sha256:abc' },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(await screen.findByText(/systemPrompt:/)).toBeInTheDocument();
    // 预览头部为 def 名 + def.slug（区别于资源 slug 的 UUID）
    expect(screen.getByText(/# Researcher \(researcher\)/)).toBeInTheDocument();
    expect(screen.getByText(/model: openai \/ gpt-4o/)).toBeInTheDocument();
  });

  it('custom agent 反查不到 def：不渲染定义预览', () => {
    const item = baseItem({
      id: 'custom-agent-researcher',
      source: 'custom',
      type: 'agent',
      name: 'Researcher',
      description: '自定义 agent',
      slug: 'pm',
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'sha256:abc' },
    });
    render(<ResourceDetail item={item} onClose={vi.fn()} />);
    expect(screen.queryByText(/systemPrompt:/)).not.toBeInTheDocument();
  });
});

// ── P2.2 Task 7：远程 MCP 配置按钮（spec §6.1）──────────────────────────
// 显示条件：type=mcp && installed && custom.transport==='streamable_http'
// 且 onEditMcpConfig prop 注入；回调透传整个 item（View 层按 item.slug 接线弹窗）。
describe('ResourceDetail - 远程 MCP 配置按钮（P2.2 Task 7）', () => {
  const remoteMcp = (overrides: Partial<ResourceItem> = {}): ResourceItem =>
    baseItem({
      id: 'smithery-mcp-context7',
      source: 'smithery',
      type: 'mcp',
      name: 'Context7',
      description: '文档上下文 MCP',
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: '2026-09-23T00:00:00.000Z', transport: 'streamable_http' },
      ...overrides,
    });

  it('streamable_http 已装条目：显示「配置」按钮，回调透传整个 item', () => {
    const onEditMcpConfig = vi.fn();
    const item = remoteMcp();
    render(<ResourceDetail item={item} onClose={() => {}} onEditMcpConfig={onEditMcpConfig} />);
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onEditMcpConfig).toHaveBeenCalledWith(item);
  });

  it('stdio 条目：不显示「配置」按钮（编辑仅远程，D1）', () => {
    render(
      <ResourceDetail
        item={remoteMcp({ custom: { installedAt: '2026-09-23T00:00:00.000Z', transport: 'stdio' } })}
        onClose={() => {}}
        onEditMcpConfig={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });

  it('custom.transport 缺省：不显示「配置」按钮', () => {
    render(
      <ResourceDetail
        item={remoteMcp({ custom: { installedAt: '2026-09-23T00:00:00.000Z' } })}
        onClose={() => {}}
        onEditMcpConfig={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });

  it('未安装条目：不显示「配置」按钮', () => {
    render(
      <ResourceDetail
        item={remoteMcp({ installed: false, installable: true })}
        onClose={() => {}}
        onEditMcpConfig={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });

  it('prop 缺省（onEditMcpConfig 未注入）：不显示「配置」按钮', () => {
    render(<ResourceDetail item={remoteMcp()} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });
});
