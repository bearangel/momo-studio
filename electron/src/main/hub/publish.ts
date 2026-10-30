// electron/src/main/hub/publish.ts
//
// 发布编排（momo-hub M1 spec §6.4 / Task 13）：四类资源各自打包 → multipart 上传。
//
// 打包形态（与安装链一一对应——hub 侧下载 → installPackage / installPluginHubArchive 可复原）：
//   - agent：custom 定义 → 临时目录写 manifest.yaml（yamlDump，parseAgentManifest 可逆）
//     + README.md → tar.gz；安装侧解包后走 parseAgentManifest + saveAgentDefinition
//   - skill：cachePath 目录整包 → tar.gz（SKILL.md + 附加资源；.installed/.sha256 标记排除）
//   - mcp：package.json stub（name=npx 包名）→ tar.gz——仅 stdio/npx 形态可发布
//     （安装侧注册为 `npx <name>`，url 形态无本地包可打，红线拒绝）
//   - plugin：委派 packPluginForPublish（T11——白名单 walk / 超限 / checksum 单源）
//
// 上传契约（hub 端 T6 /resources/publish）：multipart，**manifest part 必须先于
// package part**（hub 流式收包依赖定序）；Bearer deviceToken 鉴权；错误映射人话：
//   403→该资源属于节点 X，无法发布新版（M5.0 not_owner）/ 409→该版本已存在 /
//   413→超过 200MB 上限 / 401→连接已失效请重新接入 /
//   网络异常→无法连接 hub / 其余非 201→hub 响应异常带状态码。
//
// C3 范围守卫：agent 仅 source='custom'（marketplace/builtin/plugin 拒绝）；
// mcp 仅自定义 stdio npx 形态（url 红线 / 非 npx / 非 custom 拒绝）；
// skill/plugin 本地包天然合规（不设来源闸）。
//
// 发布面守卫：hubGetStatus 非 online → 「hub 未连接」（上传必经在线连接）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dump as yamlDump } from 'js-yaml';
import { getDb } from '../storage/db';
import { getAgentDefinition } from '../agent/agent-queries';
import { getProvider } from '../agent/provider-crud';
import { parseAgentManifest } from '../agent/manifest-parser';
import { listRegistered } from '../mcp/host-manager';
import type { AgentDefinition } from '../agent/types';
import { parseSkillMd } from '../skill/loader';
import { getSkillsDir, resolveBuiltinSkillsDir } from '../skill/zip-uploader';
import { packPluginForPublish } from '../plugin/publish-pack';
import { assertSafeTarMembers } from '../plugin/installer';
import { isValidNpmPackageName } from '../marketplace/types';
import { resolveTmpDir } from '../paths';
import { hubGetStatus } from './index';
import { getDeviceToken } from './creds';
import { humanizeNotOwner, parseOwnerName } from './http-errors';
import {
  isValidHubSlug,
  isValidHubVersion,
  validateHubManifest,
  type HubPublishManifest,
} from './protocol';

const execFileAsync = promisify(execFile);

/** 可发布的四类资源（与协议 HubResourceType 对齐） */
export type PublishResourceType = 'agent' | 'mcp' | 'skill' | 'plugin';

/** 发布面元数据（全部可选——缺省从本地定义回填） */
export interface PublishMeta {
  /** 目录展示名（缺省取本地定义名） */
  name?: string;
  /** 发布版本号（缺省取本地定义版本；须过 hub version 白名单） */
  version?: string;
  description?: string;
  /** README 正文（缺省 agent 取描述、skill 取 SKILL.md 正文；上限 64KB——hub §3.4） */
  readme?: string;
  tags?: string[];
  category?: string;
  iconEmoji?: string;
}

/** hub:publishResource 入参（types.d.ts HubPublishResourceInput 的 electron 侧镜像） */
export interface PublishInput {
  type: PublishResourceType;
  /** 定位键：agent=定义 id / skill=slug / mcp=注册名 / plugin=插件 id */
  ref: string;
  meta?: PublishMeta;
}

/** 发布成功回执（hub 201 应答透传——checksum/sizeBytes 为服务端自算权威值，C6） */
export interface PublishResult {
  slug: string;
  version: string;
  checksum: string;
  sizeBytes: number;
}

/** 上传应答最小结构（fetch Response 的消费面子集——测试注入用） */
export interface ResponseLike {
  status: number;
  json(): Promise<unknown>;
}

/** 注入缝：HTTP 边界 mock 只收窄在此（业务逻辑全真实） */
export interface PublishDeps {
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: FormData },
  ) => Promise<ResponseLike>;
}

// ──────────────────────────────────────────────────────────────────────────
// manifest 组装（meta 覆盖 + 本地定义兜底 + 客户端预校验）
// ──────────────────────────────────────────────────────────────────────────

/** 发布 manifest 的 slug/version 白名单 + 形状终检（人话错误，不发坏包上路） */
function assertManifestValid(manifest: HubPublishManifest): void {
  if (!isValidHubSlug(manifest.slug)) {
    throw new Error(
      `slug 非法: "${manifest.slug}"（仅允许小写字母/数字开头，后续小写字母/数字/连字符/点/下划线）`,
    );
  }
  if (!isValidHubVersion(manifest.version)) {
    throw new Error(`version 非法: "${manifest.version}"（仅允许数字/字母/点/加号/减号）`);
  }
  if (validateHubManifest(manifest) === null) {
    // 剩余字段级失败（readme 超 64KB / name 空 等）——统一指到具体上限
    throw new Error('发布 manifest 校验失败（name/readme 等字段不合法或 readme 超过 64KB 上限）');
  }
}

/** 发布 author：本机节点名（hub 端 RM1-8 以鉴权节点名记账，此字段仅满足必填）；未接入兜底常量 */
function publishAuthor(): string {
  return hubGetStatus().nodeName ?? 'momo-studio';
}

// ──────────────────────────────────────────────────────────────────────────
// agent：定义 → manifest.yaml + README.md
// ──────────────────────────────────────────────────────────────────────────

/** agent 定义 → K8s 风格 manifest.yaml 文本（parseAgentManifest 可逆；与 installer
 *  createInlinePackage 同构——安装侧零特判）。M2c 快照构建器复用（custom 定义内嵌）。 */
export function agentManifestYaml(def: AgentDefinition): string {
  // model.platform 经 provider 实例解析（manifest 校验只认 openai/anthropic）；
  // 定义未挂 provider（null）时兜底 openai——安装侧本就允许用户改配
  const platform = (def.modelProviderId ? getProvider(def.modelProviderId)?.platform : undefined) ?? 'openai';
  const manifest = {
    apiVersion: 'v1',
    kind: 'AgentDefinition',
    metadata: {
      name: def.name,
      slug: def.slug,
      version: def.version,
      description: def.description,
      iconEmoji: def.iconEmoji,
    },
    spec: {
      type: 'standalone',
      runtime: 'declarative',
      declarative: {
        systemPrompt: def.systemPrompt,
        model: { provider: platform, model: def.modelName },
      },
      defaultTools: def.defaultTools.map((t) => ({ kind: t.kind, ref: t.ref })),
    },
  };
  return yamlDump(manifest);
}

async function buildAgentPackage(
  ref: string,
  meta: PublishMeta,
): Promise<{ manifest: HubPublishManifest; archivePath: string }> {
  const def = getAgentDefinition(ref);
  if (!def) throw new Error(`agent 定义不存在: ${ref}`);
  // C3：仅自定义 agent 可发布（marketplace 装的是别人的包、builtin 随应用分发）
  if (def.source !== 'custom') {
    throw new Error(`仅自定义（source=custom）agent 可发布，当前来源为 ${def.source}`);
  }
  const readme = meta.readme ?? def.description;
  const manifest: HubPublishManifest = {
    slug: def.slug,
    type: 'agent',
    name: meta.name ?? def.name,
    version: meta.version ?? def.version,
    author: publishAuthor(),
    description: meta.description ?? def.description,
    readme,
    tags: meta.tags ?? [],
    category: meta.category ?? '',
    iconEmoji: meta.iconEmoji ?? def.iconEmoji,
    verificationStatus: 'unverified',
  };
  assertManifestValid(manifest);

  const stage = fs.mkdtempSync(path.join(resolveTmpDir(), 'publish-stage-'));
  try {
    const yaml = agentManifestYaml(def);
    // 可逆自检：产出的 manifest.yaml 必须能被安装侧同款解析器读回（防 yamlDump
    // 形态漂移把坏包发上路——契约在打点处锁，而非等安装方报错）
    try {
      parseAgentManifest(yaml);
    } catch (err) {
      throw new Error(`agent manifest.yaml 可逆自检失败（不应发生）: ${(err as Error).message}`);
    }
    fs.writeFileSync(path.join(stage, 'manifest.yaml'), yaml);
    fs.writeFileSync(path.join(stage, 'README.md'), readme);
    const archivePath = await tarDirectory(stage, [], `agent-${manifest.slug}`);
    return { manifest, archivePath };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// skill：cachePath 目录整包
// ──────────────────────────────────────────────────────────────────────────

/** skill 定位结果：cachePath = 打包目录；slug = 发布/记账键口径的语义 slug */
interface ResolvedSkillRef {
  cachePath: string;
  slug: string;
}

/** skill 定位三源：skill_definitions.cache_path（marketplace/hub 装面）→
 *  custom 上传目录（.sha256 标记面）→ builtin 目录。找不到返回 null。
 *  marketplace 装面的 cache_path 是版本化路径（…/<slug>/<version>，basename 是
 *  版本号——loader.ts parseSkillMd 的同款例外纪律），slug 语义来源是该行 slug 列
 *  （= collectSkills 反查键 skill_definitions.slug，与 hub:{slug} 记账键同口径）；
 *  custom/builtin 形态目录名即 slug。 */
function resolveSkillCachePath(ref: string): ResolvedSkillRef | null {
  try {
    const row = getDb()
      .prepare('SELECT slug, cache_path FROM skill_definitions WHERE slug = ?')
      .get(ref) as { slug: string; cache_path: string } | undefined;
    if (row?.cache_path && fs.existsSync(path.join(row.cache_path, 'SKILL.md'))) {
      return { cachePath: row.cache_path, slug: row.slug };
    }
  } catch {
    // DB 未就绪（表不存在等）——继续走 fs 面，不在这里拦死
  }
  const custom = path.join(getSkillsDir(), ref);
  if (fs.existsSync(path.join(custom, 'SKILL.md'))) return { cachePath: custom, slug: ref };
  const builtin = path.join(resolveBuiltinSkillsDir(), ref);
  if (fs.existsSync(path.join(builtin, 'SKILL.md'))) return { cachePath: builtin, slug: ref };
  return null;
}

async function buildSkillPackage(
  ref: string,
  meta: PublishMeta,
): Promise<{ manifest: HubPublishManifest; archivePath: string }> {
  const resolved = resolveSkillCachePath(ref);
  if (resolved === null) throw new Error(`skill 不存在: ${ref}`);
  const def = parseSkillMd(fs.readFileSync(path.join(resolved.cachePath, 'SKILL.md'), 'utf-8'), resolved.cachePath);
  const manifest: HubPublishManifest = {
    // marketplace 装面 parseSkillMd 按 basename 推导会得到版本号（版本号可过
    // isValidHubSlug → 静默上传错名条目 + 记账键错位），发布 slug 以 resolved.slug
    // 为准；custom/builtin 形态 resolved.slug 与目录名一致，行为不变
    slug: resolved.slug,
    type: 'skill',
    name: meta.name ?? def.name,
    version: meta.version ?? def.version,
    author: publishAuthor(),
    description: meta.description ?? def.description,
    readme: meta.readme ?? def.body,
    tags: meta.tags ?? [],
    category: meta.category ?? '',
    iconEmoji: meta.iconEmoji ?? '📦',
    verificationStatus: 'unverified',
  };
  assertManifestValid(manifest);
  // .installed/.sha256 是安装侧标记（custom 源标记 / marketplace 幂等标记），不入包
  const archivePath = await tarDirectory(resolved.cachePath, ['.installed', '.sha256'], `skill-${manifest.slug}`);
  return { manifest, archivePath };
}

// ──────────────────────────────────────────────────────────────────────────
// mcp：package.json stub
// ──────────────────────────────────────────────────────────────────────────

async function buildMcpPackage(
  ref: string,
  meta: PublishMeta,
): Promise<{ manifest: HubPublishManifest; archivePath: string }> {
  const def = listRegistered().find((x) => x.name === ref);
  if (!def) throw new Error(`MCP 不存在: ${ref}`);
  // C3 + 红线：url 形态没有本地包可打（stub 只能复原 npx 包）——最优先拒绝
  if (def.transport !== 'stdio' || def.url) {
    throw new Error('url 形态 MCP 不可发布（仅支持 npx 形态的 stdio MCP）');
  }
  if (def.source !== 'custom') {
    throw new Error(`仅自定义（source=custom）MCP 可发布，当前来源为 ${def.source}`);
  }
  if (def.command !== 'npx' || def.args.length === 0) {
    throw new Error('仅支持 npx 形态的 MCP 发布（command=npx 且带包名参数）');
  }
  // stub name = npx 包名（安装侧注册为 `npx <name>`，round-trip 复原）；
  // 过 npm 包名白名单（与安装侧 registerInstalledPackage 同防线——防二次注入）
  const npmName = def.args[0]!;
  if (!isValidNpmPackageName(npmName)) {
    throw new Error(`npx 包名 "${npmName}" 不符合 npm 包名规范，拒绝发布`);
  }
  const manifest: HubPublishManifest = {
    slug: def.name,
    type: 'mcp',
    name: meta.name ?? def.name,
    version: meta.version ?? def.version,
    author: publishAuthor(),
    description: meta.description ?? `${def.name}（npx ${npmName}）`,
    readme: meta.readme ?? `# ${def.name}\n\nnpx ${npmName}`,
    tags: meta.tags ?? [],
    category: meta.category ?? '',
    iconEmoji: meta.iconEmoji ?? '🔌',
    verificationStatus: 'unverified',
  };
  assertManifestValid(manifest);

  const stage = fs.mkdtempSync(path.join(resolveTmpDir(), 'publish-stage-'));
  try {
    fs.writeFileSync(
      path.join(stage, 'package.json'),
      JSON.stringify({ name: npmName, version: manifest.version, description: manifest.description }, null, 2),
    );
    const archivePath = await tarDirectory(stage, [], `mcp-${manifest.slug}`);
    return { manifest, archivePath };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// plugin：委派 packPluginForPublish（T11）
// ──────────────────────────────────────────────────────────────────────────

async function buildPluginPackage(
  ref: string,
  meta: PublishMeta,
): Promise<{ manifest: HubPublishManifest; archivePath: string }> {
  // 不存在/目录缺失/manifest 非法等由 T11 闸给出人话（含「插件不存在: <id>」）
  const pack = await packPluginForPublish(ref);
  const manifest: HubPublishManifest = {
    slug: pack.manifest.id,
    type: 'plugin',
    name: meta.name ?? pack.manifest.name,
    version: meta.version ?? pack.manifest.version,
    author: publishAuthor(),
    description: meta.description ?? pack.manifest.description,
    readme: meta.readme ?? pack.manifest.description,
    tags: meta.tags ?? [],
    category: meta.category ?? '',
    iconEmoji: meta.iconEmoji ?? '🧩',
    verificationStatus: 'unverified',
  };
  assertManifestValid(manifest); // 插件 id 已过 isValidSlug（同白名单），此处冗余终检
  return { manifest, archivePath: pack.archivePath };
}

// ──────────────────────────────────────────────────────────────────────────
// 公共面：四类分派 + tar + 上传
// ──────────────────────────────────────────────────────────────────────────

/**
 * 白名单 walk（plugin/publish-pack collectPackEntries 同语义，skill 目录用）：
 * 仅常规文件入包；排除 excludeDotFiles 标记；symlink / FIFO / 设备条目整包拒绝
 * （lstat 语义不跟随）；条目按名排序（确定性清单）。
 * M2c 快照构建器复用（custom skill 目录枚举）。
 */
export function collectRegularFiles(root: string, excludeDotFiles: string[]): string[] {
  const excluded = new Set(excludeDotFiles);
  const out: string[] = [];
  const walk = (dir: string, relBase: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relBase === '' ? ent.name : `${relBase}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), rel);
        continue;
      }
      if (ent.isSymbolicLink()) throw new Error(`目录包含符号链接条目，拒绝打包: ${rel}`);
      if (!ent.isFile()) throw new Error(`目录包含非常规文件条目（FIFO/设备等），拒绝打包: ${rel}`);
      if (excluded.has(ent.name)) continue;
      out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/** 发布包体积上限（200MB，hub 端 413 同款；与插件链 MAX_PUBLISH_ARCHIVE_BYTES
 *  对称——本地预检避免白传 200MB 后才被服务端拒） */
export const MAX_PUBLISH_PACKAGE_BYTES = 200 * 1024 * 1024;

/**
 * 目录 → tar.gz（显式清单入 tar：白名单外条目物理上进不了归档；数组参数不经 shell）。
 * 归档体积预检（T15a-F3）：tar 后以归档实际尺寸为准（压缩率不可预知，源尺寸小
 * 不代表归档小），超 maxBytes 即拒——agent/skill/mcp 三类共用路径；上限经参数
 * 注入（缺省生产常量），测试以小上限走同一终检路径。
 */
export async function tarDirectory(
  root: string,
  excludeDotFiles: string[],
  nameHint: string,
  maxBytes: number = MAX_PUBLISH_PACKAGE_BYTES,
): Promise<string> {
  const entries = collectRegularFiles(root, excludeDotFiles);
  if (entries.length === 0) throw new Error(`打包目录为空，拒绝发布: ${root}`);
  assertSafeTarMembers(entries); // `..` / 绝对路径成员终审（与安装侧同源守卫）
  const archivePath = path.join(
    resolveTmpDir(),
    `publish-${nameHint}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.tar.gz`,
  );
  try {
    await execFileAsync('tar', ['czf', archivePath, '-C', root, ...entries]);
    const sizeBytes = fs.statSync(archivePath).size;
    if (sizeBytes > maxBytes) {
      throw new Error('资源包超过 200MB 上限，请精简后重试');
    }
    return archivePath;
  } catch (err) {
    fs.rmSync(archivePath, { force: true }); // 失败不留半成品
    throw err;
  }
}

/** 入参闸：type/ref 非法即拒（先于环境守卫——坏输入不是连接问题） */
function assertInputValid(input: PublishInput): void {
  if (!['agent', 'mcp', 'skill', 'plugin'].includes(input.type)) {
    throw new Error(`发布类型非法: ${String(input.type)}（仅支持 agent/mcp/skill/plugin）`);
  }
  if (!input.ref || !input.ref.trim()) throw new Error('发布目标 ref 不能为空');
}

/** 四类打包分派。返回的 archivePath 归调用方管理（publishToHub 上传后清理）。 */
export async function buildPublishPackage(
  type: PublishResourceType,
  ref: string,
  meta: PublishMeta = {},
): Promise<{ manifest: HubPublishManifest; archivePath: string }> {
  assertInputValid({ type, ref });
  switch (type) {
    case 'agent': return buildAgentPackage(ref, meta);
    case 'skill': return buildSkillPackage(ref, meta);
    case 'mcp': return buildMcpPackage(ref, meta);
    case 'plugin': return buildPluginPackage(ref, meta);
  }
}

/**
 * 发布到 hub：入参闸 → 守卫（非 online 拒）→ 打包 → multipart 上传（manifest part
 * 在前）→ 回执透传。上传成败均清理临时归档。
 */
export async function publishToHub(input: PublishInput, deps?: PublishDeps): Promise<PublishResult> {
  assertInputValid(input);
  const status = hubGetStatus();
  if (status.state !== 'online' || !status.hubUrl) {
    throw new Error('hub 未连接，请先在设置中接入 momo-hub 并等待连接建立');
  }
  const deviceToken = await getDeviceToken();
  if (!deviceToken) throw new Error('连接已失效，请重新接入 hub（本地缺少 device token）');

  const { manifest, archivePath } = await buildPublishPackage(input.type, input.ref, input.meta ?? {});
  try {
    return await uploadPackage(status.hubUrl, deviceToken, manifest, archivePath, deps);
  } finally {
    fs.rmSync(archivePath, { force: true }); // 上传成败均清理（buildPublishPackage 单独使用时归调用方）
  }
}

/** multipart 上传（hub T6 契约：manifest part 必须先于 package part）。 */
async function uploadPackage(
  hubUrl: string,
  deviceToken: string,
  manifest: HubPublishManifest,
  archivePath: string,
  deps?: PublishDeps,
): Promise<PublishResult> {
  const fetchImpl =
    deps?.fetchImpl ??
    (async (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) =>
      fetch(url, init));
  // 定序契约（T6）：manifest part 先 append——FormData 保持 append 序，
  // undici 按序产出 multipart body；content-type 由 fetch 自动带 boundary，禁手工设
  const form = new FormData();
  form.append(
    'manifest',
    new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    'manifest.json',
  );
  form.append(
    'package',
    new Blob([fs.readFileSync(archivePath)], { type: 'application/gzip' }),
    'package.tar.gz',
  );

  let response: ResponseLike;
  try {
    response = await fetchImpl(`${hubUrl.replace(/\/+$/, '')}/resources/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: form,
    });
  } catch {
    throw new Error('无法连接 hub（网络不可达或服务未启动）');
  }

  if (response.status === 201) {
    const body = (await response.json().catch(() => null)) as {
      slug?: unknown; version?: unknown; checksum?: unknown; sizeBytes?: unknown;
    } | null;
    if (
      typeof body?.slug !== 'string' || typeof body?.version !== 'string' ||
      typeof body?.checksum !== 'string' || typeof body?.sizeBytes !== 'number'
    ) {
      throw new Error('hub 响应异常（发布回执缺字段）');
    }
    return { slug: body.slug, version: body.version, checksum: body.checksum, sizeBytes: body.sizeBytes };
  }
  // 错误映射人话（UI 直接展示；语义与 hub 端 T6 错误码一一对应）
  if (response.status === 403) {
    // M5.0 领地制（协议 1.8.0）：非 owner 发布 → 错误体 {error:'not_owner', owner_name}
    const body = await response.json().catch(() => null);
    throw new Error(humanizeNotOwner('发布新版', parseOwnerName(body)));
  }
  if (response.status === 409) {
    throw new Error('该版本已存在：hub 上同 slug+版本已发布（版本不可变），请升版本号后重试');
  }
  if (response.status === 413) {
    throw new Error('发布内容超过 200MB 上限，请精简后重试');
  }
  if (response.status === 401) {
    throw new Error('连接已失效，请重新接入 hub（设置 → 节点互联）');
  }
  throw new Error(`hub 响应异常: HTTP ${response.status}`);
}
