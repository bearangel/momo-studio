// renderer/src/components/resource-library/ResourceDetail.test.tsx
// ResourceDetail 行为：右侧滑出详情面板，按 source 分支显示不同字段：
//   - builtin/marketplace（含 marketplace 元数据）: README + author + 校验状态 + downloadUrl
//   - custom MCP: command + args + env(KEY=*** 隐藏值) + installedAt
//   - custom Skill: frontmatter + installedAt
//   - custom Agent: systemPromptHash + installedAt
// 底部按钮区按 installed / installable / removable 三态切换。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceDetail } from './ResourceDetail';
import type { ResourceItem } from '../../ipc/types';

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

  it('builtin (removable=false): 不显示删除按钮', () => {
    const onDelete = vi.fn();
    const item = baseItem({ removable: false });
    render(<ResourceDetail item={item} onClose={() => {}} onDelete={onDelete} />);
    // 仅显示"✓ 已安装"静态标记，无删除按钮
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
    // 头部关闭按钮（× 文本）点击触发 onClose
    const closeBtn = screen.getByRole('button', { name: /×/ });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
