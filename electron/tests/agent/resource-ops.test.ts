// electron/tests/agent/resource-ops.test.ts
//
// resource-ops 服务层单测（spec 2026-11-09-resource-creation-skills §5/§6）。
// DB 初始化沿用仓库既定模式（参考 crud-custom-def.test.ts / team-crud.test.ts）：
// AP_USER_DATA_DIR 指向临时目录 + runMigrations 全量迁移；成员夹具用真实 addMember
// 造（momo-test-rules：业务逻辑用真实实现，不 mock DB）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { addMember } from '../../src/main/agent/crud';
import {
  createProvider,
  setDefaultProvider,
  markProviderVerified,
  upsertProviderModel,
  setProviderModelEnabled,
  setProviderModelWindow,
} from '../../src/main/agent/provider-crud';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import { getSkillsDir, listInstalled } from '../../src/main/skill/zip-uploader';
import type { McpToolInfo } from '../../src/main/mcp/types';
import { McpHttpError } from '../../src/main/mcp/http-client';
import { executeResourceOp } from '../../src/main/agent/resource-ops';
import type { ListModelsResult } from '../../src/main/agent/resource-ops';

// 与 crud-custom-def.test.ts 同款 mock：crud.ts 引入的 runtime 依赖在测试环境不可用
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-resource-ops-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

// 种子夹具（beforeEach 重建——每用例全新库，用例间零串扰）
let wsId = '';
let m1 = '';
let m2 = '';
let defSlug = '';
// 供应商行（defaultChatModel 兜底的前提）；defaultChatModel 本身按用例需要再设
// （definition-default-model.test.ts 同款手法：不设 = 「未配置」路径）
let provId = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();

  // 外键依赖链：workspaces → agent_definitions → workspace_agent_members（team-crud 同款）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, '测试空间', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run('ws-r');
  const seedDef = db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name)
     VALUES (?, ?, ?, '1', 'p', 'm')`,
  );
  seedDef.run('def-a', '甲', 'agent-a');
  seedDef.run('def-b', '乙', 'agent-b');
  seedDef.run('def-c', '丙', 'agent-c');
  m1 = (await addMember('ws-r', 'def-a', 'agent-a-x')).instanceId;
  m2 = (await addMember('ws-r', 'def-b', 'agent-b-x')).instanceId;
  provId = (await createProvider({ name: 'GLM', baseUrl: 'https://example/v1', apiKey: 'k' })).id;
  wsId = 'ws-r';
  defSlug = 'agent-c';
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('resource-ops 分发', () => {
  it('未知 op 拒绝', async () => {
    await expect(executeResourceOp('rm -rf', {}, wsId)).rejects.toThrow('未知 resource op');
  });

  it('op 入参携带 workspaceId 被忽略（归属只由主进程注入）', async () => {
    // 先在真 wsId 建团队：入参 forged workspaceId 不影响——结果属于注入的 wsId
    await executeResourceOp(
      'createTeam',
      { name: '真空间团队', memberInstanceIds: [m1, m2], leaderInstanceId: m1 },
      wsId,
    );
    const r = (await executeResourceOp('list', { type: 'teams', workspaceId: 'forged' }, wsId)) as {
      teams: Array<{ name: string }>;
    };
    expect(r.teams).toHaveLength(1);
    expect(r.teams[0]!.name).toBe('真空间团队');
  });
});

describe('list（resource_list 聚合）', () => {
  it('mcps 段含 transport 与启停态（spec §5.1——字段对齐 RegisteredMcp 真实形状）', async () => {
    const db = getDb();
    const seed = db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, enabled)
       VALUES (?, ?, '1.0.0', ?, 'echo', ?)`,
    );
    seed.run('mcp-on', 'stdio-server', 'stdio', 1);
    seed.run('mcp-off', 'remote-server', 'streamable_http', 0);

    const r = (await executeResourceOp('list', { type: 'mcps' }, wsId)) as {
      mcps: Array<{ name: string; transport: string; enabled: boolean }>;
    };
    const byName = new Map(r.mcps.map((m) => [m.name, m]));
    expect(byName.get('stdio-server')).toEqual({ name: 'stdio-server', transport: 'stdio', enabled: true });
    expect(byName.get('remote-server')).toEqual({ name: 'remote-server', transport: 'streamable_http', enabled: false });
  });
});

describe('createTeam', () => {
  it('成员不足拒绝并透传 team.ts 事务错误', async () => {
    await expect(
      executeResourceOp('createTeam', { name: 'T', memberInstanceIds: [m1], leaderInstanceId: m1 }, wsId),
    ).rejects.toThrow('团队成员数至少 2');
  });

  it('成功返回 teamId 与成员数', async () => {
    const r = (await executeResourceOp(
      'createTeam',
      { name: '翻译组', memberInstanceIds: [m1, m2], leaderInstanceId: m1 },
      wsId,
    )) as { teamId: string; memberCount: number };
    expect(r.memberCount).toBe(2);
  });
});

describe('addMember（幂等）', () => {
  it('已加入返回既有成员不报错', async () => {
    const first = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    const second = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    expect((first as { instanceId: string }).instanceId).toBe(
      (second as { instanceId: string }).instanceId,
    );
  });

  it('slug 查不到报错并提示先 resource_list', async () => {
    await expect(
      executeResourceOp('addMember', { definitionIdOrSlug: 'no-such' }, wsId),
    ).rejects.toThrow('未找到 agent 定义');
  });
});

describe('createAgent', () => {
  const validYaml = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 翻译agent
  slug: translator
  version: 1.0.0
  description: 中英互译
spec:
  runtime: declarative
  declarative:
    systemPrompt: 你是翻译。
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:
    - kind: builtin
      ref: read_file
`;
  const yamlWithOtherSlug = validYaml.replace('slug: translator', 'slug: translator-2');

  it('非法 manifest 逐字段透出 parser 错误', async () => {
    await expect(
      executeResourceOp('createAgent', { manifestYaml: 'apiVersion: v9\nkind: X' }, wsId),
    ).rejects.toThrow('manifest 校验失败');
  });

  it('slug 与既有定义冲突拒绝并带既有信息', async () => {
    // 种子：先建 slug=translator 的定义（defaultChatModel 兜底供模型绑定）
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });
    await executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId);
    await expect(
      executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId),
    ).rejects.toThrow(/slug 已存在.*translator/);
  });

  it('全局无默认模型时报错指路设置', async () => {
    // 不设 defaultChatModel 且入参不带 modelProviderId → createCustomDef 兜底缺失
    await expect(
      executeResourceOp('createAgent', { manifestYaml: yamlWithOtherSlug }, wsId),
    ).rejects.toThrow('defaultChatModel');
  });

  it('addToWorkspace=true 返回成员 instanceId', async () => {
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });
    const r = (await executeResourceOp(
      'createAgent',
      { manifestYaml: yamlWithOtherSlug, addToWorkspace: true },
      wsId,
    )) as { definitionId: string; member?: { instanceId: string } };
    expect(r.definitionId).toBeTruthy();
    expect(r.member?.instanceId).toBeTruthy();
  });
});

describe('createSkill', () => {
  // getSkillsDir() = <AP_USER_DATA_DIR>/skills = <tmpRoot>/skills（upload-zip.test.ts 同款隔离）
  const md = `---
name: 报告撰写
description: 写结构化报告时使用
---
## 工作流
1. 先列大纲
`;

  it('frontmatter 缺 name 拒绝', async () => {
    await expect(
      executeResourceOp('createSkill', { slug: 'report-writer', skillMd: '---\ndescription: x\n---\nbody' }, wsId),
    ).rejects.toThrow('name');
  });

  it('非法 slug 拒绝', async () => {
    await expect(
      executeResourceOp('createSkill', { slug: 'Bad/Slug', skillMd: md }, wsId),
    ).rejects.toThrow('非法 slug');
  });

  it('与既有 skill 同名拒绝并带来源', async () => {
    // 种子：先装 slug=report-writer；再建同名
    await executeResourceOp('createSkill', { slug: 'report-writer', skillMd: md }, wsId);
    await expect(
      executeResourceOp('createSkill', { slug: 'report-writer', skillMd: md }, wsId),
    ).rejects.toThrow(/skill 已存在.*custom/);
  });

  it('references 路径穿越拒绝且零落盘', async () => {
    await expect(
      executeResourceOp(
        'createSkill',
        { slug: 'safe-skill', skillMd: md, references: [{ path: '../escape.md', content: 'x' }] },
        wsId,
      ),
    ).rejects.toThrow('越界');
    expect(fs.existsSync(path.join(getSkillsDir(), 'escape.md'))).toBe(false);
    // 全部校验先于任何写盘——skill 目录本身也不得残留
    expect(fs.existsSync(path.join(getSkillsDir(), 'safe-skill'))).toBe(false);
  });

  it('成功：SKILL.md + references 落盘 + listInstalled 识别 custom 源', async () => {
    const r = (await executeResourceOp(
      'createSkill',
      { slug: 'ref-skill', skillMd: md, references: [{ path: 'references/tpl.md', content: '模板' }] },
      wsId,
    )) as { slug: string; name: string };
    expect(r.name).toBe('报告撰写');
    expect(fs.existsSync(path.join(getSkillsDir(), 'ref-skill', 'references', 'tpl.md'))).toBe(true);
    expect(fs.existsSync(path.join(getSkillsDir(), 'ref-skill', 'SKILL.md'))).toBe(true);
    // 与 zip/表单创建同链：.sha256 标记 → listInstalled 报 source='custom'（资源库可见）
    const installed = listInstalled().find((s) => s.slug === 'ref-skill');
    expect(installed?.source).toBe('custom');
    expect(installed?.name).toBe('报告撰写');
  });
});

describe('listModels', () => {
  it('返回供应商与模型清单逐字段（含 globalDefault），且不含 apiKey/baseUrl（最小暴露面）', async () => {
    // 种：置默认 + 标记已验证 + 2 行模型（一 enabled 一 disabled）+ 全局默认聊天模型
    setDefaultProvider(provId);
    markProviderVerified(provId);
    upsertProviderModel(provId, 'glm-5.3', true, true);
    setProviderModelWindow(provId, 'glm-5.3', 131072);
    upsertProviderModel(provId, 'glm-4.5-air', true, false);
    setProviderModelEnabled(provId, 'glm-4.5-air', false);
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });

    const r = (await executeResourceOp('listModels', {}, wsId)) as ListModelsResult;

    expect(r.providers).toHaveLength(1);
    const p = r.providers[0]!;
    expect(p.providerId).toBe(provId);
    expect(p.name).toBe('GLM');
    expect(p.platform).toBe('openai');
    expect(p.isDefault).toBe(true);
    expect(p.verified).toBe(true);
    expect(p.defaultModel).toBeNull();
    const byModel = new Map(p.models.map((m) => [m.modelId, m]));
    expect(byModel.get('glm-5.3')).toEqual({ modelId: 'glm-5.3', enabled: true, contextWindow: 131072, vision: true });
    expect(byModel.get('glm-4.5-air')).toEqual({ modelId: 'glm-4.5-air', enabled: false, contextWindow: null, vision: false });
    expect(r.globalDefault).toEqual({ providerId: provId, modelId: 'glm-5.3' });
    // 安全锁：序列化结果不得泄漏凭证或端点字段
    const json = JSON.stringify(r);
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('baseUrl');
  });

  it('globalDefault 清设置后返回 null', async () => {
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });
    // undefined 键被 JSON.stringify 丢弃 = 清设置（读回 undefined → null）
    updateGlobalSettings({ defaultChatModel: undefined });
    const r = (await executeResourceOp('listModels', {}, wsId)) as ListModelsResult;
    expect(r.globalDefault).toBeNull();
  });
});

describe('createMcp', () => {
  it('非法 name 拒绝', async () => {
    await expect(
      executeResourceOp('createMcp', { name: 'Bad Name', transport: { kind: 'http', url: 'https://x' } }, wsId),
    ).rejects.toThrow('非法');
  });

  it('同名冲突拒绝', async () => {
    // 种子：mcp_definitions 预插 name=demo 行（直接 SQL，mirror mcp 既有测试）
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command)
         VALUES ('mcp-seed-demo', 'demo', '1.0.0', 'stdio', 'echo')`,
      )
      .run();
    await expect(
      executeResourceOp('createMcp', { name: 'demo', transport: { kind: 'http', url: 'https://x' } }, wsId),
    ).rejects.toThrow('MCP 已存在');
  });

  it('连通失败零落库并回传错误', async () => {
    const failingClient = {
      connect: async () => { throw new Error('connection refused'); },
      listTools: async () => [],
      disconnect: async () => undefined,
    };
    await expect(
      executeResourceOp('createMcp', { name: 'dead-server', transport: { kind: 'stdio', command: 'no-such-bin' } }, wsId, {
        makeClient: () => failingClient,
      }),
    ).rejects.toThrow('connection refused');
    const row = getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get('dead-server');
    expect(row).toBeUndefined();
  });

  it('撞 OAuth 401：落库（未绑定）并返回 needsAuthorization 引导（R14，判定口径同 host-manager）', async () => {
    const challengedClient = {
      connect: async () => {
        throw new McpHttpError('initialize', 401, 'Bearer resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource"');
      },
      listTools: async () => [],
      disconnect: async () => undefined,
    };
    const r = (await executeResourceOp(
      'createMcp', { name: 'notion', transport: { kind: 'http', url: 'https://mcp.notion.com/mcp' } }, wsId,
      { makeClient: () => challengedClient },
    )) as { needsAuthorization?: boolean; notice?: string; toolCount: number };
    expect(r.needsAuthorization).toBe(true);
    expect(r.notice).toContain('资源库');
    expect(r.toolCount).toBe(0);
    // 落库且未绑定 OAuth（oauth_connection_id 空）——用户去资源库编辑弹窗走 401 横幅授权
    const row = getDb()
      .prepare('SELECT oauth_connection_id FROM mcp_definitions WHERE name = ?')
      .get('notion') as { oauth_connection_id: string | null };
    expect(row).toBeTruthy();
    expect(row.oauth_connection_id).toBeNull();
  });

  it('非 OAuth 形状的 401（手填 key 失效等）仍零落库——原语义锁', async () => {
    const plainFailClient = {
      // 普通 Error 携带 401 字样：不经 McpHttpError 结构化通道，非 OAuth 挑战
      connect: async () => { throw new Error('远程 MCP initialize 失败：HTTP 401'); },
      listTools: async () => [],
      disconnect: async () => undefined,
    };
    await expect(
      executeResourceOp('createMcp', { name: 'bad-key', transport: { kind: 'http', url: 'https://x' } }, wsId, {
        makeClient: () => plainFailClient,
      }),
    ).rejects.toThrow('HTTP 401');
    expect(getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get('bad-key')).toBeUndefined();
  });

  it('连通成功后落库并返回工具名摘要（截断至 20）', async () => {
    const okClient = {
      connect: async () => undefined,
      listTools: async () =>
        Array.from({ length: 25 }, (_, i): McpToolInfo => ({ name: `t${i}`, description: '', inputSchema: {} })),
      disconnect: async () => undefined,
    };
    const r = (await executeResourceOp(
      'createMcp', { name: 'live-server', transport: { kind: 'http', url: 'https://x' } }, wsId,
      { makeClient: () => okClient },
    )) as { toolCount: number; toolNames: string[] };
    expect(r.toolCount).toBe(25);
    expect(r.toolNames).toHaveLength(20);
    expect(getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get('live-server')).toBeTruthy();
  });
});
