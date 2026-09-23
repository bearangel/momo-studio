// electron/tests/resource/custom.test.ts
//
// v1.7 Task 3：custom 源（mcp + skill + agent 三类合并）测试。
// 覆盖：
//   - 三类合并：mcp + skill + agent 数量正确（builtin/marketplace 被过滤）
//   - 所有 custom 项 source='custom'
//   - 所有 custom 项 installed=true / installable=false / removable=true
//   - MCP custom 项含 mcpConfig + id 命名（custom-mcp-<name>）
//   - Skill custom 项含 installedAt + id 命名（custom-skill-<slug>）
//   - Agent custom 项含 agentSystemPromptHash + id 命名（custom-agent-<uuid>）
//   - 过滤掉 source=marketplace / source=builtin 的项
//
// 隔离：用 vi.mock 替换三个底层 list 函数（listRegistered / listInstalled /
// listAgentDefinitions），避免依赖真实 DB + fs。

import { describe, it, expect, vi } from 'vitest';
import { listCustomResources } from '../../src/main/resource/custom';

// mock 底层 list 函数（避免依赖真实 fs + DB）
vi.mock('../../src/main/mcp/host-manager', () => ({
  listRegistered: vi.fn(() => [
    {
      id: 'm1',
      name: 'github',
      version: '1.0.0',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'x'],
      env: { TOKEN: 't' },
      source: 'custom',
      installedAt: '2026-08-11T10:00:00Z',
    },
    {
      // P2.2 Task 6：custom 源远程行（resource:registerMcp transport='streamable_http'
      // 注册）——custom.transport 填充的 streamable_http 形态
      id: 'm3',
      name: 'weather',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://mcp.example.com/sse',
      source: 'custom',
      installedAt: '2026-08-11T10:30:00Z',
    },
    {
      id: 'm2',
      name: 'builtin-fs',
      version: '1.0.0',
      command: 'npx',
      args: [],
      source: 'marketplace', // 应被过滤掉
      installedAt: '2026-08-10T10:00:00Z',
    },
  ]),
}));

vi.mock('../../src/main/skill/zip-uploader', () => ({
  listInstalled: vi.fn(() => [
    {
      slug: 'xlsx',
      name: 'xlsx',
      description: 'xlsx 处理',
      source: 'custom',
      installedAt: '2026-08-11T11:00:00Z',
    },
    {
      slug: 'code-review',
      name: 'code-review',
      description: '内置',
      source: 'builtin', // 应被过滤掉
      installedAt: null,
    },
  ]),
}));

vi.mock('../../src/main/agent/crud', () => ({
  listAgentDefinitions: vi.fn(() => [
    {
      id: 'uuid-1',
      name: '我的 agent',
      slug: 'my-agent',
      version: '1.0.0',
      source: 'custom',
      description: '自定义',
      iconEmoji: '🤖',
      systemPrompt: 'prompt',
      createdAt: '2026-08-11T12:00:00Z',
      runtime: 'declarative',
      defaultTools: [],
      defaultMcps: [],
      defaultSkills: [],
      workspaceId: null,
      modelProviderId: null,
      modelName: 'm',
    },
  ]),
}));

describe('listCustomResources', () => {
  it('合并 mcp + skill + agent 三类 custom', () => {
    const items = listCustomResources();
    expect(items).toHaveLength(4); // 2 mcp（stdio + streamable_http）+ 1 skill + 1 agent（builtin/marketplace 被过滤）
    expect(items.map((i) => i.type).sort()).toEqual(['agent', 'mcp', 'mcp', 'skill']);
  });

  it('所有 custom 项 source=custom', () => {
    const items = listCustomResources();
    for (const i of items) expect(i.source).toBe('custom');
  });

  it('所有 custom 项 installed=true / installable=false / removable=true', () => {
    const items = listCustomResources();
    for (const i of items) {
      expect(i).toMatchObject({ installed: true, installable: false, removable: true });
    }
  });

  it('MCP custom 项含 mcpConfig 字段', () => {
    const items = listCustomResources();
    const mcp = items.find((i) => i.type === 'mcp')!;
    expect(mcp.custom?.mcpConfig).toMatchObject({
      command: 'npx',
      args: ['-y', 'x'],
      env: { TOKEN: 't' },
    });
    expect(mcp.id).toBe('custom-mcp-github');
  });

  // P2.2 Task 6：custom.transport 双形态填充——ResourceDetail「配置」按钮的
  // 显示条件（transport === 'streamable_http'）消费该字段（spec §6.1）
  it('MCP custom 项填充 custom.transport（stdio / streamable_http 双形态）', () => {
    const items = listCustomResources();
    const stdio = items.find((i) => i.slug === 'github')!;
    expect(stdio.custom?.transport).toBe('stdio');
    const remote = items.find((i) => i.slug === 'weather')!;
    expect(remote.custom?.transport).toBe('streamable_http');
  });

  it('非 MCP custom 项不填 transport（skill / agent 无该字段）', () => {
    const items = listCustomResources();
    const skill = items.find((i) => i.type === 'skill')!;
    expect(skill.custom?.transport).toBeUndefined();
    const agent = items.find((i) => i.type === 'agent')!;
    expect(agent.custom?.transport).toBeUndefined();
  });

  it('Skill custom 项含 installedAt', () => {
    const items = listCustomResources();
    const skill = items.find((i) => i.type === 'skill')!;
    expect(skill.custom?.installedAt).toBe('2026-08-11T11:00:00Z');
    expect(skill.id).toBe('custom-skill-xlsx');
  });

  it('Agent custom 项含 agentSystemPromptHash + installedAt', () => {
    const items = listCustomResources();
    const agent = items.find((i) => i.type === 'agent')!;
    expect(agent.custom?.agentSystemPromptHash).toBeTruthy();
    expect(agent.id).toBe('custom-agent-uuid-1'); // agent def id 是 UUID，作为 slug 部分
  });

  it('过滤掉 source=marketplace / source=builtin 的项', () => {
    const items = listCustomResources();
    const names = items.map((i) => i.name);
    expect(names).not.toContain('builtin-fs');
    expect(names).not.toContain('code-review');
  });
});
