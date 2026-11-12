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
import type { ListModelsResult, DescribeAgentResult, UpdateCapabilitiesResult, UpdateProfileResult } from '../../src/main/agent/resource-ops';

// 与 crud-custom-def.test.ts 同款 mock：crud.ts 引入的 runtime 依赖在测试环境不可用。
// updateCapabilities 的 restart 接线（spec §8）也经这两个边界——mock 面随 Task 5 扩：
// runtime-registry 加 requestRespawnAfterIdle；start-chain（拉起通道）整体 mock。
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
  requestRespawnAfterIdle: vi.fn(),
}));
vi.mock('../../src/main/agent/start-chain', () => ({
  ensureMemberRuntime: vi.fn(),
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

describe('describeAgent（读面）', () => {
  it('instanceId 直查：定义 + 生效集 + 三层归因 + 跨 ws 计数', async () => {
    // 共享夹具的 def 行未写 source 列（列默认 'custom'，migration v3）——本用例
    // 显式置 builtin 以匹配断言（不改动共享 INSERT，避免影响既有用例）
    getDb().prepare(`UPDATE agent_definitions SET source = 'builtin' WHERE id = 'def-a'`).run();
    const r = (await executeResourceOp('describeAgent', { agent: m1 }, wsId)) as DescribeAgentResult;
    expect(r).toMatchObject({
      definition: { id: 'def-a', slug: 'agent-a', name: '甲', source: 'builtin' },
      member: { instanceId: m1 },
    });
    // def-a 无 defaultTools/Mcps/Skills 夹具值 → attribution 三段可断言空集形状
    expect(r.attribution).toHaveProperty('fromDefinition');
    expect(r.attribution).toHaveProperty('memberAdded');
    expect(typeof r.otherWorkspaceMembers).toBe('number');
  });

  it('slug 反查：当前 ws 内按 slug 定位唯一成员', async () => {
    const r = (await executeResourceOp('describeAgent', { agent: 'agent-a' }, wsId)) as DescribeAgentResult;
    expect(r.member.instanceId).toBe(m1);
  });

  it('查无目标报可行动错误', async () => {
    await expect(executeResourceOp('describeAgent', { agent: 'no-such' }, wsId)).rejects.toThrow('resource_list');
  });

  it('member delta 反映进 attribution.memberAdded', async () => {
    getDb().prepare(
      `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, 'skill', 'add', 'weather')`,
    ).run(m1);
    const r = (await executeResourceOp('describeAgent', { agent: m1 }, wsId)) as DescribeAgentResult;
    expect(r.attribution.memberAdded).toContain('weather');
    expect(r.effective.skills).toContain('weather');
  });
});

describe('updateCapabilities', () => {
  // .sha256 标记 = listInstalled 识别 custom skill 的前提（zip-uploader §3 扫描规则）——
  // 只写 SKILL.md 的目录对 ref 校验不可见
  const seedSkill = (slug: string): void => {
    const dir = path.join(getSkillsDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: d\n---\nbody`);
    fs.writeFileSync(path.join(dir, '.sha256'), 'seed');
  };

  it('member 加 skill：delta 落库 + restart=deferred 返回 needsRestart', async () => {
    seedSkill('weather');
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] }, restart: 'deferred' }, wsId, undefined, { background: false })) as UpdateCapabilitiesResult;
    expect(r.appliedTo).toBe('member');
    expect(r.needsRestart).toBe(true);
    const deltas = getDb().prepare('SELECT * FROM agent_assignment_capabilities WHERE assignment_id = ?').all(m1) as Array<{ ref: string; mode: string }>;
    expect(deltas.some((d) => d.ref === 'weather' && d.mode === 'add')).toBe(true);
  });

  it('re-enable 行保全：def 禁 + added 重启用 → 无关 member 更新不擦除', async () => {
    // 回归锁（spawn 同源契约）：插件工具黑名单 = (def禁 ∪ removed) − added——
    // addedPluginTools 行可重启用 def 禁用的工具；不含 pluginTools 的 member
    // 更新不得让 setAssignmentDeltas 全量替换擦掉该行
    getDb().prepare(`UPDATE agent_definitions SET denied_tools = ? WHERE id = 'def-a'`)
      .run(JSON.stringify(['plugin:foo/bar']));
    getDb().prepare(
      `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref)
       VALUES (?, 'plugin_tool', 'add', 'plugin:foo/bar')`,
    ).run(m1);
    seedSkill('weather');
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] }, restart: 'deferred' }, wsId, undefined, { background: false })) as UpdateCapabilitiesResult;
    const rows = getDb().prepare(
      `SELECT ref, mode FROM agent_assignment_capabilities WHERE assignment_id = ? AND capability_type = 'plugin_tool'`,
    ).all(m1) as Array<{ ref: string; mode: string }>;
    expect(rows.some((x) => x.ref === 'plugin:foo/bar' && x.mode === 'add')).toBe(true);
    expect(r.effective.grantedPlugin).toContain('plugin:foo/bar');
  });

  it('ref 校验 fail-fast：全部非法项一次报出，零落库', async () => {
    seedSkill('weather');
    await expect(executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather', 'ghost-skill'], tools: ['no_such_tool'] } }, wsId))
      .rejects.toThrow(/ghost-skill.*no_such_tool|no_such_tool.*ghost-skill/s);
    const n = getDb().prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get() as { c: number };
    expect(n.c).toBe(0);
  });

  it('scope=definition 且 builtin 定义 → 拒绝并指路 member/UI', async () => {
    // 共享夹具 source 缺省 'custom'——builtin 用例须显式置源（describeAgent 同款手法）；
    // 请求带合法非空 add，确保挡在 builtin 守卫而非空请求校验
    seedSkill('weather');
    getDb().prepare(`UPDATE agent_definitions SET source = 'builtin' WHERE id = 'def-a'`).run();
    await expect(executeResourceOp('updateCapabilities',
      { agent: m1, scope: 'definition', add: { skills: ['weather'] } }, wsId))
      .rejects.toThrow('builtin');
  });

  it('definition 分支（custom def）：增量落 def.defaultSkills + 停机返回 stoppedInstances', async () => {
    seedSkill('weather');
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-custom', '自', 'agent-custom', '1', 'p', 'm', 'custom')`).run();
    const cm = (await addMember(wsId, 'def-custom', '@c:1')).instanceId;
    const r = (await executeResourceOp('updateCapabilities',
      { agent: cm, scope: 'definition', add: { skills: ['weather'] } }, wsId)) as UpdateCapabilitiesResult;
    expect(r.appliedTo).toBe('definition');
    expect(typeof r.stoppedInstances).toBe('number');
    const def = getDb().prepare('SELECT default_skills FROM agent_definitions WHERE id = ?').get('def-custom') as { default_skills: string };
    expect(JSON.parse(def.default_skills)).toEqual([{ kind: 'skill', ref: 'weather' }]);
  });

  it('otherWorkspaceMembers：另一 ws 同 def 成员计数', async () => {
    seedSkill('weather');
    getDb().prepare(`INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
                     VALUES ('ws-2', '二', '', '/tmp', 0, '@o:s', '📁')`).run();
    await addMember('ws-2', 'def-a', '@a:2');
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] }, restart: 'deferred' }, wsId, undefined, { background: false })) as UpdateCapabilitiesResult;
    expect(r.otherWorkspaceMembers).toBe(1);
  });

  it('restart=auto 且目标≠自身且在跑 → stop + 拉起（restarted: true）', async () => {
    seedSkill('weather');
    const { isAgentRunning } = await import('../../src/main/agent/runtime-status');
    const { stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    const { ensureMemberRuntime } = await import('../../src/main/agent/start-chain');
    vi.mocked(isAgentRunning).mockReturnValue(true);
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: 'someone-else' })) as UpdateCapabilitiesResult;
    expect(r.restarted).toBe(true);
    expect(vi.mocked(stopAgentRuntime)).toHaveBeenCalledWith(m1);
    expect(vi.mocked(ensureMemberRuntime)).toHaveBeenCalledWith(m1);
    vi.mocked(isAgentRunning).mockReturnValue(false);
  });

  it('restart=auto 且目标==自身 → 挂 respawn-on-idle（effectiveFrom: next-turn，绝不 mid-call 杀自己）', async () => {
    seedSkill('weather');
    const { requestRespawnAfterIdle, stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    vi.mocked(stopAgentRuntime).mockClear();
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: m1 })) as UpdateCapabilitiesResult;
    expect(r.effectiveFrom).toBe('next-turn');
    expect(r.restarted).toBeUndefined();
    expect(vi.mocked(requestRespawnAfterIdle)).toHaveBeenCalledWith(m1);
    expect(vi.mocked(stopAgentRuntime)).not.toHaveBeenCalled();
  });

  it('目标未在跑 → needsRestart: false（下次派发现算快照）', async () => {
    seedSkill('weather');
    const { isAgentRunning } = await import('../../src/main/agent/runtime-status');
    vi.mocked(isAgentRunning).mockReturnValue(false);
    const r = (await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: 'x' })) as UpdateCapabilitiesResult;
    expect(r.needsRestart).toBe(false);
  });

  it('空请求（无 add 无 remove）报错', async () => {
    await expect(executeResourceOp('updateCapabilities', { agent: m1 }, wsId)).rejects.toThrow('至少');
  });
});

describe('updateProfile', () => {
  it('custom def 改 name/systemPrompt/model：落库 + 停机计数', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-p', '改前', 'agent-p', '1', 'p0', 'm0', 'custom')`).run();
    const pm = (await addMember(wsId, 'def-p', '@p:1')).instanceId;
    const r = (await executeResourceOp('updateProfile',
      { agent: pm, name: '改后', systemPrompt: 'p1', model: { providerId: provId, modelName: 'glm-5' } }, wsId)) as UpdateProfileResult;
    expect(r.definition.name).toBe('改后');
    const row = getDb().prepare('SELECT name, system_prompt, model_provider_id FROM agent_definitions WHERE id = ?').get('def-p') as { name: string; system_prompt: string; model_provider_id: string };
    expect(row).toMatchObject({ name: '改后', system_prompt: 'p1', model_provider_id: provId });
    expect(typeof r.stoppedInstances).toBe('number');
  });

  it('builtin 定义拒绝（含指路文案）', async () => {
    // 共享夹具 def-a source 缺省 'custom'——builtin 用例须显式置源（describeAgent 同款手法）
    getDb().prepare(`UPDATE agent_definitions SET source = 'builtin' WHERE id = 'def-a'`).run();
    await expect(executeResourceOp('updateProfile', { agent: m1, name: 'x' }, wsId))
      .rejects.toThrow('builtin 预设定义只读');
  });

  it('model.providerId 不存在 → 友好报错（沿 opCreateAgent 口径）', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-q', 'q', 'agent-q', '1', 'p', 'm', 'custom')`).run();
    const qm = (await addMember(wsId, 'def-q', '@q:1')).instanceId;
    await expect(executeResourceOp('updateProfile',
      { agent: qm, model: { providerId: 'nope', modelName: 'm' } }, wsId)).rejects.toThrow('供应商不存在');
  });

  it('deniedTools 整列覆盖；全字段缺省 → no-op 更新（值不变）', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-r', 'r', 'agent-r', '1', 'p', 'm', 'custom')`).run();
    const rm = (await addMember(wsId, 'def-r', '@r:1')).instanceId;
    const r = (await executeResourceOp('updateProfile', { agent: rm, deniedTools: ['bash'] }, wsId)) as UpdateProfileResult;
    const row = getDb().prepare('SELECT denied_tools FROM agent_definitions WHERE id = ?').get('def-r') as { denied_tools: string };
    expect(JSON.parse(row.denied_tools)).toEqual(['bash']);
    expect(r.definition.deniedTools).toEqual(['bash']);
    // 全字段缺省：仅 agent 入参 → no-op（undefined=不改，原值保留）
    const noop = (await executeResourceOp('updateProfile', { agent: rm }, wsId)) as UpdateProfileResult;
    expect(noop.definition.name).toBe('r');
    expect(noop.definition.deniedTools).toEqual(['bash']);
    const after = getDb().prepare('SELECT name, denied_tools FROM agent_definitions WHERE id = ?').get('def-r') as { name: string; denied_tools: string };
    expect(after).toMatchObject({ name: 'r', denied_tools: JSON.stringify(['bash']) });
  });
});

describe('updateSkill', () => {
  const seedCustom = (slug: string): void => {
    const dir = path.join(getSkillsDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: 旧名\ndescription: 旧\n---\n旧正文');
    fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef'); // custom 源标记
  };

  it('custom 源全量替换：SKILL.md/references/.sha256 全部换新', async () => {
    seedCustom('my-skill');
    const r = (await executeResourceOp('updateSkill', {
      slug: 'my-skill',
      skillMd: '---\nname: 新名\ndescription: 新\n---\n新正文',
      references: [{ path: 'refs/a.md', content: 'A' }],
    }, wsId)) as { name: string; refCount: number };
    expect(r.name).toBe('新名');
    expect(r.refCount).toBe(1);
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'refs', 'a.md'), 'utf-8')).toBe('A');
    const hash = fs.readFileSync(path.join(getSkillsDir(), 'my-skill', '.sha256'), 'utf-8');
    expect(hash).not.toBe('deadbeef');
    // SKILL.md 换新（全量替换不是追加）
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'SKILL.md'), 'utf-8')).toContain('新正文');
    // listInstalled 仍识别 custom 源（.sha256 重算后不丢标记）
    const installed = listInstalled().find((s) => s.slug === 'my-skill');
    expect(installed?.source).toBe('custom');
    expect(installed?.name).toBe('新名');
  });

  it('references 越界拒绝且零落盘（Review Focus ④）', async () => {
    seedCustom('my-skill');
    await expect(executeResourceOp('updateSkill', {
      slug: 'my-skill', skillMd: '---\nname: n\ndescription: d\n---\nb',
      references: [{ path: '../escape.md', content: 'x' }],
    }, wsId)).rejects.toThrow('越界');
    expect(fs.existsSync(path.join(getSkillsDir(), 'escape.md'))).toBe(false);
    // 旧内容原样保留（不是先删后炸）
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'SKILL.md'), 'utf-8')).toContain('旧正文');
    // 旧 .sha256 标记原样保留
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', '.sha256'), 'utf-8')).toBe('deadbeef');
  });

  it('slug 不存在 → 指路 create_skill', async () => {
    await expect(executeResourceOp('updateSkill',
      { slug: 'ghost', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId))
      .rejects.toThrow('create_skill');
  });

  it('非 custom 源（无 .sha256 标记）拒绝并引导 UI', async () => {
    const dir = path.join(getSkillsDir(), 'builtin-like');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: b\ndescription: d\n---\nb');
    await expect(executeResourceOp('updateSkill',
      { slug: 'builtin-like', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId))
      .rejects.toThrow('资源库');
  });

  it('frontmatter 缺 description 拒绝（与 createSkill 同链校验）', async () => {
    seedCustom('my-skill');
    await expect(executeResourceOp('updateSkill',
      { slug: 'my-skill', skillMd: '---\nname: 只有名\n---\nb' }, wsId))
      .rejects.toThrow('description');
    // 校验失败零落盘——旧内容原样
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'SKILL.md'), 'utf-8')).toContain('旧正文');
  });

  it('agentsUsingIt：引用该 skill 的成员行计数', async () => {
    seedCustom('shared-skill');
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source, default_skills)
                     VALUES ('def-s', 's', 'agent-s', '1', 'p', 'm', 'custom', ?)`).run(JSON.stringify([{ kind: 'skill', ref: 'shared-skill' }]));
    await addMember(wsId, 'def-s', '@s:1');
    const r = (await executeResourceOp('updateSkill',
      { slug: 'shared-skill', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId)) as { agentsUsingIt: number; needsRestart: boolean };
    expect(r.agentsUsingIt).toBeGreaterThanOrEqual(1);
    expect(r.needsRestart).toBe(true);
  });

  it('agentsUsingIt：成员 delta add 行也计数；无引用时 needsRestart=false', async () => {
    seedCustom('lone-skill');
    getDb().prepare(
      `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, 'skill', 'add', 'lone-skill')`,
    ).run(m1);
    const r = (await executeResourceOp('updateSkill',
      { slug: 'lone-skill', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId)) as { agentsUsingIt: number; needsRestart: boolean };
    expect(r.agentsUsingIt).toBeGreaterThanOrEqual(1);
    expect(r.needsRestart).toBe(true);
    // 无任何引用：needsRestart=false
    seedCustom('quiet-skill');
    const q = (await executeResourceOp('updateSkill',
      { slug: 'quiet-skill', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId)) as { agentsUsingIt: number; needsRestart: boolean };
    expect(q.agentsUsingIt).toBe(0);
    expect(q.needsRestart).toBe(false);
  });
});
