// electron/src/main/hub/snapshot-builder.ts
//
// 工作空间配置快照构建器（momo-hub M2 spec §5.2 镜像流第 1 步 / Task 7，leader 侧）。
//
// payload 布局约定（T8 应用器消费契约——两文件头注释必须同步维护）：
//   manifest.json            ——快照清单，唯一入口（hub 端 / T5 validateSnapshotManifest 消费）
//   skills/<slug>/SKILL.md…  ——custom skill 内嵌包（.sha256/.installed 安装标记不入包）；
//                               marketplace/hub 来源 skill 只引用 slug 不内嵌
//
// 清单七子段（spec §5.2.1 清单权威，全部来自既有域查询入口——无旁路 SQL）：
//   agentMembers  ——listMembers + getAgentDefinition（agent-queries；引用/内嵌分流见
//                    splitAgentMember）；custom 定义经 agentManifestYaml 内嵌且先过
//                    parseAgentManifest 反序列化校验（历史脏定义穿透防线）
//   teams         ——listTeams（agent/team）
//   mcpEnabled    ——listRegistered（mcp/host-manager）过滤：enabled && stdio && 无 url
//                    && 非 plugin 来源（红线：url 形态/凭证头零进快照；plugin 来源
//                    MCP 由插件激活面重建，不占引用位）；marketplace 来源无 hub 记账
//                    → logger.warn（leader 可见信号，名字仍入清单——T8b 兜底解析）
//   skills        ——listInstalled（skill/zip-uploader；builtin/marketplace/custom 三源）
//   pluginsEnabled——listPlugins + isPluginEnabled（plugin/registry）+ installed_packages
//                    hub: 前缀记账反查（resource/hub/momo-hub）；无记账的 zip/dev 插件
//                    列入 excludedPlugins 并 warn，不阻断
//   providerRefs  ——listProviders（agent/provider-crud）只取 platform+defaultModel；
//                    ModelProvider 结构本就无 apiKey 字段（key 在 keychain，红线结构面安全）
//   prefs         ——getGlobalSettings（settings/crud）标量偏好（工具上限等）
//
// 资源引用分流（resources 补装清单 = M1 hub 资源仓 slug，T8 目标节点缺失自动补装）：
//   仅 installed_packages 有 `hub:{slug}` 记账的条目占 resources 位——builtin/内置
//   marketplace 目录随应用分发（目标节点同有），plugin 来源经插件镜像重建，均不占位。
//
// 红线锁（spec §6「镜像 payload 红线复检」，Review Focus #4——构建器侧单元锁）：
//   1. 零 provider key：manifest 结构扫描禁携字段名（apikey/authorization/headers…）
//      + 全文字节扫描 key 值形态（sk-…/Bearer …/ghp_…/xox…/64 位十六进制裸串）
//   2. 零 url-MCP 凭证头：url 形态 MCP 在源头上就不入清单（名单只有 stdio 名），
//      结构扫描对 headers/authorization 字段名全域拒绝兜底
//   3. 零聊天历史：本模块**不触碰 message_events**（聊天历史唯一真相源表）——
//      只读配置面七域，测试对源码静态断言无该表查询
//   违规即 throw（fail-closed），构建中止不留归档。
//
// 与 M1 publish 的关系：tar 构造复用 tarDirectory（白名单 walk / 体积预检 /
// assertSafeTarMembers 同一守卫链）；custom agent 定义内嵌复用 agentManifestYaml
// （与发布/安装链同一 YAML 形态，T8 应用侧零特判）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { getWorkspace } from '../workspace/crud';
import { listMembers, getAgentDefinition } from '../agent/agent-queries';
import type { AgentDefinition } from '../agent/types';
import { listTeams } from '../agent/team';
import { listProviders, getProvider } from '../agent/provider-crud';
import { parseAgentManifest } from '../agent/manifest-parser';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled, getSkillsDir } from '../skill/zip-uploader';
import { listPlugins, isPluginEnabled } from '../plugin/registry';
import { getGlobalSettings, DEFAULT_JOURNAL_QUOTA_MB } from '../settings/crud';
import { HUB_ITEM_ID_PREFIX } from '../resource/hub/momo-hub';
import { agentManifestYaml, collectRegularFiles, tarDirectory } from './publish';
import { resolveTmpDir } from '../paths';
import {
  validateSnapshotManifest,
  type SnapshotAgentMember,
  type SnapshotManifest,
  type SnapshotPluginRef,
  type SnapshotProviderRef,
  type SnapshotResourceRef,
  type SnapshotTeam,
} from './protocol';
import type { SnapshotConfigWithModelBinding, SnapshotModelBinding } from './snapshot-model-binding';

/** 构建产物：manifest（自检已过 validateSnapshotManifest）+ tar.gz 归档 + sha256。 */
export interface WorkspaceSnapshotResult {
  /** config 为 pin 七子段 + modelBinding 可选段（D4——段结构与 hub 仓逐字对齐） */
  manifest: SnapshotManifest & { config: SnapshotConfigWithModelBinding };
  /** 临时归档路径（resolveTmpDir 下），归调用方管理——上传后清理（对齐 publish 纪律） */
  archivePath: string;
  /** 归档文件 sha256（hex）——上传流的信息性回执对照（hub 端以自算值为权威，C6） */
  checksum: string;
  /** 无 hub 记账而被排除的插件 id（zip/dev 来源）——UI 差异提示用，不阻断构建 */
  excludedPlugins: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// 红线扫描（导出供测试变异验证——扫描器本身是红线锁的单一真相源）
// ──────────────────────────────────────────────────────────────────────────

/** 红线违规格式：where=定位路径/文件，detail=人话描述 */
export interface RedlineViolation {
  where: string;
  detail: string;
}

/** 禁携字段名（归一化后全等匹配）：provider key / url-MCP 凭证头 / 通用凭证词。
 *  归一化 = 小写 + 去非字母数字——apiKey / api_key / api-key / API-KEY 同杀。
 *  字段名扫描不误伤用户内容（systemPrompt 正文里的「api_key」是值域扫描的事）。 */
const FORBIDDEN_FIELD_NAMES = new Set([
  'apikey',
  'apikeyref',
  'apikeyoverride',
  'authorization',
  'xapikey',
  'secret',
  'clientsecret',
  'password',
  'credential',
  'credentials',
  'headers',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
  'token',
]);

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 结构扫描：manifest 对象树全域找禁携字段名（含嵌套数组/对象）。 */
export function findForbiddenFields(node: unknown, path = 'manifest'): RedlineViolation[] {
  const out: RedlineViolation[] = [];
  const walk = (n: unknown, p: string): void => {
    if (Array.isArray(n)) {
      n.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (n !== null && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        const kp = `${p}.${k}`;
        if (FORBIDDEN_FIELD_NAMES.has(normalizeFieldName(k))) {
          out.push({ where: kp, detail: `禁携字段名 "${k}"（凭证/凭证头材料）` });
        }
        walk(v, kp);
      }
    }
  };
  walk(node, path);
  return out;
}

/** 值形态扫描：已知 key 值形态的正则族（sk- 前缀 / Bearer 凭证 / ghp_ / xox / 64 位十六进制裸串）。
 *  64 位十六进制是 sha256 key/secret 的常见裸形态——快照正文（清单/内嵌 skill 文本）
 *  无正当携带场景，宁可误杀（fail-closed）不可漏放。 */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{12,}/, label: 'provider key 值（sk- 前缀）' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, label: 'Bearer 凭证值' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, label: 'GitHub token 值（ghp_ 前缀）' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token 值（xox 前缀）' },
  { re: /\b[0-9a-f]{64}\b/i, label: '64 位十六进制裸串（key/secret 形态）' },
];

/** 文本扫描：值形态正则 + 调用方已知凭证值（如上传流回填的 keychain 实值）全串包含比对。 */
export function scanTextForSecrets(
  text: string,
  where: string,
  knownSecrets: string[] = [],
): RedlineViolation[] {
  const out: RedlineViolation[] = [];
  for (const { re, label } of SECRET_VALUE_PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ where, detail: `${label}: "${m[0].slice(0, 10)}…"` });
  }
  for (const known of knownSecrets) {
    if (known.length > 0 && text.includes(known)) {
      out.push({ where, detail: `已知凭证实值出现: "${known.slice(0, 6)}…"` });
    }
  }
  return out;
}

/** 红线终检：manifest 结构扫描 + 归档 staging 全部文本文件字节扫描（manifest.json 在内）。
 *  任一违规 throw（fail-closed）。knownSecrets 供上传流 belt-and-suspenders 回填。 */
export function assertSnapshotRedline(
  manifest: unknown,
  stageDir: string,
  knownSecrets: string[] = [],
): void {
  const violations = findForbiddenFields(manifest);
  const payloadFiles = collectRegularFiles(stageDir, []);
  for (const rel of payloadFiles) {
    const text = fs.readFileSync(path.join(stageDir, rel), 'utf-8');
    violations.push(...scanTextForSecrets(text, rel, knownSecrets));
  }
  if (violations.length > 0) {
    const lines = violations.map((v) => `  - ${v.where}: ${v.detail}`).join('\n');
    throw new Error(`快照红线校验失败（零凭证渗漏红线，构建中止）:\n${lines}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// hub 记账反查（installed_packages `hub:{slug}` 前缀——M1 §6.2 零 schema 记账）
// ──────────────────────────────────────────────────────────────────────────

/** hub 记账面：item_type → slug 集（含 plugin 反查键 = 插件 id）。 */
class HubAccounting {
  private byType = new Map<string, Set<string>>();

  add(type: string, slug: string): void {
    const set = this.byType.get(type) ?? new Set<string>();
    set.add(slug);
    this.byType.set(type, set);
  }

  has(type: string, slug: string): boolean {
    return this.byType.get(type)?.has(slug) === true;
  }
}

function loadHubAccounting(): HubAccounting {
  const acc = new HubAccounting();
  const rows = getDb()
    .prepare('SELECT item_id, item_type FROM installed_packages')
    .all() as Array<{ item_id: string; item_type: string }>;
  for (const row of rows) {
    if (!row.item_id.startsWith(HUB_ITEM_ID_PREFIX)) continue;
    acc.add(row.item_type, row.item_id.slice(HUB_ITEM_ID_PREFIX.length));
  }
  return acc;
}

// ──────────────────────────────────────────────────────────────────────────
// 七子段组装
// ──────────────────────────────────────────────────────────────────────────

/** 快照版本号：UTC 紧凑时间戳 + 4 位随机 hex——过协议 VERSION_PATTERN，同工作空间
 *  重复构建必然不同（hub 端 workspace_name+version 唯一键 409 语义的正确配合）。 */
function snapshotVersion(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const core =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `.${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${core}.${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * 成员定义 → 快照成员（引用/内嵌分流）：
 *   custom          → customDefinition 内嵌（agentManifestYaml；先过 parseAgentManifest
 *                     反序列化校验——历史脏定义〔空 prompt/坏 slug 等 YAML 不可逆形态〕
 *                     在此拒绝，不穿透进 manifest）
 *   marketplace/hub → slug 引用（hub 有记账则另占 resources 补装位）
 *   builtin/plugin  → slug 引用不占 resources（builtin 目标节点同有；plugin 由插件镜像重建）
 */
function splitAgentMember(
  def: AgentDefinition | null,
  fallbackName: string,
  acc: HubAccounting,
): { member: SnapshotAgentMember; resource: SnapshotResourceRef | null } {
  if (!def) return { member: { name: fallbackName }, resource: null }; // 并发删除防御：引用键悬空退化为名字行
  if (def.source === 'custom') {
    const yaml = agentManifestYaml(def);
    try {
      parseAgentManifest(yaml);
    } catch (err) {
      throw new Error(
        `agent 定义「${def.name}」为历史脏定义（YAML 内嵌反序列化校验失败），拒绝入快照: ${(err as Error).message}`,
      );
    }
    return { member: { name: def.name, customDefinition: yaml }, resource: null };
  }
  if (!def.slug) return { member: { name: def.name }, resource: null };
  const resource = acc.has('agent', def.slug) ? { type: 'agent' as const, slug: def.slug } : null;
  return { member: { name: def.name, slug: def.slug }, resource };
}

/** MCP 启用清单：enabled && stdio && 无 url && 非 plugin 来源（红线 + 重建语义双闸）。
 *  marketplace 来源（含 hub 记账形态——DB 层 hub 安装同落 source='marketplace'）且无
 *  hub 记账命中 → logger.warn（与插件 excludedPlugins 同待遇的 leader 可见信号）；
 *  名字仍入清单（manifest 结构不变），T8b 应用器对解析失败给兜底语义。 */
function collectMcpEnabled(acc: HubAccounting): {
  mcpEnabled: string[];
  resources: SnapshotResourceRef[];
} {
  const mcpEnabled: string[] = [];
  const resources: SnapshotResourceRef[] = [];
  for (const m of listRegistered()) {
    if (!m.enabled || m.transport !== 'stdio' || m.url || m.source === 'plugin') continue;
    mcpEnabled.push(m.name);
    if (acc.has('mcp', m.name)) {
      resources.push({ type: 'mcp', slug: m.name });
    } else if (m.source === 'marketplace') {
      logger.warn('MCP 无 hub 记账（纯 marketplace 目录来源），目标节点可能无法解析', {
        name: m.name,
        source: m.source,
      });
    }
  }
  return { mcpEnabled, resources };
}

/** skill 清单：全部已装 slug（builtin 目标同有 / marketplace 目录目标同有 / hub 记账占
 *  resources 补装位 / custom 目录内嵌 payload）。返回内嵌源目录清单供 staging 复制。 */
function collectSkills(acc: HubAccounting): {
  skills: string[];
  resources: SnapshotResourceRef[];
  embeddedDirs: Array<{ slug: string; dir: string }>;
} {
  const skills: string[] = [];
  const resources: SnapshotResourceRef[] = [];
  const embeddedDirs: Array<{ slug: string; dir: string }> = [];
  for (const s of listInstalled()) {
    skills.push(s.slug);
    if (s.source === 'custom') {
      embeddedDirs.push({ slug: s.slug, dir: path.join(getSkillsDir(), s.slug) });
    } else if (acc.has('skill', s.slug)) {
      resources.push({ type: 'skill', slug: s.slug });
    }
  }
  return { skills, resources, embeddedDirs };
}

/** 插件启用清单：workspace 启用面 + hub 记账反查；zip/dev 无记账 → excluded + warn。 */
function collectPlugins(workspaceId: string, acc: HubAccounting): {
  pluginsEnabled: SnapshotPluginRef[];
  resources: SnapshotResourceRef[];
  excludedPlugins: string[];
} {
  const pluginsEnabled: SnapshotPluginRef[] = [];
  const resources: SnapshotResourceRef[] = [];
  const excludedPlugins: string[] = [];
  for (const p of listPlugins()) {
    if (!isPluginEnabled(p.id, workspaceId)) continue;
    // 插件记账键：item_id = `hub:{插件id}`（安装侧 manifest.id === 目录 slug 锚定）
    if (acc.has('plugin', p.id)) {
      pluginsEnabled.push({ pluginId: p.id, slug: p.id });
      resources.push({ type: 'plugin', slug: p.id });
    } else {
      excludedPlugins.push(p.id);
      logger.warn('插件无 hub 记账（zip/dev 来源），不入快照启用清单', {
        pluginId: p.id,
        source: p.source,
        workspaceId,
      });
    }
  }
  return { pluginsEnabled, resources, excludedPlugins };
}

/** provider 引用：类型（platform）+ 型号偏好（defaultModel）——ModelProvider 映射面
 *  本就无 apiKey 列（key 全在 keychain），红线结构面安全；同型同模去重。 */
function collectProviderRefs(): SnapshotProviderRef[] {
  const out: SnapshotProviderRef[] = [];
  for (const p of listProviders()) {
    const ref: SnapshotProviderRef = p.defaultModel
      ? { provider: p.platform, model: p.defaultModel }
      : { provider: p.platform };
    if (!out.some((r) => r.provider === ref.provider && r.model === ref.model)) out.push(ref);
  }
  return out;
}

/**
 * 默认模型绑定段（D4 可选段）：读设置域全局默认对话模型（defaultChatModel），
 * 经 provider 行解析为 platform 口径（providerId 是本机 DB 行 id，跨节点无意义）。
 * 无绑定 / 引用悬空（provider 行已删）→ undefined 缺省不发段（1.2.0 兼容）。
 */
function collectModelBinding(): SnapshotModelBinding | undefined {
  const ref = getGlobalSettings().defaultChatModel;
  if (!ref) return undefined;
  const provider = getProvider(ref.providerId);
  if (!provider) {
    logger.warn('defaultChatModel 引用的 provider 不存在，快照不发模型绑定段', {
      providerId: ref.providerId,
    });
    return undefined;
  }
  return { provider: provider.platform, model: ref.modelId };
}

/** 工具上限等偏好：全局设置标量子集（七子段外的第 8 配置面，协议 prefs 段）。 */
function collectPrefs(): Record<string, string | number | boolean> {
  const g = getGlobalSettings();
  const prefs: Record<string, string | number | boolean> = {
    maxToolCalls: g.maxToolCalls,
    maxConcurrentTasks: g.maxConcurrentTasks ?? 3,
    auditQuotaMb: g.auditQuotaMb,
    journalQuotaMb: g.journalQuotaMb ?? DEFAULT_JOURNAL_QUOTA_MB,
    memoryEnabled: g.memoryEnabled ?? true,
    memoryExtractionEnabled: g.memoryExtractionEnabled ?? true,
  };
  // 可选键：undefined 不落（prefs 值域是 string|number|boolean，协议校验拒 undefined）
  if (g.sandboxMode) prefs.sandboxMode = g.sandboxMode;
  if (g.sandboxNetworkPolicy) prefs.sandboxNetworkPolicy = g.sandboxNetworkPolicy;
  return prefs;
}

/** custom skill 目录 → stage/skills/<slug>/（.sha256/.installed 安装标记不入包）。 */
function embedSkillDirs(
  stage: string,
  dirs: Array<{ slug: string; dir: string }>,
): void {
  for (const { slug, dir } of dirs) {
    const entries = collectRegularFiles(dir, ['.sha256', '.installed']);
    for (const rel of entries) {
      const dest = path.join(stage, 'skills', slug, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(dir, rel), dest);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 构建入口
// ──────────────────────────────────────────────────────────────────────────

/**
 * 构建工作空间配置快照（spec §5.2 第 1 步）：七子段清单组装（真实域查询入口）→
 * manifest 自检（validateSnapshotManifest）→ staging（manifest.json 在根 + custom
 * skill 内嵌）→ 红线终检（零 key/零凭证头/结构+字节双扫描）→ tar.gz + sha256。
 *
 * 不触碰 message_events（聊天历史）——本函数与被其调用的查询面均为配置只读。
 */
export async function buildWorkspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshotResult> {
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`工作空间不存在: ${workspaceId}`);
  const acc = loadHubAccounting();

  // 1+2. 成员（引用/内嵌分流）与团队（leader/members 以 agent 名对齐——T8 按名重建）
  const nameByInstance = new Map<string, string>();
  const agentMembers: SnapshotAgentMember[] = [];
  const resourceRefs: SnapshotResourceRef[] = [];
  for (const m of listMembers(workspaceId)) {
    nameByInstance.set(m.instanceId, m.agentName);
    const { member, resource } = splitAgentMember(
      getAgentDefinition(m.agentDefinitionId),
      m.agentName,
      acc,
    );
    agentMembers.push(member);
    if (resource) resourceRefs.push(resource);
  }
  const teams: SnapshotTeam[] = listTeams(workspaceId).map((t) => {
    const leader = nameByInstance.get(t.leaderInstanceId);
    if (!leader) {
      // 防御分支：schema 级联（teams.leader FK CASCADE）使该态正常不可达——
      // 留闸防未来 schema 漂移把悬空 leader 放进来，fail-fast 不产半截团队
      throw new Error(
        `团队「${t.name}」leader 无法解析为 agent 成员（定义可能已被删除），拒绝入快照`,
      );
    }
    return {
      name: t.name,
      leader,
      members: t.members.map((mm) => nameByInstance.get(mm.instanceId) ?? mm.agentName),
    };
  });

  // 3~6. MCP / skill / 插件 / provider
  const mcp = collectMcpEnabled(acc);
  const skills = collectSkills(acc);
  const plugins = collectPlugins(workspaceId, acc);
  const providerRefs = collectProviderRefs();

  // resources 去重（同 type+slug 只占一席——多成员引用同一 hub 资源常态）
  const seenResources = new Set<string>();
  const resources: SnapshotResourceRef[] = [];
  for (const r of [...resourceRefs, ...mcp.resources, ...skills.resources, ...plugins.resources]) {
    const key = `${r.type}\0${r.slug}`;
    if (seenResources.has(key)) continue;
    seenResources.add(key);
    resources.push(r);
  }

  // 7. prefs + modelBinding（可选段——无默认模型缺省不发）+ manifest 定型 + 结构自检
  // （validateSnapshotManifest——hub 端同一校验的前置；pin 版对 modelBinding 未知容忍剥除）
  const modelBinding = collectModelBinding();
  const manifest: SnapshotManifest & { config: SnapshotConfigWithModelBinding } = {
    workspaceName: ws.name,
    version: snapshotVersion(),
    resources,
    config: {
      agentMembers,
      teams,
      mcpEnabled: mcp.mcpEnabled,
      skills: skills.skills,
      pluginsEnabled: plugins.pluginsEnabled,
      providerRefs,
      prefs: collectPrefs(),
      ...(modelBinding !== undefined ? { modelBinding } : {}),
    },
  };
  if (validateSnapshotManifest(manifest) === null) {
    throw new Error('快照 manifest 结构自检失败（字段超限或形态不符——不应发生）');
  }

  // staging：manifest.json 在根 + custom skill 内嵌 → 红线终检 → tar.gz
  const stage = fs.mkdtempSync(path.join(resolveTmpDir(), 'ws-snapshot-'));
  try {
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    embedSkillDirs(stage, skills.embeddedDirs);
    assertSnapshotRedline(manifest, stage);
    const archivePath = await tarDirectory(stage, [], `ws-${workspaceId}`);
    const checksum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(archivePath))
      .digest('hex');
    logger.info('工作空间快照已构建', {
      workspaceId,
      workspaceName: ws.name,
      version: manifest.version,
      members: agentMembers.length,
      resources: resources.length,
      excludedPlugins: plugins.excludedPlugins.length,
    });
    return { manifest, archivePath, checksum, excludedPlugins: plugins.excludedPlugins };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
