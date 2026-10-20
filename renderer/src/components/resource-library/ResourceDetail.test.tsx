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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceDetail } from './ResourceDetail';
import type { AgentDefinition, BuiltinPresetPreview, ResourceItem } from '../../ipc/types';

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

// window.api 属性安装（ipc.client 是真实 Proxy，装组件触达的 agent/resource 命名空间）
const agentListMock = vi.fn();
// 2026-10-08 能力预览：默认给最小可用形状（builtin agent 面板挂载即拉，老用例无感）
const previewBuiltinPresetMock = vi.fn();

const mockApi = {
  agent: {
    list: agentListMock,
  },
  resource: {
    previewBuiltinPreset: previewBuiltinPresetMock,
  },
};

beforeEach(() => {
  agentListMock.mockReset();
  // 默认空库：custom agent 反查不到 def → 不渲染定义预览（错误路径基线）
  agentListMock.mockResolvedValue([] as AgentDefinition[]);
  previewBuiltinPresetMock.mockReset().mockResolvedValue({
    slug: 'pm', name: '项目经理', iconEmoji: '👔', description: '',
    systemPrompt: '协调', tools: ['read_file'], mcps: [], skills: [],
  });
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
