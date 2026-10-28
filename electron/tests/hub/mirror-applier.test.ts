// electron/tests/hub/mirror-applier.test.ts
//
// 镜像应用器矩阵（momo-hub M2 spec §5.2 第 4 步 / T8b，目标节点侧）：
//   1. 新建直落：工作空间不存在 → 创建 + 七子段整体替换（含先装后落顺序观测）
//   2. confirm 分流：存在且未 confirm → conflict + 差异摘要；confirm=true → 替换
//   3. 差异摘要计数：七子段逐域 added/removed/changed 精确断言
//   4. 补装顺序与跳过：hub 记账命中跳过 / 本地点位在位跳过 / 缺失补装；
//      补装时工作空间已创建但配置未落（先装后落）
//   5. 补装失败中止：配置不落、目标保持原状；在途释放后重试成功（幂等）
//   6. 并发对账：同 workspaceName 在途 → conflict mirror_in_progress
//   7. unresolved 语义：目标无法解析的引用（mcp/agent/skill/plugin/provider）
//      软失败入回执、不阻断镜像
//   8. 入参闸：strategy 非 replace / workspaceName 越界 → bad_request
//   9. 校验失败：checksum 不符 → 快照取包失败（not_found 语义）
//  10. 契约测试：T7 构建器真实产出（buildWorkspaceSnapshot 归档）→ 应用器直接消费
//
// 环境注：真实 DB + 真实 fs + 真实 tar（AP_USER_DATA_DIR 注入）；mock 只收窄在
// 网络边界（快照下载字节 / hub 资源安装链），与 snapshot-builder.test.ts 同款。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, addMember, updateAgentDefinition } from '../../src/main/agent/crud';
import { createTeam } from '../../src/main/agent/team';
import { createProvider, listProviders, providerApiKeyRef } from '../../src/main/agent/provider-crud';
import { registerMcpDefinition, setMcpEnabledDefinition, listRegistered } from '../../src/main/mcp/host-manager';
import { upsertPlugin, setPluginEnabled, isPluginEnabled } from '../../src/main/plugin/registry';
import { createWorkspace, listWorkspaces, getWorkspace, setDefaultAgent } from '../../src/main/workspace/crud';
import { getGlobalSettings, updateGlobalSettings } from '../../src/main/settings/crud';
import { listInstalled } from '../../src/main/skill/zip-uploader';
import { listMembers, getAgentDefinition, listAgentDefinitions } from '../../src/main/agent/agent-queries';
import { listTeams } from '../../src/main/agent/team';
import type { SnapshotModelBinding } from '../../src/main/hub/snapshot-model-binding';

// 进程边界替身（snapshot-builder.test.ts 同款——applier → hub-install → momo-hub 链）
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/hub/client', () => ({
  createHubClient: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), state: (): string => 'disconnected' })),
  enrollOverHttp: vi.fn(async () => ({ nodeId: 'node-1', deviceToken: 'tok-1' })),
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyMirrorSnapshot } from '../../src/main/hub/mirror-applier';
import { HubCatalogStaleError } from '../../src/main/resource/hub-install';
import { buildWorkspaceSnapshot } from '../../src/main/hub/snapshot-builder';
import { agentManifestYaml } from '../../src/main/hub/publish';
import type { MirrorApplierDeps } from '../../src/main/hub/mirror-applier';
import type { SnapshotManifest } from '../../src/main/hub/protocol';
import type { AgentDefinition } from '../../src/main/agent/types';

const execFileAsync = promisify(execFile);

// ── 环境脚手架 ────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mirror-'));
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

// ── 快照归档构造（真实 tar——生产解包路径的同款输入）───────────────────────

interface ArchiveFixture { bytes: Buffer; checksum: string; manifest: SnapshotManifest }

/** manifest + 可选附加文件（relPath → content）→ tar.gz 字节 + sha256。
 *  入参放宽：可携带 modelBinding / defaultAgent 可选段（pin 类型尚未含段——
 *  补位纪律同源）。 */
type ManifestWithOptionalSegments = Omit<SnapshotManifest, 'config'> & {
  config: SnapshotManifest['config'] & { modelBinding?: SnapshotModelBinding; defaultAgent?: string };
};

async function makeArchive(
  manifest: SnapshotManifest | ManifestWithOptionalSegments,
  extraFiles: Record<string, string> = {},
): Promise<ArchiveFixture> {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'fixture-'));
  try {
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const [rel, content] of Object.entries(extraFiles)) {
      const target = path.join(stage, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const archive = path.join(stage, 'fixture.tar.gz');
    const entries = ['manifest.json', ...Object.keys(extraFiles)];
    await execFileAsync('tar', ['czf', archive, '-C', stage, ...entries]);
    const bytes = fs.readFileSync(archive);
    return { bytes, checksum: crypto.createHash('sha256').update(bytes).digest('hex'), manifest };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 基础合法 manifest（七子段空——各用例按需覆写）。 */
function baseManifest(overrides?: {
  workspaceName?: string;
  resources?: SnapshotManifest['resources'];
  /** modelBinding / defaultAgent 可选段——pin 类型补位（snapshot-model-binding.ts 同源） */
  config?: Partial<SnapshotManifest['config']> & {
    modelBinding?: SnapshotModelBinding;
    defaultAgent?: string;
  };
}): SnapshotManifest {
  return {
    workspaceName: overrides?.workspaceName ?? 'prod-dev',
    version: '20261025.010203.abcd',
    resources: overrides?.resources ?? [],
    config: {
      agentMembers: [],
      teams: [],
      mcpEnabled: [],
      skills: [],
      pluginsEnabled: [],
      providerRefs: [],
      prefs: {},
      ...overrides?.config,
    },
  };
}

/** 构造内嵌 custom 定义 YAML（与构建器同函数——可逆契约）。 */
function customYaml(name: string, slug: string, prompt = `你是 ${name}`): string {
  const def: AgentDefinition = {
    id: `def-${slug}`,
    name,
    slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: prompt,
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  };
  return agentManifestYaml(def);
}

// ── 数据种子 ──────────────────────────────────────────────────────────────

async function mkWorkspace(name: string): Promise<string> {
  const ws = await createWorkspace(
    { name, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner',
  );
  return ws.id;
}

async function seedCustomMember(wsId: string, name: string, slug: string): Promise<string> {
  saveAgentDefinition({
    id: `def-${slug}`,
    name,
    slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: `你是 ${name}`,
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  });
  const m = await addMember(wsId, `def-${slug}`, `@${slug}:momo.local`);
  return m.instanceId;
}

function seedHubAccounting(itemType: 'agent' | 'skill' | 'mcp' | 'plugin', slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), `hub:${slug}`, itemType, slug, '1.0.0', path.join(tmpRoot, 'cache', slug), '');
}

function registerStdioMcp(name: string, opts: { enabled?: boolean } = {}): void {
  registerMcpDefinition({
    id: randomUUID(), name, version: '1.0.0',
    command: 'npx', args: [`${name}-pkg`], source: 'custom',
  });
  if (opts.enabled === false) setMcpEnabledDefinition(name, false);
}

function seedPluginRow(id: string): void {
  upsertPlugin({
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({ id, version: '0.1.0' }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: new Date().toISOString(),
  });
}

/** 网络边界替身：快照字节固定供应；安装链记录调用序并仿真真实副作用
 *  （agent 安装会落定义——member 解析依赖该语义，mock 简化即失真）。 */
interface RecordedDeps extends MirrorApplierDeps {
  installLog: string[];
  installedSlugs: string[];
}

function makeDeps(archive: ArchiveFixture, opts: { failOn?: string } = {}): RecordedDeps {
  const installLog: string[] = [];
  const installedSlugs: string[] = [];
  const deps: RecordedDeps = {
    installLog,
    installedSlugs,
    fetchSnapshotArchive: async () => ({ bytes: archive.bytes, checksum: archive.checksum }),
    installResource: async (type, slug) => {
      // 先装后落观测点：补装发生时（a）工作空间已创建（b）成员尚未落
      installLog.push(`${type}/${slug}`);
      if (opts.failOn === `${type}/${slug}`) throw new Error(`hub 资源仓中不存在 ${type} 资源 ${type}/${slug}`);
      installedSlugs.push(slug);
      if (type === 'agent') {
        saveAgentDefinition({
          id: `def-${slug}`,
          name: slug,
          slug,
          version: '1.0.0',
          runtime: 'declarative',
          systemPrompt: `你是 ${slug}`,
          defaultTools: [],
          source: 'marketplace',
          description: '',
          iconEmoji: '🤖',
          defaultMcps: [],
          defaultSkills: [],
          workspaceId: null,
          modelProviderId: null,
          modelName: 'glm-5.3',
        });
      }
    },
  };
  return deps;
}

function applyPayload(partial: Partial<{ mirrorId: string; snapshotId: string; workspaceName: string; strategy: string; confirm: boolean }>) {
  return {
    mirrorId: partial.mirrorId ?? randomUUID(),
    snapshotId: partial.snapshotId ?? randomUUID(),
    workspaceName: partial.workspaceName ?? 'prod-dev',
    strategy: (partial.strategy ?? 'replace') as 'replace',
    ...(partial.confirm !== undefined ? { confirm: partial.confirm } : {}),
  };
}

// ── 1+4. 新建直落 + 七子段 + 先装后落 ────────────────────────────────────

describe('applyMirrorSnapshot 新建直落', () => {
  it('工作空间不存在 → 创建 + 七子段整体替换 + 补装顺序（先装后落）+ unresolved 软失败', async () => {
    registerStdioMcp('my-tools');               // 目标已有同名 MCP → 启用对齐
    registerStdioMcp('ghost-mcp');              // 目标可解析（在场）→ 名单启用
    seedPluginRow('hub-plugin');                // 插件在场 → 启用面打开
    await createProvider({ name: '主供', baseUrl: 'https://api.example.com', apiKey: 'sk-target-key-000000', platform: 'openai' });

    const manifest = baseManifest({
      resources: [
        { type: 'agent', slug: 'market-agent' },   // 无记账无本地 → 补装
        { type: 'skill', slug: 'accounted-skill' }, // 有记账 → 跳过
        { type: 'mcp', slug: 'present-mcp' },       // 本地点位在位（注册名命中）→ 跳过
      ],
      config: {
        agentMembers: [
          { name: '镜像甲', customDefinition: customYaml('镜像甲', 'mirror-a') },
          { name: '市场乙', slug: 'market-agent' },
          { name: '幽灵丙', slug: 'ghost-agent' }, // 无从解析 → unresolved
        ],
        teams: [
          { name: '镜像组', leader: '镜像甲', members: ['镜像甲', '市场乙'] },
        ],
        mcpEnabled: ['my-tools', 'ghost-mcp', 'ghost-mcp-2'], // ghost-mcp-2 未注册 → unresolved
        skills: ['my-skill', 'ghost-skill'],                  // my-skill 内嵌包 → 落位；ghost → unresolved
        pluginsEnabled: [{ pluginId: 'hub-plugin', slug: 'hub-plugin' }, { pluginId: 'ghost-plugin', slug: 'ghost-plugin' }],
        providerRefs: [{ provider: 'openai', model: 'glm-5.3' }, { provider: 'anthropic' }], // anthropic 本机无 → unresolved
        prefs: { maxToolCalls: 33, memoryEnabled: true },
      },
    });
    const archive = await makeArchive(manifest, {
      'skills/my-skill/SKILL.md': '---\nname: my-skill 名\ndescription: 内嵌\nversion: 0.3.0\n---\n\n正文',
      'skills/my-skill/notes.txt': '附加资源',
    });

    seedHubAccounting('skill', 'accounted-skill');
    registerStdioMcp('present-mcp');
    const deps = makeDeps(archive);

    const outcome = await applyMirrorSnapshot(applyPayload({}), deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.appliedResources).toEqual(['agent/market-agent']); // 记账命中/本地点位在位均跳过
    expect(outcome.unresolvedRefs).toEqual([
      'agent:ghost-agent',
      'mcp:ghost-mcp-2',
      'skill:ghost-skill',
      'plugin:ghost-plugin',
      'provider:anthropic',
    ]);

    // 先装后落：补装时工作空间已创建（ensureWorkspace 先行）且成员为零
    expect(deps.installLog).toEqual(['agent/market-agent']);

    // 工作空间按名创建
    const ws = listWorkspaces().find((w) => w.name === 'prod-dev');
    expect(ws).toBeDefined();

    // 成员：镜像甲（custom 内嵌重建）+ 市场乙（补装后定义解析，定义名=slug——
    // mock 安装链副作用形态）；幽灵丙软失败不入
    const members = listMembers(ws!.id);
    expect(members.map((m) => m.agentName).sort()).toEqual(['market-agent', '镜像甲']);

    // 团队按名重建（leader=镜像甲；成员以 manifest 名对齐）
    const teams = listTeams(ws!.id);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.name).toBe('镜像组');
    expect(teams[0]!.members.map((m) => m.agentName).sort()).toEqual(['market-agent', '镜像甲']);

    // MCP：名单内启用；名单外（present-mcp 同为 stdio custom）整体替换 → 禁用
    const byName = new Map(listRegistered().map((m) => [m.name, m.enabled]));
    expect(byName.get('my-tools')).toBe(true);
    expect(byName.get('ghost-mcp')).toBe(true);
    expect(byName.get('present-mcp')).toBe(false);

    // skill：内嵌 custom 落位（.sha256 标记 = listInstalled custom 判定源）
    const skill = listInstalled().find((s) => s.slug === 'my-skill');
    expect(skill?.source).toBe('custom');

    // 插件：本工作空间启用面打开
    expect(isPluginEnabled('hub-plugin', ws!.id)).toBe(true);

    // provider 引用对齐：本机 key 不动（keychain 实值仍在）、defaultModel 对齐
    const provider = listProviders().find((p) => p.platform === 'openai');
    expect(provider?.defaultModel).toBe('glm-5.3');
    expect(memStore.get(provider ? providerApiKeyRef(provider.id) : '')).toBe('sk-target-key-000000');

    // prefs 白名单键覆盖
    expect(getGlobalSettings().maxToolCalls).toBe(33);
  });
});

// ── 2. confirm 分流 ───────────────────────────────────────────────────────

describe('applyMirrorSnapshot confirm 分流', () => {
  it('存在且未 confirm → conflict + 差异摘要；confirm=true → 整体替换', async () => {
    const wsId = await mkWorkspace('prod-dev');
    await seedCustomMember(wsId, '旧成员', 'old-member');
    registerStdioMcp('my-tools');

    const manifest = baseManifest({
      config: {
        agentMembers: [{ name: '新成员', customDefinition: customYaml('新成员', 'new-member') }],
        mcpEnabled: ['my-tools'],
        prefs: { maxToolCalls: 33 },
      },
    });
    const archive = await makeArchive(manifest);
    const deps = makeDeps(archive);

    const conflict = await applyMirrorSnapshot(applyPayload({}), deps);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe('conflict');
    expect(conflict.diffSummary).toEqual({ added: 1, removed: 1, changed: 1 }); // 成员±1 + prefs 变更 1
    // conflict 早退：配置未动
    expect(listMembers(wsId)).toHaveLength(1);
    expect(getGlobalSettings().maxToolCalls).toBe(50);

    const confirmed = await applyMirrorSnapshot(applyPayload({ confirm: true }), deps);
    expect(confirmed.ok).toBe(true);
    const members = listMembers(wsId);
    expect(members.map((m) => m.agentName)).toEqual(['新成员']);
    expect(getGlobalSettings().maxToolCalls).toBe(33);
  });
});

// ── 3. 差异摘要计数专项 ───────────────────────────────────────────────────

describe('computeDiffSummary 七子段计数（经 conflict 路径断言）', () => {
  it('成员/团队/MCP/skill/插件/provider/prefs 各域精确计数', async () => {
    const wsId = await mkWorkspace('prod-dev');
    await seedCustomMember(wsId, '保留甲', 'keep-a');
    await seedCustomMember(wsId, '多余乙', 'extra-b');
    const mateA = await seedCustomMember(wsId, '队友甲', 'mate-a');
    const mateB = await seedCustomMember(wsId, '队友乙', 'mate-b');
    createTeam(wsId, '变更组', '👥', [mateA, mateB], mateA);

    registerStdioMcp('kept-mcp');
    registerStdioMcp('dropped-mcp');
    seedPluginRow('kept-plugin');
    seedPluginRow('dropped-plugin');
    setPluginEnabled('kept-plugin', wsId, true);
    setPluginEnabled('dropped-plugin', wsId, true);
    await createProvider({ name: 'P1', baseUrl: 'https://a.example.com', apiKey: 'sk-a-000000000000', platform: 'openai' });

    const manifest = baseManifest({
      config: {
        // 成员：保留甲（同名同 custom 键 → 无差异）+ 新成员（added）
        agentMembers: [
          { name: '保留甲', customDefinition: customYaml('保留甲', 'keep-a') },
          { name: '新成员', customDefinition: customYaml('新成员', 'brand-new') },
        ],
        // 团队：变更组成员集变化（changed）；旧组/队友们不在快照（removed 计旧组 1——多余乙组的成员行也是 removed）
        teams: [{ name: '变更组', leader: '队友乙', members: ['队友甲', '队友乙', '新成员'] }],
        mcpEnabled: ['kept-mcp', 'added-mcp'],
        skills: ['builtin-skill-ghost'], // 目标无 → added
        pluginsEnabled: [{ pluginId: 'kept-plugin', slug: 'kept-plugin' }],
        providerRefs: [{ provider: 'openai' }, { provider: 'anthropic' }], // anthropic 缺 → added
        prefs: { maxToolCalls: 50, maxConcurrentTasks: 9 }, // maxToolCalls 同值；并发数变更 → changed 1
      },
    });
    const outcome = await applyMirrorSnapshot(applyPayload({}), makeDeps(await makeArchive(manifest)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 成员：新成员 added 1；多余乙/队友甲/队友乙 removed 3（保留甲同键无差异）
    // 团队：变更组 leader+成员集变化 changed 1（无整队增删）
    // MCP：added-mcp added 1；dropped-mcp removed 1
    // skill：builtin-skill-ghost added 1；插件：dropped-plugin removed 1
    // provider：anthropic 缺席 added 1；prefs：maxConcurrentTasks 3→9 changed 1
    expect(outcome.diffSummary).toEqual({ added: 4, removed: 5, changed: 2 });
  });
});

// ── 5. 补装失败中止 + 幂等重试 ────────────────────────────────────────────

describe('applyMirrorSnapshot 补装失败中止', () => {
  it('任一资源失败 → 配置不落、目标保持原状；重试成功（已装资源保留幂等）', async () => {
    const wsId = await mkWorkspace('prod-dev');
    await seedCustomMember(wsId, '旧成员', 'old-member');
    updateGlobalSettings({ maxToolCalls: 50 });

    const manifest = baseManifest({
      resources: [
        { type: 'agent', slug: 'ok-agent' },
        { type: 'skill', slug: 'bad-skill' },
      ],
      config: {
        agentMembers: [{ name: '新成员', customDefinition: customYaml('新成员', 'new-member') }],
        prefs: { maxToolCalls: 33 },
      },
    });
    const archive = await makeArchive(manifest);
    const failDeps = makeDeps(archive, { failOn: 'skill/bad-skill' });

    const failed = await applyMirrorSnapshot(applyPayload({ confirm: true }), failDeps);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.code).toBe('internal');
    expect(failed.message).toContain('资源补装失败');
    expect(failed.message).toContain('配置未落库');
    // 中止语义：配置零写入
    expect(listMembers(wsId).map((m) => m.agentName)).toEqual(['旧成员']);
    expect(getGlobalSettings().maxToolCalls).toBe(50);
    // 已装资源保留（ok-agent 已落定义——幂等重试的跳过基础）
    expect(failDeps.installedSlugs).toEqual(['ok-agent']);

    // 重试：ok-agent 本地点位在位 → 跳过；bad-skill 成功 → 整体落库
    const retryDeps = makeDeps(archive);
    const retried = await applyMirrorSnapshot(applyPayload({ confirm: true }), retryDeps);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.appliedResources).toEqual(['skill/bad-skill']); // ok-agent 不重复装
    expect(listMembers(wsId).map((m) => m.agentName)).toEqual(['新成员']);
    expect(getGlobalSettings().maxToolCalls).toBe(33);
  });
});

// ── 5b. 补装遇 stale 目录：跳过并记 unresolvedRefs（其余资源继续）──────────

describe('applyMirrorSnapshot 补装 stale 目录（M2.4 T1）', () => {
  /** stale 抛错的可控安装链：staleOn 资源抛 HubCatalogStaleError，其余照常落装 */
  function makeStaleDeps(
    archive: ArchiveFixture,
    opts: { staleOn?: string; failOn?: string } = {},
  ): RecordedDeps {
    const deps = makeDeps(archive, opts.failOn ? { failOn: opts.failOn } : {});
    const base = deps.installResource!;
    deps.installResource = async (type, slug, workspaceId) => {
      if (opts.staleOn === `${type}/${slug}`) {
        deps.installLog.push(`${type}/${slug}`); // 尝试序观测（抛出前记录）
        throw new HubCatalogStaleError('无法连接到 momo-hub 获取最新目录（已装版本保持不变），请稍后重试');
      }
      await base(type, slug, workspaceId);
    };
    return deps;
  }

  it('stale 抛错 → 该资源跳过 + unresolvedRefs 记原因，其余资源仍装成功（整体 ok）', async () => {
    const wsId = await mkWorkspace('prod-dev');
    const manifest = baseManifest({
      resources: [
        { type: 'agent', slug: 'ok-first' },
        { type: 'skill', slug: 'stale-skill' },
        { type: 'agent', slug: 'ok-second' },
      ],
    });
    const archive = await makeArchive(manifest);
    const deps = makeStaleDeps(archive, { staleOn: 'skill/stale-skill' });

    const outcome = await applyMirrorSnapshot(applyPayload({ confirm: true }), deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // stale 资源跳过、不中止：其余资源照常补装
    expect(outcome.appliedResources).toEqual(['agent/ok-first', 'agent/ok-second']);
    expect(deps.installLog).toEqual(['agent/ok-first', 'skill/stale-skill', 'agent/ok-second']);
    // 跳过原因压入既有 unresolvedRefs（不新增回执字段）
    expect(outcome.unresolvedRefs).toEqual([
      'skill:stale-skill（无法获取 hub 最新目录，已跳过）',
    ]);
    expect(listAgentDefinitions().some((d) => d.slug === 'ok-first')).toBe(true);
    expect(listAgentDefinitions().some((d) => d.slug === 'ok-second')).toBe(true);
    // 配置落库未被 stale 跳过阻断（工作空间已是目标态）
    expect(listWorkspaces().some((w) => w.id === wsId)).toBe(true);
  });

  it('非 stale 错误仍整体中止（即使前一项 stale 已跳过）', async () => {
    const wsId = await mkWorkspace('prod-dev');
    await seedCustomMember(wsId, '旧成员', 'old-member');
    updateGlobalSettings({ maxToolCalls: 50 });
    const manifest = baseManifest({
      resources: [
        { type: 'skill', slug: 'stale-skill' },
        { type: 'agent', slug: 'bad-agent' },
      ],
      config: { prefs: { maxToolCalls: 33 } },
    });
    const archive = await makeArchive(manifest);
    const deps = makeStaleDeps(archive, { staleOn: 'skill/stale-skill', failOn: 'agent/bad-agent' });

    const outcome = await applyMirrorSnapshot(applyPayload({ confirm: true }), deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('internal');
    expect(outcome.message).toContain('资源补装失败');
    expect(outcome.message).toContain('配置未落库');
    // 中止语义：配置零写入（prefs 保持原值），stale 的软失败不掩盖真失败
    expect(getGlobalSettings().maxToolCalls).toBe(50);
    expect(listMembers(wsId).map((m) => m.agentName)).toEqual(['旧成员']);
  });
});

// ── 6. 并发对账 ───────────────────────────────────────────────────────────

describe('applyMirrorSnapshot 并发对账', () => {
  it('同 workspaceName 在途 → 第二发 conflict mirror_in_progress', async () => {
    const archive = await makeArchive(baseManifest());
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deps: MirrorApplierDeps = {
      fetchSnapshotArchive: async () => {
        await gate; // 第一发挂在取包阶段（在途窗口）
        return { bytes: archive.bytes, checksum: archive.checksum };
      },
      installResource: async () => undefined,
    };
    const first = applyMirrorSnapshot(applyPayload({ confirm: true }), deps);
    await new Promise<void>((resolve) => setImmediate(resolve)); // 第一发已进入在途

    const second = await applyMirrorSnapshot(applyPayload({ confirm: true }), makeDeps(archive));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('conflict');
    expect(second.message).toContain('mirror_in_progress');

    releaseFirst!(); // Promise executor 内赋值——TS 流分析不可达，非空断言直呼
    const firstOutcome = await first;
    expect(firstOutcome.ok).toBe(true);
  });
});

// ── 8+9. 入参闸与校验失败 ─────────────────────────────────────────────────

describe('applyMirrorSnapshot 入参闸与校验', () => {
  it('strategy 非 replace → bad_request；workspaceName 空 → bad_request', async () => {
    const archive = await makeArchive(baseManifest());
    const deps = makeDeps(archive);
    const badStrategy = await applyMirrorSnapshot(
      applyPayload({ strategy: 'merge' as unknown as 'replace' }), deps,
    );
    expect(badStrategy).toMatchObject({ ok: false, code: 'bad_request' });
    const badName = await applyMirrorSnapshot(applyPayload({ workspaceName: '' }), deps);
    expect(badName).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('checksum 不符 → 快照取包失败（目标零写入）', async () => {
    const archive = await makeArchive(baseManifest());
    const deps: MirrorApplierDeps = {
      fetchSnapshotArchive: async () => ({ bytes: archive.bytes, checksum: '0'.repeat(64) }),
      installResource: async () => undefined,
    };
    const outcome = await applyMirrorSnapshot(applyPayload({}), deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('not_found');
    expect(outcome.message).toContain('快照校验失败');
    expect(listWorkspaces()).toHaveLength(0);
  });
});

// ── 10. 契约测试：构建器真实产出 → 应用器直接消费 ─────────────────────────

describe('applyMirrorSnapshot modelBinding 段（D4 / RM2-10）', () => {
  it('段在场 → 写目标默认模型偏好（provider.defaultModel + defaultChatModel）+ 成员定义回写 modelProviderId（委派首跑病灶闭合）', async () => {
    const p = await createProvider({
      name: 'B 主供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-b-key-000000', platform: 'anthropic',
    }); // 目标态：provider 在场、无 defaultModel、全局未设默认模型
    const manifest = baseManifest({
      config: {
        agentMembers: [{ name: '镜像甲', customDefinition: customYaml('镜像甲', 'mirror-mb') }],
        modelBinding: { provider: 'anthropic', model: 'glm-5.3' },
      },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({}), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs ?? []).not.toContain('modelBinding:anthropic');

    expect(listProviders().find((x) => x.platform === 'anthropic')?.defaultModel).toBe('glm-5.3');
    expect(getGlobalSettings().defaultChatModel).toEqual({ providerId: p.id, modelId: 'glm-5.3' });
    // spawn 硬校验闭合：内嵌定义（发布链不携带模型绑定 → modelProviderId 空）被回写
    const def = listAgentDefinitions().find((d) => d.slug === 'mirror-mb');
    expect(def?.modelProviderId).toBe(p.id);
    expect(def?.modelName).toBe('glm-5.3');
  });

  it('RM2-10：B 本机显式选择不覆盖（provider.defaultModel 与 defaultChatModel 均保留）', async () => {
    const p = await createProvider({
      name: 'B 自选', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-b-key-000001', platform: 'anthropic', defaultModel: 'my-own-model',
    });
    updateGlobalSettings({ defaultChatModel: { providerId: p.id, modelId: 'my-own-model' } });
    const manifest = baseManifest({
      config: {
        agentMembers: [{ name: '镜像甲', customDefinition: customYaml('镜像甲', 'mirror-mb2') }],
        modelBinding: { provider: 'anthropic', model: 'glm-5.3' },
      },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-dev-2' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);

    expect(listProviders().find((x) => x.platform === 'anthropic')?.defaultModel).toBe('my-own-model');
    expect(getGlobalSettings().defaultChatModel).toEqual({ providerId: p.id, modelId: 'my-own-model' });
    // 定义本身无显式选择 → 回写兜底仍生效（不属「本机显式选择」）
    expect(listAgentDefinitions().find((d) => d.slug === 'mirror-mb2')?.modelProviderId).toBe(p.id);
  });

  it('provider 不存在（platform 无匹配）→ 软失败入 unresolvedRefs，不阻断镜像', async () => {
    await createProvider({
      name: 'B 主供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-b-key-000002', platform: 'openai',
    });
    const manifest = baseManifest({
      config: { modelBinding: { provider: 'anthropic', model: 'claude-x' } },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-dev-3' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs).toContain('modelBinding:anthropic');
    expect(getGlobalSettings().defaultChatModel).toBeUndefined();
  });

  it('旧快照无段（1.2.0 兼容）→ 应用照常，默认模型偏好零触碰', async () => {
    await createProvider({
      name: 'B 主供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-b-key-000003', platform: 'anthropic',
    });
    const archive = await makeArchive(baseManifest({ workspaceName: 'prod-dev-4' }));

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-dev-4' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    expect(listProviders().find((x) => x.platform === 'anthropic')?.defaultModel).toBeNull();
    expect(getGlobalSettings().defaultChatModel).toBeUndefined();
  });
});

describe('applyMirrorSnapshot defaultAgent 段（D2）', () => {
  it('空目标应用后默认实例在位——resolveAgentInstance 兜底链的两输入（默认位 + 在册成员）闭合', async () => {
    const manifest = baseManifest({
      workspaceName: 'prod-d2a',
      config: {
        agentMembers: [
          { name: '甲', customDefinition: customYaml('甲', 'd2-a') },
          { name: '乙', customDefinition: customYaml('乙', 'd2-b') },
        ],
        defaultAgent: '乙',
      },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-d2a' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs ?? []).not.toContain('defaultAgent:乙');

    const ws = getWorkspace(listWorkspaces().find((w) => w.name === 'prod-d2a')!.id);
    const defaultInstanceId = ws?.defaultAgentInstanceId;
    expect(defaultInstanceId).toBeTruthy();
    // resolveAgentInstanceProduct 消费面逐层断言：默认位指向在册成员，且该成员
    // 的定义正是快照默认 agent（按名对齐——'乙' → def d2-b）
    const member = listMembers(ws!.id).find((m) => m.instanceId === defaultInstanceId);
    expect(member).toBeTruthy();
    expect(member?.agentName).toBe('乙');
    expect(getAgentDefinition(member!.agentDefinitionId)?.slug).toBe('d2-b');
  });

  it('段在场但成员未重建 → unresolvedRefs 记录，默认位不写', async () => {
    const manifest = baseManifest({
      workspaceName: 'prod-d2b',
      config: { agentMembers: [], defaultAgent: '幽灵成员' },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-d2b' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs).toContain('defaultAgent:幽灵成员');
    const ws = listWorkspaces().find((w) => w.name === 'prod-d2b');
    expect(ws && getWorkspace(ws.id)?.defaultAgentInstanceId == null).toBe(true);
  });

  it('旧快照无段 → 默认位零触碰（1.2.0 兼容）', async () => {
    const manifest = baseManifest({
      workspaceName: 'prod-d2c',
      config: { agentMembers: [{ name: '甲', customDefinition: customYaml('甲', 'd2-c') }] },
    });
    const archive = await makeArchive(manifest);

    const outcome = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-d2c' }), makeDeps(archive));
    expect(outcome.ok).toBe(true);
    const ws = listWorkspaces().find((w) => w.name === 'prod-d2c');
    expect(ws && getWorkspace(ws.id)?.defaultAgentInstanceId == null).toBe(true);
  });
});

describe('applyMirrorSnapshot modelBinding 自愈（D4 验收：重镜像修复）', () => {
  const buildMbArchive = (wsName: string, slug: string): Promise<ArchiveFixture> =>
    makeArchive(
      baseManifest({
        workspaceName: wsName,
        config: {
          agentMembers: [{ name: '甲', customDefinition: customYaml('甲', slug) }],
          modelBinding: { provider: 'anthropic', model: 'glm-5.3' },
        },
      }),
    );

  it('首镜 provider 缺席 → 注册 provider 后重镜像 → 既有定义空缺绑定回填', async () => {
    const archive = await buildMbArchive('prod-d4a', 'd4-a');
    const first = await applyMirrorSnapshot(applyPayload({ workspaceName: 'prod-d4a' }), makeDeps(archive));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.unresolvedRefs).toContain('modelBinding:anthropic');
    expect(listAgentDefinitions().find((d) => d.slug === 'd4-a')?.modelProviderId).toBeFalsy();

    const p = await createProvider({
      name: 'B 后注册', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-d4-key-000000', platform: 'anthropic',
    });
    const second = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'prod-d4a', confirm: true }),
      makeDeps(await buildMbArchive('prod-d4a', 'd4-a')),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unresolvedRefs ?? []).not.toContain('modelBinding:anthropic');
    expect(listAgentDefinitions().find((d) => d.slug === 'd4-a')?.modelProviderId).toBe(p.id);
  });

  it('worker 手设绑定在重镜像后保留（不被整体替换清回 NULL）', async () => {
    const bindingP = await createProvider({
      name: '绑定供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-d4-key-000001', platform: 'anthropic',
    });
    const manualP = await createProvider({
      name: '手设供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-d4-key-000002', platform: 'openai',
    });
    const first = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'prod-d4b' }),
      makeDeps(await buildMbArchive('prod-d4b', 'd4-b')),
    );
    expect(first.ok).toBe(true);

    // worker 手设显式绑定（「编辑成员 → 模型供应商」UI 的 DB 等价路径）
    const defId = listAgentDefinitions().find((d) => d.slug === 'd4-b')!.id;
    updateAgentDefinition({ id: defId, modelProviderId: manualP.id, modelName: 'manual-model' });

    const second = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'prod-d4b', confirm: true }),
      makeDeps(await buildMbArchive('prod-d4b', 'd4-b')),
    );
    expect(second.ok).toBe(true);
    const def = listAgentDefinitions().find((d) => d.slug === 'd4-b');
    expect(def?.modelProviderId).toBe(manualP.id); // 有效绑定不动（RM2-10 显式选择语义）
    expect(def?.modelProviderId).not.toBe(bindingP.id);
    expect(def?.modelName).toBe('manual-model');
  });

  it('绑定指向已删 provider（ghost）→ 重镜像修复为 modelBinding 的本机 provider', async () => {
    const survivor = await createProvider({
      name: '存活供', baseUrl: 'https://api.b.example/v1',
      apiKey: 'sk-d4-key-000004', platform: 'anthropic',
    });
    const first = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'prod-d4c' }),
      makeDeps(await buildMbArchive('prod-d4c', 'd4-c')),
    );
    expect(first.ok).toBe(true);
    // ghost 态直造（绕过 deleteProvider 引用守卫——备份恢复/异常态等真实可达）：
    // def.model_provider_id 指向已不存在的行（getProvider 判 null → spawn 链同败）
    const defId = listAgentDefinitions().find((d) => d.slug === 'd4-c')!.id;
    getDb()
      .prepare('UPDATE agent_definitions SET model_provider_id = ? WHERE id = ?')
      .run('ghost-provider-id', defId);

    const second = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'prod-d4c', confirm: true }),
      makeDeps(await buildMbArchive('prod-d4c', 'd4-c')),
    );
    expect(second.ok).toBe(true);
    expect(listAgentDefinitions().find((d) => d.slug === 'd4-c')?.modelProviderId).toBe(survivor.id);
  });
});

describe('契约：buildWorkspaceSnapshot 产出 → applyMirrorSnapshot 消费', () => {
  it('真实归档（manifest.json 在根 + custom skill 内嵌）→ 目标侧整体复刻', async () => {
    // 源工作空间：custom 成员 + hub 记账引用成员 + 团队 + custom skill + prefs
    const srcId = await mkWorkspace('契约空间');
    const customInst = await seedCustomMember(srcId, '契约甲', 'pact-a');
    const marketInst = await seedCustomMember(srcId, '契约乙', 'pact-b');
    createTeam(srcId, '契约组', '🎯', [customInst, marketInst], customInst);
    const skillDir = path.join(tmpRoot, 'skills', 'pact-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: pact-skill 名\ndescription: 契约\nversion: 0.1.0\n---\n\n正文',
    );
    fs.writeFileSync(path.join(skillDir, '.sha256'), 'deadbeef');
    updateGlobalSettings({ maxToolCalls: 77 });
    // D4 全链：源设全局默认模型 → 段入快照 → 目标侧回写（定义 modelProviderId 兜底）
    const srcProvider = await createProvider({
      name: '契约供', baseUrl: 'https://api.pact.example/v1',
      apiKey: 'sk-pact-key-000000', platform: 'anthropic',
    });
    updateGlobalSettings({ defaultChatModel: { providerId: srcProvider.id, modelId: 'glm-5.3' } });
    // D2 全链：源设默认会话 agent → 段入快照 → 目标默认位回写
    setDefaultAgent(srcId, customInst);

    const built = await buildWorkspaceSnapshot(srcId);
    expect(built.manifest.workspaceName).toBe('契约空间');
    expect(built.manifest.config.agentMembers).toHaveLength(2);
    expect(built.manifest.config.modelBinding).toEqual({ provider: 'anthropic', model: 'glm-5.3' });
    expect(built.manifest.config.defaultAgent).toBe('契约甲');

    // 目标 = 同库同名空间整体替换（源空间即「同名已存在」的冲突面）
    const deps: MirrorApplierDeps = {
      fetchSnapshotArchive: async () => ({
        bytes: fs.readFileSync(built.archivePath),
        checksum: built.checksum,
      }),
      installResource: async () => undefined, // 无 hub 记账 resources 位——零补装
    };
    const conflict = await applyMirrorSnapshot(applyPayload({ workspaceName: '契约空间' }), deps);
    expect(conflict.ok).toBe(false);

    const applied = await applyMirrorSnapshot(applyPayload({ workspaceName: '契约空间', confirm: true }), deps);
    expect(applied.ok).toBe(true);

    // 复刻断言：成员/团队/prefs 与源一致；custom skill 内嵌包落位
    const target = listWorkspaces().find((w) => w.name === '契约空间');
    expect(target?.id).toBe(srcId); // 整体替换在原名空间上执行
    const members = listMembers(srcId);
    expect(members.map((m) => m.agentName).sort()).toEqual(['契约乙', '契约甲']); // 默认按码位：乙<甲
    const teams = listTeams(srcId);
    expect(teams.map((t) => t.name)).toEqual(['契约组']);
    expect(getGlobalSettings().maxToolCalls).toBe(77);
    expect(listInstalled().some((s) => s.slug === 'pact-skill')).toBe(true);
    // 段经真实 tar 归档存续 → 目标侧定义回写（spawn 硬校验闭合）
    expect(getGlobalSettings().defaultChatModel).toEqual({ providerId: srcProvider.id, modelId: 'glm-5.3' });
    expect(getAgentDefinition('def-pact-a')?.modelProviderId).toBe(srcProvider.id);
    // D2 全链断言：默认位经真实归档回写，指向重建后的契约甲实例（resolveAgent
    // 兜底链闭合——组内调度不指派 agentSlug 的首派不再必拒）
    const targetDefault = getWorkspace(srcId)?.defaultAgentInstanceId;
    const rebuiltMember = listMembers(srcId).find((m) => m.instanceId === targetDefault);
    expect(rebuiltMember?.agentName).toBe('契约甲');
    expect(getAgentDefinition(rebuiltMember!.agentDefinitionId)?.slug).toBe('pact-a');

    fs.rmSync(built.archivePath, { force: true });
  });
});

// ── 11. 工作目录（workspaceRootDir，2026-10-27）────────────────────────────
// 消费面矩阵 .omo/feature-matrices/2026-10-27-hub-workspace-root-dir.md 行 1/5

describe('applyMirrorSnapshot 工作目录', () => {
  const noResDeps = (archive: ArchiveFixture): MirrorApplierDeps => ({
    fetchSnapshotArchive: async () => ({ bytes: archive.bytes, checksum: archive.checksum }),
    installResource: async () => undefined,
  });

  it('默认落位回归锁：无配置 → <userData>/workspaces/<清洗名>', async () => {
    const archive = await makeArchive(baseManifest({ workspaceName: '默认根空间' }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: '默认根空间' }),
      noResDeps(archive),
    );
    expect(outcome.ok).toBe(true);
    const ws = listWorkspaces().find((w) => w.name === '默认根空间');
    expect(ws?.directoryPath).toBe(path.join(tmpRoot, 'workspaces', '默认根空间'));
  });

  it('自定义根落位：配置后 → 自定义根/<清洗名>（-2 唯一化语义保留）', async () => {
    const customRoot = path.join(tmpRoot, 'custom-root');
    fs.mkdirSync(path.join(customRoot, '已占空间'), { recursive: true }); // 占位同名目录 → 触发 -2
    const { createHubWorkspaceDirStore } = await import('../../src/main/hub/workspace-dir-settings');
    createHubWorkspaceDirStore().write({ rootDir: customRoot });

    const archive = await makeArchive(baseManifest({ workspaceName: '已占空间' }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: '已占空间' }),
      noResDeps(archive),
    );
    expect(outcome.ok).toBe(true);
    const ws = listWorkspaces().find((w) => w.name === '已占空间');
    expect(ws?.directoryPath).toBe(path.join(customRoot, '已占空间-2'));
  });

  it('自定义根不可写 → 整体拒绝 + 人话错误，库内无该空间（不静默回退默认）', async () => {
    const roRoot = path.join(tmpRoot, 'ro-root');
    fs.mkdirSync(roRoot, { recursive: true });
    fs.chmodSync(roRoot, 0o555);
    const { createHubWorkspaceDirStore } = await import('../../src/main/hub/workspace-dir-settings');
    createHubWorkspaceDirStore().write({ rootDir: roRoot });
    try {
      const archive = await makeArchive(baseManifest({ workspaceName: '只读根空间' }));
      const outcome = await applyMirrorSnapshot(
        applyPayload({ workspaceName: '只读根空间' }),
        noResDeps(archive),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('internal');
        expect(outcome.message).toMatch(/工作目录不可写/);
      }
      expect(listWorkspaces().some((w) => w.name === '只读根空间')).toBe(false);
    } finally {
      fs.chmodSync(roRoot, 0o755);
    }
  });

  // ── P2-11 错误精准化：仅 fs 权限三码（EACCES/EPERM/EROFS）标「工作目录不可写」，
  // 其余失败原样透传（改写会掩盖真实病因——DB 故障被报成目录不可写）──

  it('P2-11：DB 类失败（workspace_members 表损坏）→ 透传原文，不改写为「工作目录不可写」', async () => {
    // 真实 DB 故障注入：listWorkspaces 只读 workspaces 表不受影响，createWorkspace
    // 的第二条 INSERT（workspace_members）撞缺失表 → SqliteError 原文透传
    getDb().exec('DROP TABLE workspace_members');
    const archive = await makeArchive(baseManifest({ workspaceName: 'DB 故障空间' }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'DB 故障空间' }),
      noResDeps(archive),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('internal');
      expect(outcome.message).toMatch(/no such table: workspace_members/);
      expect(outcome.message).not.toMatch(/工作目录不可写/);
    }
  });

  it('P2-11：非权限类 fs 失败（根为普通文件 → mkdir ENOTDIR）→ 透传原文，不改写', async () => {
    // 根配置指向普通文件：path.join 后 mkdir 撞 ENOTDIR——非权限三码，须原样透传
    const fileRoot = path.join(tmpRoot, 'blocker-file');
    fs.writeFileSync(fileRoot, 'not a directory');
    const { createHubWorkspaceDirStore } = await import('../../src/main/hub/workspace-dir-settings');
    createHubWorkspaceDirStore().write({ rootDir: fileRoot });

    const archive = await makeArchive(baseManifest({ workspaceName: '根是文件空间' }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: '根是文件空间' }),
      noResDeps(archive),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('internal');
      expect(outcome.message).toMatch(/ENOTDIR/);
      expect(outcome.message).not.toMatch(/工作目录不可写/);
    }
  });

  it('既有空间零迁移：换根后重镜像（confirm）→ directory_path 不动', async () => {
    // 首次：默认根落位
    const archive = await makeArchive(baseManifest({ workspaceName: '存量空间' }));
    await applyMirrorSnapshot(applyPayload({ workspaceName: '存量空间' }), noResDeps(archive));
    const before = listWorkspaces().find((w) => w.name === '存量空间')?.directoryPath;
    expect(before).toBe(path.join(tmpRoot, 'workspaces', '存量空间'));

    // 换根 → 同名重镜像（confirm=true 整体替换）
    const { createHubWorkspaceDirStore } = await import('../../src/main/hub/workspace-dir-settings');
    createHubWorkspaceDirStore().write({ rootDir: path.join(tmpRoot, 'new-root') });
    const redo = await applyMirrorSnapshot(
      applyPayload({ workspaceName: '存量空间', confirm: true }),
      noResDeps(archive),
    );
    expect(redo.ok).toBe(true);
    expect(listWorkspaces().find((w) => w.name === '存量空间')?.directoryPath).toBe(before);
  });
});

// ── 12. catalog 自愈（2026-10-27：builtin catalog-install 类引用的按需落装）──
// 背景：builtin agent/skill 自 v1.1 走 marketplace 按需安装——「目标同有」假设
// 对 catalog-install 类不成立（双端同 catalog 但装态独立）。修复：目标未装且
// 本地内置 catalog 有该 slug → 按需落装（零网络，inline 包）→ 解析命中；
// catalog 也没有的仍软失败（superpowers 类私有 skill）。

describe('applyMirrorSnapshot catalog 自愈', () => {
  const noResDeps2 = (archive: ArchiveFixture): MirrorApplierDeps => ({
    fetchSnapshotArchive: async () => ({ bytes: archive.bytes, checksum: archive.checksum }),
    installResource: async () => undefined,
  });

  it('agent slug 引用目标未装、本地 catalog 有 → 自动落装并解析（无 agent unresolved）', async () => {
    const archive = await makeArchive(baseManifest({
      workspaceName: 'cat-agent',
      config: {
        agentMembers: [{ name: '办公助手', slug: 'office-assistant' }],
        teams: [], mcpEnabled: [], skills: [], pluginsEnabled: [], providerRefs: [], prefs: {},
      },
    }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'cat-agent' }),
      noResDeps2(archive),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs ?? []).toEqual([]); // catalog 补装生效——不再 agent:office-assistant
    const members = listMembers(listWorkspaces().find((w) => w.name === 'cat-agent')!.id);
    // 身份契约=slug（成员显示名随目标侧定义——catalog 项名与源端可不同）
    expect(members).toHaveLength(1);
    expect(getAgentDefinition(members[0]!.agentDefinitionId)?.slug).toBe('office-assistant');
  });

  it('skill slug 未装未内嵌、本地 catalog 有 → 自动落装（无 skill unresolved）', async () => {
    const archive = await makeArchive(baseManifest({
      workspaceName: 'cat-skill',
      config: {
        agentMembers: [], teams: [], mcpEnabled: [],
        skills: ['code-review'], pluginsEnabled: [], providerRefs: [], prefs: {},
      },
    }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'cat-skill' }),
      noResDeps2(archive),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs ?? []).toEqual([]);
    expect(listInstalled().some((s) => s.slug === 'code-review')).toBe(true);
  });

  it('catalog 没有的 slug（私有 skill）→ 仍软失败入 unresolved（语义不变）', async () => {
    const archive = await makeArchive(baseManifest({
      workspaceName: 'cat-ghost',
      config: {
        agentMembers: [], teams: [], mcpEnabled: [],
        skills: ['brainstorming'], pluginsEnabled: [], providerRefs: [], prefs: {},
      },
    }));
    const outcome = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'cat-ghost' }),
      noResDeps2(archive),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unresolvedRefs).toEqual(['skill:brainstorming']);
  });

  it('补装幂等：confirm 重放不重复装包不炸（.installed 跳过路径）', async () => {
    const manifest = baseManifest({
      workspaceName: 'cat-idem',
      config: {
        agentMembers: [{ name: '研究员', slug: 'researcher' }], teams: [],
        mcpEnabled: [], skills: ['debug-reproduce'], pluginsEnabled: [], providerRefs: [], prefs: {},
      },
    });
    const archive = await makeArchive(manifest);
    const first = await applyMirrorSnapshot(applyPayload({ workspaceName: 'cat-idem' }), noResDeps2(archive));
    expect(first.ok).toBe(true);
    const second = await applyMirrorSnapshot(
      applyPayload({ workspaceName: 'cat-idem', confirm: true }),
      noResDeps2(archive),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unresolvedRefs ?? []).toEqual([]);
  });
});
