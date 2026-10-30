// electron/src/main/hub/snapshot-builder.ts
//
// 工作空间配置快照构建器（momo-hub M2 spec §5.2 镜像流第 1 步 / Task 7，leader 侧）。
//
// payload 布局约定（T8 应用器消费契约——两文件头注释必须同步维护）：
//   manifest.json            ——快照清单，唯一入口（hub 端 / T5 validateSnapshotManifest 消费）
//   skills/<slug>/SKILL.md…  ——custom skill 内嵌包（.sha256/.installed 安装标记不入包）；
//                               marketplace/hub 来源 skill 只引用 slug 不内嵌；已发布
//                               （hub 记账命中）custom skill 同样不内嵌、占 resources 位
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
//   skills        ——listInstalled（skill/zip-uploader；builtin/marketplace/custom 三源）；
//                    marketplace 来源无 hub 记账 → 聚合计数 logger.warn（leader 可见
//                    信号，M2.2 T8 观察件——目标节点可能 unresolved）
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
import { agentManifestYaml, collectRegularFiles, tarDirectory } from './publish';
import { loadHubAccountingSet } from './accounting';
import { resolveTmpDir } from '../paths';
import { SECRET_VALUE_PATTERNS } from '../util/redact';
import {
  validateSnapshotManifest,
  type SnapshotAgentMember,
  type SnapshotManifest,
  type SnapshotPluginRef,
  type SnapshotProviderRef,
  type SnapshotResourceRef,
  type SnapshotTeam,
} from './protocol';
import type { SnapshotConfigWithModelBinding, SnapshotModelBinding, SnapshotMemberModelBinding } from './snapshot-model-binding';
import type { SnapshotConfigWithDefaultAgent } from './snapshot-default-agent';

/** 构建侧成员条目：pin SnapshotAgentMember + F2 modelBinding 可选段
 *  （pin 校验器成员条目白名单无此键——段只经原始 manifest.json 送达目标） */
export type SnapshotMemberWithModelBinding = SnapshotAgentMember & {
  modelBinding?: SnapshotMemberModelBinding;
};

/** 构建产物：manifest（自检已过 validateSnapshotManifest）+ tar.gz 归档 + sha256。 */
export interface WorkspaceSnapshotResult {
  /** config 为 pin 七子段 + modelBinding/defaultAgent/成员 modelBinding 可选段
   *  （D4/D2/M5.3 F2——段结构与 hub 存档字节一致；pin 校验器对可选段未知容忍
   *  剥除，应用侧从原始 manifest.json 提取） */
  manifest: Omit<SnapshotManifest, 'config'> & {
    config: Omit<SnapshotConfigWithModelBinding & SnapshotConfigWithDefaultAgent, 'agentMembers'> & {
      agentMembers: SnapshotMemberWithModelBinding[];
    };
  };
  /** 临时归档路径（resolveTmpDir 下），归调用方管理——上传后清理（对齐 publish 纪律） */
  archivePath: string;
  /** 归档文件 sha256（hex）——上传流的信息性回执对照（hub 端以自算值为权威，C6） */
  checksum: string;
  /** 无 hub 记账而被排除的插件 id（zip/dev 来源）——UI 差异提示用，不阻断构建 */
  excludedPlugins: string[];
  /** 内嵌 custom skill 数（staging skills/<slug>/ 实体计数）——summary 分桶数据源；
   *  manifest config.skills 只有 slug 无来源信息，内嵌面不可从清单推导（P2-6） */
  skillEmbeddedCount: number;
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
 *  无正当携带场景，宁可误杀（fail-closed）不可漏放。
 *  M2.4 T2：正则族已搬移至 util/redact.ts（委派链脱敏共用），此处只保留导入。 */

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

/** hub 记账面：item_type → slug → 记账版本（含 plugin 反查键 = 插件 id）。
 *  版本空串视为「无版本信息」（历史脏行兜底）——versionOf 返回 undefined。 */
class HubAccounting {
  private byType = new Map<string, Map<string, string>>();

  add(type: string, slug: string, version: string): void {
    const bySlug = this.byType.get(type) ?? new Map<string, string>();
    bySlug.set(slug, version);
    this.byType.set(type, bySlug);
  }

  has(type: string, slug: string): boolean {
    return this.byType.get(type)?.has(slug) === true;
  }

  versionOf(type: string, slug: string): string | undefined {
    const v = this.byType.get(type)?.get(slug);
    return v !== undefined && v !== '' ? v : undefined;
  }
}

function loadHubAccounting(): HubAccounting {
  // 查询单点收口（M2.3 T5 件2 / M2.4 T5 抽到 accounting.ts）：hub 记账面 SQL 统一走
  // loadHubAccountingSet（契约见其 JSDoc）——此前本模块私有同款查询，两处漂移风险
  const acc = new HubAccounting();
  for (const [type, bySlug] of loadHubAccountingSet()) {
    for (const [slug, version] of bySlug) acc.add(type, slug, version);
  }
  return acc;
}

/** 记账命中的引用条目（B13 快照定型语义）：记账版本在场则钉死 version——目标
 *  节点按该版本安装/升级，而非 hub 目录 latest；记账行无版本信息（空串）不带
 *  version 字段 = 旧 latest 语义（1.4 manifest 形态，消费端零变化）。 */
function resourceRef(type: 'agent' | 'mcp' | 'skill' | 'plugin', slug: string, acc: HubAccounting): SnapshotResourceRef {
  const version = acc.versionOf(type, slug);
  return { type, slug, ...(version !== undefined ? { version } : {}) };
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
 * M5.3 F2：成员级模型绑定收集——源 def 有 modelProviderId 时经 getProvider 解析
 * name/platform + def.modelName（provider 行悬空/modelName 空 → 不带段，warn 可见）。
 * 段挂 member 条目（三态行同构：引用行与 custom 行一致）；pin 校验器对成员条目
 * 未知字段剥除——段只经原始 manifest.json 送达目标（全局 modelBinding 段同款纪律）。
 */
function memberModelBindingOf(def: AgentDefinition): SnapshotMemberModelBinding | undefined {
  if (!def.modelProviderId || !def.modelName) return undefined;
  const provider = getProvider(def.modelProviderId);
  if (!provider) {
    logger.warn('成员模型绑定引用的 provider 不存在（ghost 绑定），快照不发该成员 modelBinding 段', {
      agent: def.name,
      modelProviderId: def.modelProviderId,
    });
    return undefined;
  }
  return { providerName: provider.name, platform: provider.platform, modelName: def.modelName };
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
): { member: SnapshotAgentMember & { modelBinding?: SnapshotMemberModelBinding }; resource: SnapshotResourceRef | null } {
  if (!def) return { member: { name: fallbackName }, resource: null }; // 并发删除防御：引用键悬空退化为名字行
  const modelBinding = memberModelBindingOf(def);
  if (def.source === 'custom') {
    const yaml = agentManifestYaml(def);
    try {
      parseAgentManifest(yaml);
    } catch (err) {
      throw new Error(
        `agent 定义「${def.name}」为历史脏定义（YAML 内嵌反序列化校验失败），拒绝入快照: ${(err as Error).message}`,
      );
    }
    return { member: { name: def.name, customDefinition: yaml, ...(modelBinding !== undefined ? { modelBinding } : {}) }, resource: null };
  }
  if (!def.slug) return { member: { name: def.name, ...(modelBinding !== undefined ? { modelBinding } : {}) }, resource: null };
  const resource = acc.has('agent', def.slug) ? resourceRef('agent', def.slug, acc) : null;
  return {
    member: { name: def.name, slug: def.slug, ...(modelBinding !== undefined ? { modelBinding } : {}) },
    resource,
  };
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
      resources.push(resourceRef('mcp', m.name, acc));
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
 *  resources 补装位 / 未发布 custom 目录内嵌 payload）。返回内嵌源目录清单供 staging 复制。
 *  UC-P1-3 分发闭环裁定（M2.2）：记账查询优先于 custom 内嵌——custom skill 发布到 hub 后
 *  hub 即该 skill 的权威分发源，占 resources 补装位且不再内嵌（双通道并存会让目标节点
 *  同 slug 两份分叉：installResources 落 marketplace 安装行 + 内嵌落 custom 目录）。 */
function collectSkills(acc: HubAccounting): {
  skills: string[];
  resources: SnapshotResourceRef[];
  embeddedDirs: Array<{ slug: string; dir: string }>;
} {
  const skills: string[] = [];
  const resources: SnapshotResourceRef[] = [];
  const embeddedDirs: Array<{ slug: string; dir: string }> = [];
  // marketplace 源且无记账：既不占 resources 也不内嵌——只进清单（目标节点能否
  // 解析取决于其本地目录，M2.2 T8 观察件——聚合计数 warn 一行供 leader 预警）
  const unaccounted: string[] = [];
  // listInstalled 多源拼接（builtin / marketplace 表 / custom 目录）同 slug 可出多行——
  // 清单是 slug 名单语义，按首见去重（顺序保持原遍历序，不用 Set 迭代序重排）；
  // resources 是补装位引用语义，不去重（条数与序不动）。
  const seenSlugs = new Set<string>();
  for (const s of listInstalled()) {
    if (!seenSlugs.has(s.slug)) {
      seenSlugs.add(s.slug);
      skills.push(s.slug);
    }
    if (acc.has('skill', s.slug)) {
      resources.push(resourceRef('skill', s.slug, acc));
    } else if (s.source === 'custom') {
      embeddedDirs.push({ slug: s.slug, dir: path.join(getSkillsDir(), s.slug) });
    } else if (s.source === 'marketplace') {
      unaccounted.push(s.slug);
    }
  }
  if (unaccounted.length > 0) {
    logger.warn('skill 无 hub 记账（marketplace 目录来源），只进清单不占补装位——目标节点可能 unresolved', {
      count: unaccounted.length,
      slugs: unaccounted,
    });
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
      resources.push(resourceRef('plugin', p.id, acc));
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
  const agentMembers: SnapshotMemberWithModelBinding[] = [];
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

  // 7. prefs + modelBinding/defaultAgent（可选段——缺省不发）+ manifest 定型 +
  //    结构自检（validateSnapshotManifest——hub 端同一校验的前置；pin 版对
  //    两可选段未知容忍剥除，应用侧从原始 manifest.json 提取）
  const modelBinding = collectModelBinding();
  // D2：源默认会话 agent 按成员名携带（instanceId 跨节点无意义）；默认位悬空
  //（指向非在册成员/未设）→ 不发段，目标默认位不动
  const defaultAgentName = ws.defaultAgentInstanceId
    ? (nameByInstance.get(ws.defaultAgentInstanceId) ?? null)
    : null;
  const manifest: SnapshotManifest & {
    config: SnapshotConfigWithModelBinding & SnapshotConfigWithDefaultAgent;
  } = {
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
      ...(defaultAgentName !== null ? { defaultAgent: defaultAgentName } : {}),
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
    return {
      manifest,
      archivePath,
      checksum,
      excludedPlugins: plugins.excludedPlugins,
      skillEmbeddedCount: skills.embeddedDirs.length,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
