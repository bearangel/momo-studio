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
import { saveAgentDefinition, addMember } from '../../src/main/agent/crud';
import { createTeam } from '../../src/main/agent/team';
import { createProvider, listProviders, providerApiKeyRef } from '../../src/main/agent/provider-crud';
import { registerMcpDefinition, setMcpEnabledDefinition, listRegistered } from '../../src/main/mcp/host-manager';
import { upsertPlugin, setPluginEnabled, isPluginEnabled } from '../../src/main/plugin/registry';
import { createWorkspace, listWorkspaces } from '../../src/main/workspace/crud';
import { getGlobalSettings, updateGlobalSettings } from '../../src/main/settings/crud';
import { listInstalled } from '../../src/main/skill/zip-uploader';
import { listMembers } from '../../src/main/agent/agent-queries';
import { listTeams } from '../../src/main/agent/team';

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

/** manifest + 可选附加文件（relPath → content）→ tar.gz 字节 + sha256。 */
async function makeArchive(
  manifest: SnapshotManifest,
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
  config?: Partial<SnapshotManifest['config']>;
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

    releaseFirst?.();
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

    const built = await buildWorkspaceSnapshot(srcId);
    expect(built.manifest.workspaceName).toBe('契约空间');
    expect(built.manifest.config.agentMembers).toHaveLength(2);

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

    fs.rmSync(built.archivePath, { force: true });
  });
});
