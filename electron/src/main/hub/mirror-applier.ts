// electron/src/main/hub/mirror-applier.ts
//
// 镜像应用器（momo-hub M2 spec §5.2 第 4 步 / T8b，目标节点侧）——
// 收 hub 转发的 mirror.apply req 信封后在本机执行：
//
//   1. 在途对账：同 workspaceName 已有本地在途 apply → 拒 conflict 'mirror_in_progress'
//      （hub 侧登记是第一道闸；本闸防 hub 重启丢登记后的并发窗口）
//   2. 快照取包：GET /workspaces/snapshots/{id}/download（Bearer）→ sha256 复算
//      对账 X-Checksum-Sha256 → 安全解压（tar 成员守卫）→ manifest.json 结构校验
//   3. 工作空间不存在 → 创建（目录落 userData/workspaces 下）；存在且 confirm!==true
//      → 计算**差异摘要**（目标实况 vs manifest 七子段：新增/移除/变更计数）→
//      回 conflict + diffSummary（hub 透传 leader 两段式确认）
//   4. 执行序 = **先资源补装后配置落库**（spec §5.2.4 顺序约束）：
//      manifest.resources 逐项——本机已装（hub 记账命中或本地点位在位）跳过 →
//      从 hub 资源仓安装（M1 链）→ 非 stale 失败**中止整体**（配置不落、目标
//      保持原状；已装资源保留——幂等可重试）；hub 最新目录不可达
//      （HubCatalogStaleError）→ 该资源跳过并记入 unresolvedRefs，其余继续
//   5. 配置整体替换落库（七子段逐域写，见 applyConfig 各段注释）；目标无法解析
//      的引用（custom stdio MCP 名 / name≠slug 类）**不阻断**，记入回执
//      unresolvedRefs（软失败——T7 硬交接语义，leader 结果面分列展示）
//   6. 回执 mirror.receipt：{ok, appliedResources, unresolvedRefs?}
//
// 红线延续：本模块只消费快照 manifest + 内嵌 skill 文本（构建器侧已锁零 key/
// 零凭证头/零聊天历史）；provider 引用仅对齐 platform+defaultModel（目标本机
// key 不动——updateProvider 不传 apiKey 即不触碰 keychain）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { listWorkspaces, createWorkspace, setDefaultAgent } from '../workspace/crud';
import { listMembers, addMember, removeMember, generateAgentUserId, saveAgentDefinition, updateAgentDefinition } from '../agent/crud';
import { listAgentDefinitions, getAgentDefinition } from '../agent/agent-queries';
import { parseAgentManifest } from '../agent/manifest-parser';
import { listTeams, createTeam, deleteTeam } from '../agent/team';
import { listProviders, getProvider, updateProvider } from '../agent/provider-crud';
import { listRegistered, setMcpEnabledDefinition } from '../mcp/host-manager';
import { listInstalled, getSkillsDir } from '../skill/zip-uploader';
import { listPlugins, getPlugin, isPluginEnabled, setPluginEnabled } from '../plugin/registry';
import { updateGlobalSettings, getGlobalSettings } from '../settings/crud';
import { assertSafeTarMembers } from '../plugin/installer';
import { resolveTmpDir } from '../paths';
import { HubCatalogStaleError, installHubPackage } from '../resource/hub-install';
import { installPackage } from '../marketplace/installer';
import { readBundledCatalog } from '../marketplace/client';
import type { MarketplaceItem } from '../marketplace/types';
import type { ResourceType } from '../resource/types';
import { agentManifestYaml } from './publish';
import { createHubConfigStore } from './config-store';
import { createHubWorkspaceDirStore } from './workspace-dir-settings';
import { getDeviceToken } from './creds';
import {
  validateSnapshotManifest,
  type MirrorDiffSummary,
  type SnapshotManifest,
} from './protocol';
import type { MirrorApplyOutcome, MirrorApplyPayload } from './mirror-wire';
import { extractModelBinding, type SnapshotModelBinding } from './snapshot-model-binding';
import { extractDefaultAgent } from './snapshot-default-agent';

const execFileAsync = promisify(execFile);

/** hub 记账 item_id 前缀（与 resource/hub/momo-hub 单点对齐——此处独立查询表，
 *  不引 momo-hub 模块避免拉起目录缓存状态）。 */
const HUB_ITEM_ID_PREFIX = 'hub:';

/** workspaceName 上限（与 hub 端登记键同界）。 */
const MAX_WORKSPACE_NAME = 128;

// ──────────────────────────────────────────────────────────────────────────
// 注入缝（momo-test-rules：只 mock 进程/网络边界——快照下载与 hub 安装链）
// ──────────────────────────────────────────────────────────────────────────

export interface MirrorApplierDeps {
  /** 快照取包（HTTP 边界）：下载归档字节 + 服务端权威 checksum（X-Checksum-Sha256）。 */
  fetchSnapshotArchive?(snapshotId: string): Promise<{ bytes: Buffer; checksum: string }>;
  /** hub 资源安装链边界（目录拉取 + 下载 + 注册）：workspaceId 供插件启停作用域。 */
  installResource?(type: ResourceType, slug: string, workspaceId: string): Promise<void>;
}

async function defaultFetchSnapshotArchive(snapshotId: string): Promise<{ bytes: Buffer; checksum: string }> {
  const cfg = createHubConfigStore(getDb()).read();
  if (!cfg) throw new Error('hub 未配置，无法下载快照');
  const token = await getDeviceToken();
  if (!token) throw new Error('本地缺少 device token，无法下载快照（请重新接入 hub）');
  let res: Response;
  try {
    res = await fetch(
      `${cfg.hubUrl.replace(/\/+$/, '')}/workspaces/snapshots/${encodeURIComponent(snapshotId)}/download`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  } catch {
    throw new Error('快照下载失败：无法连接 hub');
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`快照不存在或已过期: ${snapshotId}`);
    if (res.status === 401) throw new Error('快照下载鉴权失败（连接已失效，请重新接入 hub）');
    throw new Error(`快照下载失败: HTTP ${res.status}`);
  }
  const checksum = res.headers.get('x-checksum-sha256') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, checksum };
}

async function defaultInstallResource(type: ResourceType, slug: string, workspaceId: string): Promise<void> {
  await installHubPackage(type, slug, { workspaceId });
}

// ──────────────────────────────────────────────────────────────────────────
// 在途登记（本地并发对账）
// ──────────────────────────────────────────────────────────────────────────

/** workspaceName → mirrorId（本地在途 apply）。单进程内存表即可（hub 侧有持久语义的
 *  inFlight 登记为第一道闸；本表防 hub 重启丢登记后同工作空间并发 apply 交错写库）。 */
const inFlightApplies = new Set<string>();

// ──────────────────────────────────────────────────────────────────────────
// 快照取包与解包
// ──────────────────────────────────────────────────────────────────────────

/** tar -tzf 成员清单（剥目录尾条目，只留文件成员——plugin/hub-install 同款）。 */
function listTarMembers(archivePath: string): string[] {
  return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
}

/** 快照归档 → {manifest, stageDir, modelBinding, defaultAgent}（解包到临时目录；
 *  调用方负责清理 stageDir）。modelBinding/defaultAgent 从**原始** manifest.json
 *  提取（pin 版 validateSnapshotManifest 按「未知容忍（剥除）」会剥掉两可选段
 *  ——snapshot-model-binding / snapshot-default-agent 补位纪律）。 */
async function extractSnapshot(
  bytes: Buffer,
  expectedChecksum: string,
): Promise<{
  manifest: SnapshotManifest;
  stageDir: string;
  modelBinding: SnapshotModelBinding | null;
  defaultAgent: string | null;
}> {
  const stageDir = fs.mkdtempSync(path.join(resolveTmpDir(), 'ws-apply-'));
  const archivePath = path.join(stageDir, 'snapshot.tar.gz');
  try {
    fs.writeFileSync(archivePath, bytes);
    // sha256 复算对账（C6 延续：服务端自算值为权威；传输截断/篡改在此拦截）
    if (expectedChecksum) {
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== expectedChecksum.toLowerCase()) {
        throw new Error(`快照校验失败（sha256 不符）: 期望 ${expectedChecksum.slice(0, 12)}… 实得 ${actual.slice(0, 12)}…`);
      }
    }
    assertSafeTarMembers(listTarMembers(archivePath)); // `..`/绝对路径成员终审
    const unpack = path.join(stageDir, 'unpack');
    fs.mkdirSync(unpack, { recursive: true });
    await execFileAsync('tar', ['-xzf', archivePath, '-C', unpack]);
    const manifestPath = path.join(unpack, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('快照包损坏：缺少 manifest.json（构建契约：manifest 在归档根）');
    }
    const manifestText = fs.readFileSync(manifestPath, 'utf-8');
    const rawManifest: unknown = JSON.parse(manifestText);
    const parsed = validateSnapshotManifest(rawManifest);
    if (parsed === null) {
      throw new Error('快照 manifest 结构校验失败（与 hub 端上传校验不一致——疑似损坏）');
    }
    const rawConfig =
      typeof rawManifest === 'object' && rawManifest !== null
        ? (rawManifest as Record<string, unknown>)['config']
        : undefined;
    // 归档临时文件移出 unpack，stage 根只留 manifest 引用面
    return {
      manifest: parsed,
      stageDir: unpack,
      modelBinding: extractModelBinding(rawConfig),
      defaultAgent: extractDefaultAgent(rawConfig),
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 本机已装判定（resources 逐项跳过依据）
// ──────────────────────────────────────────────────────────────────────────

/**
 * installed_packages 的 hub 记账面：item_type → slug 集（M2.3 T5 件2 导出契约化）。
 *
 * 契约：只收 `hub:` 前缀记账行（生产者 = recordPublishAccounting 发布回填 +
 * installHubPackage 安装落账，均 `hub:{slug}` 单点前缀）；marketplace 本地行不入集。
 * 跨模块消费面两处——本模块 installResources 已装判定①，及 snapshot-builder
 * resources 段记账反查（此前 builder 私有同款 SQL，M2.3 T5 收口为导入单点，
 * 漂移由 tests/hub/publish-accounting.test.ts 契约锁）。
 */
export function loadHubAccountingSet(): Map<string, Set<string>> {
  const acc = new Map<string, Set<string>>();
  const rows = getDb()
    .prepare('SELECT item_id, item_type FROM installed_packages')
    .all() as Array<{ item_id: string; item_type: string }>;
  for (const row of rows) {
    if (!row.item_id.startsWith(HUB_ITEM_ID_PREFIX)) continue;
    const set = acc.get(row.item_type) ?? new Set<string>();
    set.add(row.item_id.slice(HUB_ITEM_ID_PREFIX.length));
    acc.set(row.item_type, set);
  }
  return acc;
}

/** 本地点位在位判定（builtin/marketplace 目录来源——T7 交接的兜底解析序）：
 *  agent=定义表 slug / skill=已装清单 / mcp=注册名 / plugin=插件注册行。 */
function isLocallyPresent(type: string, slug: string): boolean {
  if (type === 'agent') return listAgentDefinitions().some((d) => d.slug === slug);
  if (type === 'skill') return listInstalled().some((s) => s.slug === slug);
  if (type === 'mcp') return listRegistered().some((m) => m.name === slug);
  if (type === 'plugin') return getPlugin(slug) !== null;
  return false;
}

/** 内置 catalog agent/skill 项（纯本地读——镜像补装不吃网络；进程序内单读复用）。 */
let bundledCatalogItems: MarketplaceItem[] | null = null;
function localCatalogItems(): MarketplaceItem[] {
  if (bundledCatalogItems === null) {
    try {
      bundledCatalogItems = readBundledCatalog().items;
    } catch (err) {
      logger.warn('内置 catalog 读取失败，catalog 自愈降级为纯软失败', {
        error: (err as Error).message,
      });
      bundledCatalogItems = [];
    }
  }
  return bundledCatalogItems;
}

/**
 * catalog 自愈（2026-10-27）：目标未装的 agent/skill slug 引用，若内置 catalog
 * 有同名项则按需落装（inline 包、零网络），再由调用方复查解析。修复「builtin
 * 目标同有」假设的裂缝——builtin/catalog-install 类自 v1.1 走 marketplace
 * 按需安装，两端装态独立（验收实况：A 装 5 个 catalog agent、B 全缺 → 20 条
 * unresolved）。catalog 无此 slug 或落装失败 → 回落软失败（语义不变）。
 */
async function installFromLocalCatalog(type: 'agent' | 'skill', slug: string): Promise<boolean> {
  const item = localCatalogItems().find((c) => c.type === type && c.slug === slug);
  if (!item) return false;
  try {
    await installPackage(item);
    return true;
  } catch (err) {
    logger.warn('catalog 自愈落装失败，回落软失败', { type, slug, error: (err as Error).message });
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 差异摘要（conflict 路径——目标实况 vs manifest 七子段计数）
// ──────────────────────────────────────────────────────────────────────────

/** 成员比对键：custom → 内嵌 YAML 再序列化（与构建器同函数，确定性可比）；
 *  引用 → slug。名字行无引用 → 名字本身。 */
function memberKey(name: string, slug: string | undefined, customDefinition: string | undefined): string {
  if (customDefinition !== undefined) return `custom:${customDefinition}`;
  if (slug !== undefined) return `slug:${slug}`;
  return `name:${name}`;
}

function targetMemberKey(instance: { agentDefinitionId: string; agentName: string }): string {
  const def = getAgentDefinition(instance.agentDefinitionId);
  if (!def) return `name:${instance.agentName}`;
  if (def.source === 'custom') return `custom:${agentManifestYaml(def)}`;
  return def.slug ? `slug:${def.slug}` : `name:${instance.agentName}`;
}

/**
 * 差异摘要计数（协议 MirrorDiffSummary：added/removed/changed）。
 * 计数口径（代码级契约，leader 面板只展示三数）：
 *   - agentMembers：按名对齐；快照有名目标无名 → added，反之 removed，
 *     同名键不同（slug 换绑 / custom 定义变化）→ changed
 *   - teams：按名对齐，成员集或 leader 不同 → changed；单侧缺 → added/removed
 *   - mcpEnabled：单侧差集逐个计入 added/removed（同名为变更启用态，计 changed=0——
 *     名字集合同即无差异，启用态在整体替换语义下必被覆写）
 *   - skills：slug 差集（目标多出的 skill 不删——builtin/marketplace 无删除链，
 *     但如实计入 removed 让 leader 知晓目标将保留它们？不——removed 语义是
 *     「镜像会移除的项」，skill 段不做移除，故目标多出的不计入，代码注释为准）
 *   - pluginsEnabled：pluginId 差集（本工作空间启用面）
 *   - providerRefs：目标缺该 platform 的 provider → added（镜像也不会替 leader
 *     创建 provider——如实计数为「快照要求而目标缺失」）
 *   - prefs：同名键值不同 → changed
 */
export function computeDiffSummary(workspaceId: string, manifest: SnapshotManifest): MirrorDiffSummary {
  let added = 0;
  let removed = 0;
  let changed = 0;

  // agentMembers
  const targetMembers = listMembers(workspaceId);
  const targetByName = new Map(targetMembers.map((m) => [m.agentName, m]));
  const snapshotNames = new Set(manifest.config.agentMembers.map((m) => m.name));
  for (const m of manifest.config.agentMembers) {
    const t = targetByName.get(m.name);
    if (!t) { added += 1; continue; }
    if (memberKey(m.name, m.slug, m.customDefinition) !== targetMemberKey(t)) changed += 1;
  }
  for (const t of targetMembers) {
    if (!snapshotNames.has(t.agentName)) removed += 1;
  }

  // teams
  const targetTeams = listTeams(workspaceId);
  const teamByName = new Map(targetTeams.map((t) => [t.name, t]));
  const snapshotTeamNames = new Set(manifest.config.teams.map((t) => t.name));
  const nameOf = new Map(targetMembers.map((m) => [m.instanceId, m.agentName]));
  for (const t of manifest.config.teams) {
    const tt = teamByName.get(t.name);
    if (!tt) { added += 1; continue; }
    const leaderName = nameOf.get(tt.leaderInstanceId) ?? '';
    const memberNames = tt.members.map((mm) => nameOf.get(mm.instanceId) ?? '').sort();
    if (
      leaderName !== t.leader ||
      JSON.stringify(memberNames) !== JSON.stringify([...t.members].sort())
    ) {
      changed += 1;
    }
  }
  for (const t of targetTeams) {
    if (!snapshotTeamNames.has(t.name)) removed += 1;
  }

  // mcpEnabled（构建器同款过滤口径：enabled && stdio && 无 url && 非 plugin 来源）
  const targetMcp = new Set(
    listRegistered()
      .filter((m) => m.enabled && m.transport === 'stdio' && !m.url && m.source !== 'plugin')
      .map((m) => m.name),
  );
  const snapshotMcp = new Set(manifest.config.mcpEnabled);
  for (const n of snapshotMcp) if (!targetMcp.has(n)) added += 1;
  for (const n of targetMcp) if (!snapshotMcp.has(n)) removed += 1;

  // skills（就位确保语义——只计快照要求而目标缺的，目标多出不计）
  const targetSkills = new Set(listInstalled().map((s) => s.slug));
  for (const s of manifest.config.skills) if (!targetSkills.has(s)) added += 1;

  // pluginsEnabled（本工作空间启用面差集）
  const targetPlugins = new Set(
    listPlugins().filter((p) => isPluginEnabled(p.id, workspaceId)).map((p) => p.id),
  );
  const snapshotPlugins = new Set(manifest.config.pluginsEnabled.map((p) => p.pluginId));
  for (const p of snapshotPlugins) if (!targetPlugins.has(p)) added += 1;
  for (const p of targetPlugins) if (!snapshotPlugins.has(p)) removed += 1;

  // providerRefs（目标缺 platform → added；本地多出的 provider 不删不计）
  const targetPlatforms = new Set(listProviders().map((p) => p.platform));
  for (const r of manifest.config.providerRefs) if (!targetPlatforms.has(r.provider as 'openai' | 'anthropic')) added += 1;

  // prefs（值异 → changed）
  const current: Record<string, unknown> = { ...getGlobalSettings() };
  for (const [k, v] of Object.entries(manifest.config.prefs)) {
    if (current[k] !== v) changed += 1;
  }

  return { added, removed, changed };
}

// ──────────────────────────────────────────────────────────────────────────
// 配置整体替换（七子段逐域写）
// ──────────────────────────────────────────────────────────────────────────

/** prefs 白名单（构建器 collectPrefs 的镜像键集——未知键忽略，防 manifest 夹带）。 */
const PREFS_KEYS = new Set([
  'maxToolCalls', 'maxConcurrentTasks', 'auditQuotaMb', 'journalQuotaMb',
  'memoryEnabled', 'memoryExtractionEnabled', 'sandboxMode', 'sandboxNetworkPolicy',
]);

function sanitizeDirName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'mirrored' : cleaned.slice(0, 64);
}

/** 目标工作空间落位：不存在则创建（目录 = 工作目录设置生效根/<名> 唯一化；
 *  默认根 <userData>/workspaces——既有空间零迁移，见 workspace-dir-settings）。 */
async function ensureWorkspace(workspaceName: string): Promise<{ workspaceId: string; created: boolean }> {
  const existing = listWorkspaces().find((w) => w.name === workspaceName);
  if (existing) return { workspaceId: existing.id, created: false };
  const root = createHubWorkspaceDirStore().view().effectiveRootDir;
  let dir = path.join(root, sanitizeDirName(workspaceName));
  let suffix = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(root, `${sanitizeDirName(workspaceName)}-${suffix}`);
    suffix += 1;
  }
  const ws = await createWorkspace(
    { name: workspaceName, directoryPath: dir, description: 'momo-hub 镜像创建' },
    'owner',
  ).catch((err: unknown) => {
    // P2-11 错误精准化：仅文件系统权限类错误（EACCES/EPERM/EROFS）改写为
    // 「工作目录不可写」人话 + 整体拒绝（不静默回退默认根——否则用户以为落在
    // 自定义位置实际没有）；其余失败（DB 故障、目录形态错误等）原样透传，
    // 不再一律改写掩盖真实病因。
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new Error(`工作目录不可写（${root}）: ${(err as Error).message}`);
    }
    throw err;
  });
  return { workspaceId: ws.id, created: true };
}

/**
 * 资源补装（先装后落）。
 * 返回本次新装清单 + stale 跳过清单（M2.4 T1）：hub 最新目录不可达
 * （HubCatalogStaleError）时该资源**跳过**并记入 skipped（由调用方并入既有
 * unresolvedRefs），其余资源继续；非 stale 失败仍上抛中止整体（配置不落）。
 */
async function installResources(
  manifest: SnapshotManifest,
  workspaceId: string,
  installResource: NonNullable<MirrorApplierDeps['installResource']>,
): Promise<{ applied: string[]; skipped: string[] }> {
  const acc = loadHubAccountingSet();
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const r of manifest.resources) {
    const ref = `${r.type}/${r.slug}`;
    // 已装判定①：hub 记账命中（本机从 hub 装过）→ 跳过
    if (acc.get(r.type)?.has(r.slug)) continue;
    // 已装判定②：本地点位在位（builtin/内置市场目录同有——T7 交接兜底序）→ 跳过
    if (isLocallyPresent(r.type, r.slug)) continue;
    // 补装：M1 链（目录查项 → 下载 → 注册/记账）
    try {
      await installResource(r.type, r.slug, workspaceId);
    } catch (err) {
      // 只吞 stale 目录错误：无法获取 hub 最新目录 ≠ 该资源不存在，跳过即可
      // （软失败，reason 进回执 unresolvedRefs）；其余失败照旧整体中止。
      if (err instanceof HubCatalogStaleError) {
        skipped.push(`${r.type}:${r.slug}（无法获取 hub 最新目录，已跳过）`);
        continue;
      }
      throw err;
    }
    applied.push(ref);
  }
  return { applied, skipped };
}

/** 配置整体替换（后于资源补装）。软失败引用收集入 unresolvedRefs。
 *  defaultAgent（D2 可选段）：按名对齐重建成员后回写目标默认位——委派
 *  resolveAgentInstance 无 agentSlug 兜底链的数据前提；段缺省不动目标默认位
 *  （replace 重建成员后旧默认 instanceId 已悬空，resolveAgentInstance 自行
 *  判在册性回 null，死指针惰性）。 */
async function applyConfig(
  workspaceId: string,
  manifest: SnapshotManifest,
  stageDir: string,
  modelBinding: SnapshotModelBinding | null,
  defaultAgent: string | null,
): Promise<string[]> {
  const unresolved: string[] = [];
  const cfg = manifest.config;

  // ── 团队先清（FK 约束：成员在团队中时移除受阻；replace 语义=先清场再重建）──
  for (const t of listTeams(workspaceId)) deleteTeam(t.id);

  // ── agentMembers：整体置换 ──
  const instanceByName = new Map<string, string>();
  for (const m of listMembers(workspaceId)) removeMember(m.instanceId);
  const addedDefIds = new Set<string>();
  for (const m of cfg.agentMembers) {
    let defId: string | null = null;
    if (m.customDefinition !== undefined) {
      // 内嵌 custom 定义：parseAgentManifest 反序列化（构建器出厂已过同一校验）
      let def;
      try {
        def = parseAgentManifest(m.customDefinition);
      } catch (err) {
        logger.warn('镜像成员内嵌定义解析失败，跳过', { name: m.name, error: (err as Error).message });
        unresolved.push(`agent:${m.name}`);
        continue;
      }
      def.source = 'custom';
      // 同 slug 复用既有定义 id（幂等重放不叠行）
      const existing = listAgentDefinitions().find((d) => d.slug === def.slug);
      if (existing) {
        def.id = existing.id;
        // D4 自愈①：YAML 不携模型绑定（providerId 是本机 DB 行 id，跨节点无意义）
        // ——重镜像复用既有定义时保留目标本机已配绑定，防 INSERT OR REPLACE
        // 把 worker 手设/上轮回写的 modelProviderId 清回 NULL（验收 D4 病灶）
        if (existing.modelProviderId) {
          def.modelProviderId = existing.modelProviderId;
          def.modelName = existing.modelName ?? def.modelName;
        }
      }
      saveAgentDefinition(def);
      defId = def.id;
    } else if (m.slug !== undefined) {
      let existing = listAgentDefinitions().find((d) => d.slug === m.slug);
      if (!existing) {
        // catalog 自愈：catalog-install 类引用目标未装 → 内置目录按需落装后复查
        if (await installFromLocalCatalog('agent', m.slug)) {
          existing = listAgentDefinitions().find((d) => d.slug === m.slug);
        }
      }
      if (!existing) {
        // 本机已装 → 内置市场目录 → catalog 自愈 → 失败提示（软失败）
        unresolved.push(`agent:${m.slug}`);
        continue;
      }
      defId = existing.id;
    } else {
      // 无引用键的名字行（构建端并发删除防御产物）——目标无从重建，软失败
      unresolved.push(`agent:${m.name}`);
      continue;
    }
    if (addedDefIds.has(defId)) continue; // 同定义多名（防御）：只入一次成员
    addedDefIds.add(defId);
    try {
      const member = await addMember(workspaceId, defId, generateAgentUserId(m.slug ?? m.name));
      instanceByName.set(m.name, member.instanceId);
    } catch (err) {
      logger.warn('镜像成员加入失败', { name: m.name, error: (err as Error).message });
      unresolved.push(`agent:${m.name}`);
    }
  }

  // ── teams：按名重建（leader/成员以 agent 定义名对齐——T7 契约）──
  for (const t of cfg.teams) {
    const ids: string[] = [];
    for (const name of [...new Set(t.members)]) {
      const inst = instanceByName.get(name);
      if (inst) ids.push(inst);
      else unresolved.push(`team:${t.name}:${name}`);
    }
    const leaderInst = instanceByName.get(t.leader);
    if (!leaderInst || ids.length < 2 || !ids.includes(leaderInst)) {
      unresolved.push(`team:${t.name}`);
      continue;
    }
    try {
      createTeam(workspaceId, t.name, '👥', ids, leaderInst);
    } catch (err) {
      logger.warn('镜像团队重建失败', { team: t.name, error: (err as Error).message });
      unresolved.push(`team:${t.name}`);
    }
  }

  // ── mcpEnabled：名单启用 + 名单外（构建器同款过滤域）禁用（整体替换）──
  const wanted = new Set(cfg.mcpEnabled);
  for (const m of listRegistered()) {
    if (m.source === 'plugin' || m.transport !== 'stdio' || m.url) continue; // 镜像域外不动
    if (wanted.has(m.name)) {
      if (!m.enabled) setMcpEnabledDefinition(m.name, true);
    } else if (m.enabled) {
      setMcpEnabledDefinition(m.name, false);
    }
  }
  const registeredNames = new Set(listRegistered().map((m) => m.name));
  for (const name of wanted) {
    if (!registeredNames.has(name)) unresolved.push(`mcp:${name}`);
  }

  // ── skills：就位确保（不删本地多出——builtin/marketplace 无删除链）──
  const installed = new Set(listInstalled().map((s) => s.slug));
  for (const slug of cfg.skills) {
    if (installed.has(slug)) continue;
    // custom 内嵌包（payload 布局契约：skills/<slug>/ 在归档内）→ 落本机 custom 目录
    const embeddedDir = path.join(stageDir, 'skills', slug);
    if (fs.existsSync(path.join(embeddedDir, 'SKILL.md'))) {
      const dest = path.join(getSkillsDir(), slug);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      for (const rel of listFilesRecursive(embeddedDir)) {
        const target = path.join(dest, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(embeddedDir, rel), target);
      }
      // custom 标记（listInstalled 的 custom 判定=有 .sha256 标记；内容=SKILL.md 哈希）
      const skillMd = fs.readFileSync(path.join(dest, 'SKILL.md'));
      fs.writeFileSync(path.join(dest, '.sha256'), crypto.createHash('sha256').update(skillMd).digest('hex'));
      installed.add(slug);
      continue;
    }
    // catalog 自愈：catalog-install 类引用目标未装 → 内置目录按需落装后复查
    if (await installFromLocalCatalog('skill', slug)) {
      const recheck = listInstalled().find((s) => s.slug === slug);
      if (recheck) {
        installed.add(slug);
        continue;
      }
    }
    unresolved.push(`skill:${slug}`);
  }

  // ── pluginsEnabled：本工作空间启用面整体替换 ──
  const wantedPlugins = new Set(cfg.pluginsEnabled.map((p) => p.pluginId));
  for (const p of cfg.pluginsEnabled) {
    if (!getPlugin(p.pluginId)) {
      unresolved.push(`plugin:${p.pluginId}`); // 注册行缺席（补装失败/未发布）——软失败
      continue;
    }
    if (!isPluginEnabled(p.pluginId, workspaceId)) setPluginEnabled(p.pluginId, workspaceId, true);
  }
  for (const p of listPlugins()) {
    if (!wantedPlugins.has(p.id) && isPluginEnabled(p.id, workspaceId)) {
      setPluginEnabled(p.id, workspaceId, false);
    }
  }

  // ── providerRefs：仅对齐 platform+defaultModel（目标本机 key 不动）──
  for (const r of cfg.providerRefs) {
    const local = listProviders().find((p) => p.platform === r.provider);
    if (!local) {
      unresolved.push(`provider:${r.provider}`);
      continue;
    }
    if (r.model !== undefined && local.defaultModel !== r.model) {
      await updateProvider({ id: local.id, defaultModel: r.model });
    }
  }

  // ── modelBinding：默认模型绑定段（D4）。RM2-10：不覆盖目标本机显式选择——
  //    provider 行已有 defaultModel / 全局 defaultChatModel 有效指向均不写；
  //    provider 缺席软失败入 unresolved；成员定义绑定缺失**或失效**（引用的
  //    provider 行已删——ghost 绑定）时回写兜底（D4 自愈②：重镜像修复首镜
  //    时 provider 缺席遗留的空缺/悬空绑定；有有效绑定不动——显式选择语义
  //    保持；对齐 agent:addMember 的 defaultChatModel 兜底语义，委派首跑
  //    spawn 链 buildSpawnOpts 硬校验 def.modelProviderId）──
  if (modelBinding) {
    const local = listProviders().find((p) => p.platform === modelBinding.provider);
    if (!local) {
      unresolved.push(`modelBinding:${modelBinding.provider}`);
    } else {
      if (!local.defaultModel) {
        await updateProvider({ id: local.id, defaultModel: modelBinding.model });
      }
      const providersNow = listProviders();
      const global = getGlobalSettings().defaultChatModel;
      const globalGhost = global !== undefined && !providersNow.some((p) => p.id === global.providerId);
      if (global === undefined || globalGhost) {
        updateGlobalSettings({
          defaultChatModel: { providerId: local.id, modelId: modelBinding.model },
        });
      }
      for (const defId of addedDefIds) {
        const def = getAgentDefinition(defId);
        const bindingGhost = def?.modelProviderId != null && getProvider(def.modelProviderId) == null;
        if (def && (def.modelProviderId == null || bindingGhost)) {
          updateAgentDefinition({ id: defId, modelProviderId: local.id, modelName: modelBinding.model });
        }
      }
    }
  }

  // ── defaultAgent：默认会话 agent 段（D2）。按名对齐本次重建的成员实例并
  //    回写目标默认位；段在场但成员未重建（解析失败/软失败）→ unresolved
  //    记录（leader 结果面可见），默认位不写。段缺省（旧快照）零触碰。──
  if (defaultAgent !== null) {
    const instanceId = instanceByName.get(defaultAgent);
    if (instanceId === undefined) {
      unresolved.push(`defaultAgent:${defaultAgent}`);
    } else {
      setDefaultAgent(workspaceId, instanceId);
    }
  }

  // ── prefs：白名单键整体覆盖（全局设置——T7 Concerns 4 影响面由向导 S3 明示）──
  const patch: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(cfg.prefs)) {
    if (PREFS_KEYS.has(k)) patch[k] = v;
  }
  if (Object.keys(patch).length > 0) updateGlobalSettings(patch);

  return unresolved;
}

/** 递归列常规文件（相对路径；非常规条目跳过——内嵌 skill 为构建器白名单产物）。 */
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = base === '' ? ent.name : `${base}/${ent.name}`;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else if (ent.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 应用入口（responder 消费——永不 throw，一切失败走 outcome）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 应用镜像快照（目标节点侧核心）。执行序与回执契约见模块头注释。
 * deps 缺省走生产链（hub 配置 + keychain + installHubPackage）。
 */
export async function applyMirrorSnapshot(
  payload: MirrorApplyPayload,
  deps: MirrorApplierDeps = {},
): Promise<MirrorApplyOutcome> {
  const fetchSnapshotArchive = deps.fetchSnapshotArchive ?? defaultFetchSnapshotArchive;
  const installResource = deps.installResource ?? defaultInstallResource;

  // 入参闸（hub 端已校验过同款形态——此处为坏信封/直连调试防御）
  if (typeof payload.workspaceName !== 'string' || payload.workspaceName.length === 0 || payload.workspaceName.length > MAX_WORKSPACE_NAME) {
    return { ok: false, code: 'bad_request', message: `workspaceName 非法（1-${MAX_WORKSPACE_NAME} 字符）` };
  }
  if (payload.strategy !== 'replace') {
    return { ok: false, code: 'bad_request', message: `strategy 非法: ${String(payload.strategy)}（M2 仅支持 replace）` };
  }

  // 在途对账：同步段预占（两发并发不得双双过检——hub 侧同款纪律）
  if (inFlightApplies.has(payload.workspaceName)) {
    return {
      ok: false,
      code: 'conflict',
      message: 'mirror_in_progress：该工作空间已有在途镜像应用，请稍后重试',
    };
  }
  inFlightApplies.add(payload.workspaceName);
  // 快照解包暂存目录（finally 统一清理——conflict 早退也不例外）
  let stageRoot: string | null = null;
  try {
    // 1. 取包（下载 + sha256 + 解包 + manifest 校验）
    let fetched: {
      manifest: SnapshotManifest;
      stageDir: string;
      modelBinding: SnapshotModelBinding | null;
      defaultAgent: string | null;
    };
    try {
      const { bytes, checksum } = await fetchSnapshotArchive(payload.snapshotId);
      const extracted = await extractSnapshot(bytes, checksum);
      fetched = {
        manifest: extracted.manifest,
        stageDir: extracted.stageDir,
        modelBinding: extracted.modelBinding,
        defaultAgent: extracted.defaultAgent,
      };
      stageRoot = path.dirname(extracted.stageDir);
    } catch (err) {
      return {
        ok: false,
        code: 'not_found',
        message: `快照取包失败: ${(err as Error).message}`,
      };
    }
    const { manifest, stageDir } = fetched;

    // 2. 工作空间分流：不存在 → 创建后直落；存在且未 confirm → conflict + 差异摘要
    const existing = listWorkspaces().find((w) => w.name === payload.workspaceName);
    let workspaceId: string;
    if (!existing) {
      const ensured = await ensureWorkspace(payload.workspaceName);
      workspaceId = ensured.workspaceId;
    } else if (payload.confirm !== true) {
      const diffSummary = computeDiffSummary(existing.id, manifest);
      return {
        ok: false,
        code: 'conflict',
        message: `目标节点已存在同名工作空间「${payload.workspaceName}」，需确认覆盖（差异：+${diffSummary.added} / -${diffSummary.removed} / ±${diffSummary.changed}）`,
        diffSummary,
      };
    } else {
      workspaceId = existing.id;
    }

    // 3. 先资源补装（非 stale 失败中止——配置不落，目标保持原状；已装资源保留
    //    可重试；stale 目录错误跳过该资源并记 skipped，不中止整体）
    let appliedResources: string[];
    let staleSkipped: string[];
    try {
      const installed = await installResources(manifest, workspaceId, installResource);
      appliedResources = installed.applied;
      staleSkipped = installed.skipped;
    } catch (err) {
      return {
        ok: false,
        code: 'internal',
        message: `资源补装失败，配置未落库（目标保持原状）: ${(err as Error).message}`,
      };
    }

    // 4. 后配置落库（七子段 + modelBinding/defaultAgent 可选段整体替换；
    //    软失败引用入 unresolvedRefs——stale 跳过的资源同列其中，协议零变更）
    const configUnresolved = await applyConfig(
      workspaceId,
      manifest,
      stageDir,
      fetched.modelBinding,
      fetched.defaultAgent,
    );
    const unresolvedRefs = [...staleSkipped, ...configUnresolved];

    logger.info('镜像应用完成', {
      mirrorId: payload.mirrorId,
      workspaceName: payload.workspaceName,
      workspaceId,
      appliedResources: appliedResources.length,
      unresolvedRefs: unresolvedRefs.length,
      version: manifest.version,
    });
    return {
      ok: true,
      appliedResources,
      ...(unresolvedRefs.length > 0 ? { unresolvedRefs } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      code: 'internal',
      message: `镜像应用失败: ${(err as Error).message}`,
    };
  } finally {
    inFlightApplies.delete(payload.workspaceName);
    if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}
