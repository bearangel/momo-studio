// electron/tests/hub/snapshot-builder.test.ts
//
// 工作空间快照构建器（momo-hub M2 spec §5.2 第 1 步 / Task 7）测试矩阵：
//   1. 清单全量：七子段一次走全（成员引用/内嵌分流、团队、MCP stdio 过滤、skill 三源、
//      插件记账/excluded、provider 引用、prefs）+ tar 形态（manifest.json 在根 +
//      custom skill 内嵌 + 安装标记排除）+ validateSnapshotManifest 自检 + checksum
//   2. 红线零渗漏（真实敏感材料在场）：provider key（keychain 实值）/ url-MCP 凭证头
//      在 DB 与 keychain 中真实存在 → 归档全文字节扫描零踪迹
//   3. 红线变异四连（Review Focus #4——人为塞入即红）：
//      a. 结构变异：provider 段塞 apiKey 字段 → findForbiddenFields 红
//      b. 值变异：sk- 前缀 key 值 → scanTextForSecrets 红
//      c. url-MCP 凭证头变异：headers/Authorization 字段 → 结构扫描红
//      d. 端到端渗漏：custom agent prompt 内嵌 key 值 / custom skill 文件内嵌 ghp_ →
//         buildWorkspaceSnapshot 整体 reject（fail-closed）
//      e. 已知值回填缝：knownSecrets 实值包含比对红
//   4. 静态源码断言：构建器不触碰 message_events（聊天历史表零查询）
//   5. 错误路径：工作空间不存在 / 历史脏定义（YAML 反序列化校验拦截）/ 空工作空间
//
// 环境注：真实 DB + 真实 fs + 真实 tar（AP_USER_DATA_DIR 注入）——mock 只收窄在
// 进程边界（electron/logger），与 publish.test.ts 同款模式。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, addMember } from '../../src/main/agent/crud';
import { createTeam } from '../../src/main/agent/team';
import { createProvider } from '../../src/main/agent/provider-crud';
import { parseAgentManifest } from '../../src/main/agent/manifest-parser';
import { registerMcpDefinition, setMcpEnabledDefinition } from '../../src/main/mcp/host-manager';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { createWorkspace, setDefaultAgent } from '../../src/main/workspace/crud';
import { updateGlobalSettings } from '../../src/main/settings/crud';

// ── 进程边界替身（publish.test.ts 同款——snapshot-builder → publish → hub/index 链）──
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/hub/client', () => ({
  createHubClient: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    state: (): string => 'disconnected',
    hubProtoVer: (): string | null => null,
  })),
  enrollOverHttp: vi.fn(async () => ({ nodeId: 'node-1', deviceToken: 'tok-1' })),
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../src/main/logger';

import {
  buildWorkspaceSnapshot,
  findForbiddenFields,
  scanTextForSecrets,
} from '../../src/main/hub/snapshot-builder';
import { validateSnapshotManifest, VERSION_PATTERN } from '../../src/main/hub/protocol';
import type { SnapshotManifest } from '../../src/main/hub/protocol';

// ── 环境脚手架 ────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-hubsnap-'));
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** tar 成员清单（剥目录尾条目，只留文件成员） */
function tarList(archivePath: string): string[] {
  return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
}

/** 从归档取单个文件内容（tar -xO 原样输出） */
function tarRead(archivePath: string, member: string): string {
  return execFileSync('tar', ['-xOzf', archivePath, member], { encoding: 'utf-8' });
}

/** 归档全部文本成员拼接（红线全文字节扫描基底） */
function tarAllText(archivePath: string): string {
  return tarList(archivePath)
    .map((m) => tarRead(archivePath, m))
    .join('\n');
}

// ── 数据种子 ──────────────────────────────────────────────────────────────

async function mkWorkspace(name: string): Promise<string> {
  const ws = await createWorkspace(
    { name, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner-1',
  );
  return ws.id;
}

interface SeedDefOpts {
  source?: 'custom' | 'marketplace' | 'builtin' | 'plugin';
  systemPrompt?: string;
  slug?: string;
}

/** 落一个 agent 定义并加入工作空间（返回 instanceId） */
async function seedMember(wsId: string, id: string, name: string, opts: SeedDefOpts = {}): Promise<string> {
  saveAgentDefinition({
    id,
    name,
    slug: opts.slug ?? id,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: opts.systemPrompt ?? `你是 ${name}`,
    defaultTools: [],
    source: opts.source ?? 'custom',
    description: '快照测试 agent',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  });
  const m = await addMember(wsId, id, `@${id}:momo.local`);
  return m.instanceId;
}

/** installed_packages 落一条 hub 记账行（item_id = `hub:{slug}`，M1 §6.2 形态） */
function seedHubAccounting(itemType: 'agent' | 'skill' | 'mcp' | 'plugin', slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      `hub:${slug}`,
      itemType,
      slug,
      '1.0.0',
      path.join(tmpRoot, 'cache', slug),
      crypto.createHash('sha256').update(slug).digest('hex'),
    );
}

/** 落一个 custom skill 上传目录（.sha256 标记 + 附加资源；publish.test 同款） */
function seedCustomSkill(slug: string, bodyExtra = ''): void {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug} 名\ndescription: 自定义 skill\nversion: 0.3.0\n---\n\n正文内容。${bodyExtra}`,
  );
  fs.writeFileSync(path.join(dir, 'notes.txt'), '附加资源');
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
}

/** skill_definitions 落一条 marketplace 安装行（hub 安装同表） */
function seedMarketplaceSkillRow(slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO skill_definitions (id, name, slug, version, description, cache_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), `${slug}-name`, slug, '1.0.0', '市场 skill', path.join(tmpRoot, 'cache', slug));
}

function seedPlugin(id: string, source: 'zip' | 'dev'): void {
  upsertPlugin({
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({ id, version: '0.1.0' }),
    state: 'active',
    source,
    sourcePath: source === 'dev' ? path.join(tmpRoot, 'plugins', id) : null,
    installedAt: new Date().toISOString(),
  });
}

// ── 1. 清单全量（七子段）──────────────────────────────────────────────────

describe('buildWorkspaceSnapshot 清单全量', () => {
  it('七子段全量 + 引用/内嵌分流 + tar 形态 + checksum + 自检过 validateSnapshotManifest', async () => {
    const wsId = await mkWorkspace('镜像工作空间');

    // 成员三分支：custom 内嵌 / marketplace+hub 记账引用 / builtin 引用不占 resources
    const customInst = await seedMember(wsId, 'def-custom', '自定义甲');
    const marketInst = await seedMember(wsId, 'def-market', '市场乙', {
      source: 'marketplace',
      slug: 'market-agent',
    });
    await seedMember(wsId, 'def-builtin', '内置丙', { source: 'builtin', slug: 'builtin-agent' });
    seedHubAccounting('agent', 'market-agent');

    // 团队（leader = 市场乙；成员名对齐定义名）
    createTeam(wsId, '特别小组', '👥', [marketInst, customInst], marketInst);

    // MCP：stdio 自定义（入）/ url 形态带凭证头（排除）/ 禁用（排除）/ hub 记账（入+补装位）/ plugin 来源（排除）
    registerMcpDefinition({
      id: randomUUID(), name: 'my-tools', version: '1.0.0',
      command: 'npx', args: ['@scope/tool-server'], source: 'custom',
    });
    registerMcpDefinition({
      id: randomUUID(), name: 'remote-mcp', version: '1.0.0', transport: 'streamable_http',
      command: '', args: [], url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token-abcdef123' }, source: 'custom',
    });
    registerMcpDefinition({
      id: randomUUID(), name: 'off-tools', version: '1.0.0',
      command: 'npx', args: ['off-pkg'], source: 'custom',
    });
    setMcpEnabledDefinition('off-tools', false);
    registerMcpDefinition({
      id: randomUUID(), name: 'hub-tools', version: '1.0.0',
      command: 'npx', args: ['hub-pkg'], source: 'marketplace',
    });
    seedHubAccounting('mcp', 'hub-tools');
    registerMcpDefinition({
      id: randomUUID(), name: 'plugin-mcp', version: '1.0.0',
      command: 'node', args: ['srv.js'], source: 'plugin', pluginId: 'hub-plugin',
    });

    // skill：custom 内嵌 / marketplace 行 + hub 记账引用 / builtin 同有（目录扫描）
    seedCustomSkill('my-skill');
    seedMarketplaceSkillRow('market-skill');
    seedHubAccounting('skill', 'market-skill');

    // 插件：hub 记账（入）/ zip 无记账（excluded 不阻断）
    seedPlugin('hub-plugin', 'zip');
    setPluginEnabled('hub-plugin', wsId, true);
    seedHubAccounting('plugin', 'hub-plugin');
    seedPlugin('zip-plugin', 'zip');
    setPluginEnabled('zip-plugin', wsId, true);

    // provider：key 实值进 keychain；类型+型号偏好进清单
    await createProvider({
      name: 'Anthropic 直连', baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-provider-key-value-abcdef', platform: 'anthropic', defaultModel: 'claude-x',
    });
    await createProvider({
      name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-second-key-value-ghijkl', platform: 'openai',
    });

    // prefs：工具上限
    updateGlobalSettings({ maxToolCalls: 33 });

    const r = await buildWorkspaceSnapshot(wsId);

    // —— manifest 结构自检（hub 端同一校验前置）——
    expect(r.manifest.workspaceName).toBe('镜像工作空间');
    expect(VERSION_PATTERN.test(r.manifest.version)).toBe(true);
    const revalidated = validateSnapshotManifest(JSON.parse(JSON.stringify(r.manifest)));
    expect(revalidated).not.toBeNull();
    expect(revalidated).toEqual(r.manifest);

    // —— agentMembers：三分流 ——
    const cfg = r.manifest.config;
    const customEntry = cfg.agentMembers.find((m) => m.name === '自定义甲')!;
    expect(customEntry.customDefinition).toBeDefined();
    expect(customEntry.slug).toBeUndefined();
    const reparsed = parseAgentManifest(customEntry.customDefinition!);
    expect(reparsed.name).toBe('自定义甲');
    expect(reparsed.systemPrompt).toContain('自定义甲');
    const marketEntry = cfg.agentMembers.find((m) => m.name === '市场乙')!;
    expect(marketEntry).toMatchObject({ slug: 'market-agent' });
    expect(marketEntry.customDefinition).toBeUndefined();
    const builtinEntry = cfg.agentMembers.find((m) => m.name === '内置丙')!;
    expect(builtinEntry).toMatchObject({ slug: 'builtin-agent' });

    // —— teams：名字对齐（leader/members 均 agent 定义名）——
    expect(cfg.teams).toEqual([
      { name: '特别小组', leader: '市场乙', members: ['市场乙', '自定义甲'] },
    ]);

    // —— mcpEnabled：仅 stdio 启用面（url/禁用/plugin 来源全排除）——
    expect(cfg.mcpEnabled).toEqual(['my-tools', 'hub-tools']);

    // —— skills：三源全量 ——
    expect(cfg.skills).toContain('my-skill');
    expect(cfg.skills).toContain('market-skill');
    expect(cfg.skills).toContain('code-review'); // builtin（electron/resources/skills 实物）

    // —— pluginsEnabled + excluded ——
    expect(cfg.pluginsEnabled).toEqual([{ pluginId: 'hub-plugin', slug: 'hub-plugin' }]);
    expect(r.excludedPlugins).toEqual(['zip-plugin']);

    // —— providerRefs：类型+型号偏好，无 key ——
    expect(cfg.providerRefs).toContainEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(cfg.providerRefs).toContainEqual({ provider: 'openai' });

    // —— prefs ——
    expect(cfg.prefs.maxToolCalls).toBe(33);

    // —— resources 补装清单：hub 记账四类各一席；builtin/无记账不占位 ——
    expect(r.manifest.resources).toEqual(
      expect.arrayContaining([
        { type: 'agent', slug: 'market-agent' },
        { type: 'mcp', slug: 'hub-tools' },
        { type: 'skill', slug: 'market-skill' },
        { type: 'plugin', slug: 'hub-plugin' },
      ]),
    );
    expect(r.manifest.resources).not.toContainEqual({ type: 'agent', slug: 'builtin-agent' });
    expect(r.manifest.resources).toHaveLength(4);

    // —— tar 形态：manifest.json 在根 + custom skill 内嵌（安装标记排除）——
    const members = tarList(r.archivePath);
    expect(members).toContain('manifest.json');
    expect(members).toContain('skills/my-skill/SKILL.md');
    expect(members).toContain('skills/my-skill/notes.txt');
    expect(members.some((m) => m.endsWith('.sha256'))).toBe(false);
    const manifestInTar = JSON.parse(tarRead(r.archivePath, 'manifest.json')) as SnapshotManifest;
    expect(manifestInTar).toEqual(r.manifest);

    // —— checksum = 归档 sha256 ——
    const expectHash = crypto.createHash('sha256').update(fs.readFileSync(r.archivePath)).digest('hex');
    expect(r.checksum).toBe(expectHash);
  });

  it('空工作空间：空清单合法过自检，归档仅 manifest.json', async () => {
    const wsId = await mkWorkspace('空空间');
    const r = await buildWorkspaceSnapshot(wsId);
    expect(r.manifest.config.agentMembers).toEqual([]);
    expect(r.manifest.config.teams).toEqual([]);
    expect(validateSnapshotManifest(r.manifest)).not.toBeNull();
    expect(tarList(r.archivePath)).toEqual(['manifest.json']);
  });
});

// ── 1b. MCP 无记账告警（T8a 交接补丁——上批评审 Important）──────────────────

describe('modelBinding 可选段（D4）', () => {
  it('defaultChatModel 已设且 provider 在场 → 段入 manifest（platform 口径）+ 归档 + pin 校验兼容', async () => {
    const wsId = await mkWorkspace('绑定空间');
    const p = await createProvider({
      name: 'Anthropic 直连', baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-src-key-value-abcdef', platform: 'anthropic',
    });
    updateGlobalSettings({ defaultChatModel: { providerId: p.id, modelId: 'glm-5.3' } });

    const built = await buildWorkspaceSnapshot(wsId);

    expect(built.manifest.config.modelBinding).toEqual({ provider: 'anthropic', model: 'glm-5.3' });
    // 归档内 manifest.json 原样含段（hub 中转不经 pin 剥除）
    const manifestText = tarRead(built.archivePath, 'manifest.json');
    expect(manifestText).toContain('"modelBinding"');
    // pin 版 validateSnapshotManifest 对未知段容忍（剥除不拒）——1.2.0 兼容前提的行为锁
    expect(validateSnapshotManifest(built.manifest)).not.toBeNull();
  });

  it('未设 defaultChatModel → 段缺省不发（旧形态不变）', async () => {
    const wsId = await mkWorkspace('无绑定空间');
    const built = await buildWorkspaceSnapshot(wsId);
    expect(built.manifest.config).not.toHaveProperty('modelBinding');
    expect(validateSnapshotManifest(built.manifest)).not.toBeNull();
  });

  it('defaultChatModel 引用悬空 provider（行已删）→ 缺省不发 + warn 留痕', async () => {
    const wsId = await mkWorkspace('悬空空间');
    updateGlobalSettings({ defaultChatModel: { providerId: 'ghost-provider-id', modelId: 'glm-5.3' } });
    const built = await buildWorkspaceSnapshot(wsId);
    expect(built.manifest.config).not.toHaveProperty('modelBinding');
    expect(logger.warn).toHaveBeenCalledWith(
      'defaultChatModel 引用的 provider 不存在，快照不发模型绑定段',
      expect.objectContaining({ providerId: 'ghost-provider-id' }),
    );
  });
});

describe('defaultAgent 可选段（D2）', () => {
  it('源默认会话 agent 在册 → 段入 manifest（成员名口径）+ 归档原样含段', async () => {
    const wsId = await mkWorkspace('默认甲空间');
    const inst = await seedMember(wsId, 'def-default-a', '默认甲');

    setDefaultAgent(wsId, inst);
    const built = await buildWorkspaceSnapshot(wsId);

    expect(built.manifest.config.defaultAgent).toBe('默认甲');
    const manifestText = tarRead(built.archivePath, 'manifest.json');
    expect(manifestText).toContain('"defaultAgent"');
    expect(validateSnapshotManifest(built.manifest)).not.toBeNull();
  });

  it('未设默认 agent → 段缺省不发（悬空位由 FK 约束排除，无需分支）', async () => {
    const wsId = await mkWorkspace('无默认空间');
    const built = await buildWorkspaceSnapshot(wsId);
    expect(built.manifest.config).not.toHaveProperty('defaultAgent');
    expect(validateSnapshotManifest(built.manifest)).not.toBeNull();
  });
});

describe('MCP 无 hub 记账告警', () => {
  it('marketplace MCP 无记账 → logger.warn 且名字仍入清单（不占 resources 位）；custom 来源无记账不 warn', async () => {
    const wsId = await mkWorkspace('MCP 无记账空间');
    await seedMember(wsId, 'def-mcp-warn', '成员丙');
    registerMcpDefinition({
      id: randomUUID(), name: 'orphan-market-mcp', version: '1.0.0',
      command: 'npx', args: ['orphan-pkg'], source: 'marketplace',
    });
    registerMcpDefinition({
      id: randomUUID(), name: 'custom-no-acc', version: '1.0.0',
      command: 'npx', args: ['custom-pkg'], source: 'custom',
    });

    const r = await buildWorkspaceSnapshot(wsId);

    // 名字仍入清单（manifest 结构不变——T8b 应用器对解析失败给兜底语义）
    expect([...r.manifest.config.mcpEnabled].sort()).toEqual(['custom-no-acc', 'orphan-market-mcp']);
    // 不占 resources 补装位（无记账 → 对 hub 仓发起安装必然失败）
    expect(r.manifest.resources).not.toContainEqual({ type: 'mcp', slug: 'orphan-market-mcp' });

    // leader 可见信号：仅 marketplace 来源 warn 一次；custom 来源（本机自管重建）不 warn
    const warnsBy = (name: string): Array<Array<unknown>> =>
      vi.mocked(logger.warn).mock.calls.filter(
        (c) => (c[1] as { name?: string } | undefined)?.name === name,
      );
    expect(warnsBy('orphan-market-mcp')).toHaveLength(1);
    expect(String(warnsBy('orphan-market-mcp')[0]![0])).toContain('MCP 无 hub 记账');
    expect(warnsBy('custom-no-acc')).toHaveLength(0);
  });
});

// ── 1c. 已发布 custom skill 分桶（M2.2 UC-P1-3 分发闭环）──────────────────

describe('已发布 custom skill 走 hub 补装位（UC-P1-3）', () => {
  it('custom skill + hub 记账 → 占 resources 补装位且不内嵌（hub 为已发布面的权威源）', async () => {
    const wsId = await mkWorkspace('发布闭环空间');
    seedCustomSkill('pub-skill', '已发布正文');
    seedCustomSkill('keep-skill', '未发布正文');
    seedHubAccounting('skill', 'pub-skill');

    const r = await buildWorkspaceSnapshot(wsId);

    // slug 仍全量入清单（目标节点解析口径不变）
    expect(r.manifest.config.skills).toEqual(expect.arrayContaining(['pub-skill', 'keep-skill']));
    // 已发布 → 占 resources 补装位（全新目标节点经 installResources 从 hub 落装并记账 hub:{slug}）
    expect(r.manifest.resources).toContainEqual({ type: 'skill', slug: 'pub-skill' });
    expect(r.manifest.resources).not.toContainEqual({ type: 'skill', slug: 'keep-skill' });
    // 不内嵌：归档无 skills/pub-skill/（双通道并存会让目标节点同 slug 两份分叉）
    const members = tarList(r.archivePath);
    expect(members.some((m) => m.startsWith('skills/pub-skill/'))).toBe(false);
    // 未发布 custom → 内嵌行为不变（回归锁）
    expect(members).toContain('skills/keep-skill/SKILL.md');
    // summary 分桶计数（P2-6 行数据源）：1 补装 + 1 内嵌
    expect(r.manifest.resources.filter((x) => x.type === 'skill')).toHaveLength(1);
    expect(r.skillEmbeddedCount).toBe(1);
    expect(validateSnapshotManifest(r.manifest)).not.toBeNull();
  });

  it('marketplace skill 无记账 → 聚合计数 warn 一行（只进清单，不占 resources 不内嵌）；custom/builtin/有记账不 warn', async () => {
    const wsId = await mkWorkspace('skill 无记账告警空间');
    seedMarketplaceSkillRow('orphan-market-skill');
    seedMarketplaceSkillRow('accounted-market-skill');
    seedHubAccounting('skill', 'accounted-market-skill');
    seedCustomSkill('plain-custom-skill');

    const r = await buildWorkspaceSnapshot(wsId);

    // 三源 slug 全量入清单（口径不变）
    expect(r.manifest.config.skills).toEqual(
      expect.arrayContaining(['orphan-market-skill', 'accounted-market-skill', 'plain-custom-skill']),
    );
    // 有记账才占补装位；无记账 marketplace 不占（对 hub 仓发起安装必然失败）
    expect(r.manifest.resources).toContainEqual({ type: 'skill', slug: 'accounted-market-skill' });
    expect(r.manifest.resources).not.toContainEqual({ type: 'skill', slug: 'orphan-market-skill' });
    // custom 无记账仍内嵌（回归锁）
    expect(tarList(r.archivePath)).toContain('skills/plain-custom-skill/SKILL.md');

    // leader 可见信号：聚合计数恰一行（count + slugs 定位），命中集只含无记账 marketplace 项
    const warnCalls = vi.mocked(logger.warn).mock.calls.filter(
      (c) => String(c[0]).includes('skill 无 hub 记账'),
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![1]).toMatchObject({ count: 1, slugs: ['orphan-market-skill'] });
  });

  // M2.4 T4：listInstalled 是多源拼接（builtin → marketplace 表 → custom 目录），同 slug
  // 可在两源各出一行（已发布 custom skill：hub 安装行 + 本机 custom 目录）。清单是「slug
  // 名单」语义须去重；resources 侧由 buildWorkspaceSnapshot 收口处的 type+slug 全局去重
  // （snapshot-builder.ts:477-484）恒为 1 条——本批只补 skills 清单，不动该去重。
  it('同 slug 双源均已安装 → config.skills 去重 1 条（首见位）+ resources 经全局去重 1 条', async () => {
    const wsId = await mkWorkspace('同 slug 双源空间');
    seedMarketplaceSkillRow('a-market');
    seedMarketplaceSkillRow('dup-skill'); // hub 安装行（marketplace 表同表）
    seedCustomSkill('dup-skill'); // 本机 custom 目录同名（已发布来源）
    seedHubAccounting('skill', 'dup-skill');

    const r = await buildWorkspaceSnapshot(wsId);

    // 清单去重且保首见序：dup 首见于 marketplace 段（a-market 之后、custom 段之前）
    const skills = r.manifest.config.skills;
    expect(skills.filter((s) => s === 'dup-skill')).toHaveLength(1);
    expect(skills.indexOf('dup-skill')).toBe(skills.indexOf('a-market') + 1);
    // resources 面零变化：collectSkills 内不去重，但 builder 收口处既有 type+slug 去重
    // 仍只占一席（本改动不波及条数与顺序）
    expect(r.manifest.resources.filter((x) => x.type === 'skill')).toEqual([
      { type: 'skill', slug: 'dup-skill' },
    ]);
    expect(validateSnapshotManifest(r.manifest)).not.toBeNull();
  });
});

// ── 2. 红线零渗漏（真实敏感材料在场）──────────────────────────────────────

describe('红线零渗漏', () => {
  it('provider key（keychain 实值）/ url-MCP 凭证头在源数据真实在场 → 归档全文零踪迹', async () => {
    const wsId = await mkWorkspace('红线空间');
    await seedMember(wsId, 'def-clean', '干净甲');

    await createProvider({
      name: 'P', baseUrl: 'https://api.example.com',
      apiKey: 'sk-provider-key-value-abcdef', platform: 'openai', defaultModel: 'gpt-x',
    });
    registerMcpDefinition({
      id: randomUUID(), name: 'remote-mcp', version: '1.0.0', transport: 'streamable_http',
      command: '', args: [], url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token-abcdef123', 'X-Api-Key': 'xkey-987654321' },
      source: 'custom',
    });

    const r = await buildWorkspaceSnapshot(wsId);
    const allText = tarAllText(r.archivePath);

    // 已知 key 实值零包含（keychain 里的值绝不序列化）
    expect(allText).not.toContain('sk-provider-key-value-abcdef');
    // url-MCP 凭证头零踪迹（url 形态整体不入清单；凭证头字段名与值均无）
    expect(allText).not.toContain('secret-token-abcdef123');
    expect(allText.toLowerCase()).not.toContain('authorization');
    expect(allText.toLowerCase()).not.toContain('x-api-key');
    expect(allText).not.toContain('https://example.com/mcp');
    // remote-mcp 名字不入启用清单
    expect(r.manifest.config.mcpEnabled).not.toContain('remote-mcp');
  });
});

// ── 3. 红线变异四连（人为塞入即红——Review Focus #4）───────────────────────

describe('红线变异验证', () => {
  it('变异 a：provider 段塞 apiKey 字段 → 结构扫描红（路径定位）', () => {
    const mutated = {
      config: { providerRefs: [{ provider: 'openai', apiKey: 'sk-mut-1234567890' }] },
    };
    const violations = findForbiddenFields(mutated);
    expect(violations.some((v) => v.where.includes('apiKey'))).toBe(true);
  });

  it('变异 a2：url-MCP 凭证头字段（headers/Authorization）任意位置 → 结构扫描红', () => {
    const mutated = {
      config: { mcp: { headers: { Authorization: 'Bearer xyz' } } },
    };
    const violations = findForbiddenFields(mutated);
    const paths = violations.map((v) => v.where).join('\n');
    expect(paths).toContain('headers');
    expect(paths).toContain('Authorization');
  });

  it('变异 b：sk- 前缀 key 值 / Bearer 凭证值 → 文本值扫描红', () => {
    expect(scanTextForSecrets('{"apiKey":"sk-mutation-value-12345"}', 'x')).not.toEqual([]);
    expect(scanTextForSecrets('Authorization: Bearer abcdef1234567890abc', 'x')).not.toEqual([]);
    // 干净文本不误杀
    expect(scanTextForSecrets('你是快照测试 agent，型号 glm-5.3', 'x')).toEqual([]);
  });

  it('变异 c：custom agent prompt 内嵌 key 值 → buildWorkspaceSnapshot 整体 reject（fail-closed）', async () => {
    const wsId = await mkWorkspace('变异空间');
    await seedMember(wsId, 'def-leak', '渗漏甲', {
      systemPrompt: '调用外部服务时使用密钥 sk-leak-0000111122223333',
    });
    await expect(buildWorkspaceSnapshot(wsId)).rejects.toThrow(/红线校验失败/);
  });

  it('变异 d：custom skill 文件内嵌 ghp_ token → buildWorkspaceSnapshot 整体 reject', async () => {
    const wsId = await mkWorkspace('变异空间二');
    await seedMember(wsId, 'def-clean2', '干净乙');
    seedCustomSkill('leak-skill', '\n备用 token: ghp_aaaaaaaaaaaaaaaaaaaa');
    await expect(buildWorkspaceSnapshot(wsId)).rejects.toThrow(/红线校验失败/);
  });

  it('变异 e：knownSecrets 已知实值回填缝——包含比对红', () => {
    const violations = scanTextForSecrets('正文里混着 MY_SECRET_VALUE_99', 'f', ['MY_SECRET_VALUE_99']);
    expect(violations.some((v) => v.detail.includes('已知凭证实值'))).toBe(true);
  });
});

// ── 4. 静态源码断言：聊天历史零查询 ────────────────────────────────────────

describe('静态红线：不触碰聊天历史', () => {
  it('构建器源码（剥注释后的代码）无 message_events 表查询（聊天历史唯一真相源表）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/main/hub/snapshot-builder.ts'),
      'utf-8',
    );
    // 头注释/文档注释里的红线声明本身含表名——只对代码断言（纪律：无该表查询，而非无该词）
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toContain('message_events');
    expect(codeOnly).not.toContain('messageEvents');
  });
});

// ── 5. 错误路径 ───────────────────────────────────────────────────────────

describe('错误路径', () => {
  it('工作空间不存在 → 人话拒绝', async () => {
    await expect(buildWorkspaceSnapshot('ws-nope')).rejects.toThrow(/工作空间不存在/);
  });

  it('历史脏定义（空 systemPrompt 的 custom 定义，YAML 不可逆）→ 拒绝穿透进 manifest', async () => {
    const wsId = await mkWorkspace('脏定义空间');
    await seedMember(wsId, 'def-dirty', '脏甲', { systemPrompt: '' });
    await expect(buildWorkspaceSnapshot(wsId)).rejects.toThrow(/历史脏定义/);
  });

  it('leader 定义被删 → schema 级联清团队（teams.leader FK CASCADE）→ 快照无半截团队', async () => {
    const wsId = await mkWorkspace('级联空间');
    const a = await seedMember(wsId, 'def-t1', '成员甲');
    const b = await seedMember(wsId, 'def-t2', '成员乙');
    createTeam(wsId, '级联团', '👥', [a, b], b);
    // 删 leader 定义行：agent_definitions → workspace_agent_members → teams 三级 CASCADE，
    // 「悬空 leader」状态被 schema 消解——快照只见干净面（构建器内防御分支由此不可达）
    getDb().prepare('DELETE FROM agent_definitions WHERE id = ?').run('def-t2');
    const r = await buildWorkspaceSnapshot(wsId);
    expect(r.manifest.config.teams).toEqual([]);
    expect(r.manifest.config.agentMembers.map((m) => m.name)).toEqual(['成员甲']);
  });
});
