// electron/src/main/marketplace/installer.ts
//
// 包安装器：installPackage（下载 → 校验 → 解压/内联生成 → 注册 SQLite）+
// listInstalled + uninstallPackage。
//
// 安装缓存目录布局： <userData>/cache/<type>s/<slug>/<version>/
//   - 有 downloadUrl：下载 package.tar.gz → 校验 sha256 → tar 解压 → 删归档
//   - 无 downloadUrl（builtin 项）：从 catalog 的 readme/metadata 就地生成
//     manifest.yaml（agent）/ SKILL.md（skill）/ package.json stub（mcp）
// 完成后写 .installed 标记文件，重装时短路跳过。

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import fastGlob from 'fast-glob';
import { dump as yamlDump } from 'js-yaml';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { resolveUserDataDir } from '../paths';
import { parseAgentManifest } from '../agent/manifest-parser';
import { saveAgentDefinition, listAgentDefinitions } from '../agent/crud';
import type { ToolRef } from '../agent/types';
import { registerMcpDefinition } from '../mcp/host-manager';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS } from '../agent/tools/catalog';
import {
  isValidSlug,
  isValidVersion,
  isValidNpmPackageName,
  type MarketplaceItem,
} from './types';

const execFileAsync = promisify(execFile);

/** 单个包下载大小上限（200MB）：流式累计，超限中断，防超大归档撑爆磁盘/内存 */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// ────────────────────────────────────────────────────────────────────────────
// 可信下载源信任集（T8 / spec M1 §6.2 C2）
//
// hub 是自建节点，origin 常为 http://host:port（明文自托管），既有
// 「downloadUrl 必须是 https」硬闸会把 hub 资源全部拒掉。但放开明文等于
// 放弃防线——故引入**信任集**：studio 自身配置的 hubUrl 注册进本模块级集合，
// 只有落在信任 origin 之下（或 https）的地址才放行。信任集同时约束
// installPackage 的地址闸与 downloadFile 的流式下载闸——两段规则同源，
// 避免「安装放行但下载再拒」的规则漂移。
//
// 信任集是进程内集合，不落库：进程重启后 provider 初始化会重新注册当前配置
// 的 hubUrl；忘记接入 / 换址时经 unregister 撤销旧 origin（F2——不能单调只增，
// 否则旧 hub 的下载授权残留）。
// ────────────────────────────────────────────────────────────────────────────

/** 已注册的可信下载源（归一后的 origin 串） */
const trustedDownloadOrigins = new Set<string>();

/** origin 归一：去首尾空白 + 去尾斜杠（'http://h:1/' → 'http://h:1'） */
function normalizeTrustedOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * 注册可信下载源（hub origin）——studio 自身配置的 hubUrl 经此入口登记。
 * 非 http(s) 协议或 URL 解析失败 → 记 warn 并忽略（不静默信任垃圾值）。
 */
export function registerTrustedDownloadOrigin(origin: string): void {
  const normalized = normalizeTrustedOrigin(origin);
  if (normalized === '') return;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    logger.warn('注册可信下载源失败：origin 不是合法 URL', { origin: normalized });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger.warn('注册可信下载源失败：协议非 http(s)', { origin: normalized });
    return;
  }
  trustedDownloadOrigins.add(normalized);
}

/**
 * 撤销可信下载源（F2：忘记接入 / 换址时收回旧 hub origin 的下载授权）。
 * 与 register 同一归一逻辑——带尾斜杠的入参落在同一归一键上；未注册的
 * origin 幂等无操作。
 */
export function unregisterTrustedDownloadOrigin(origin: string): void {
  trustedDownloadOrigins.delete(normalizeTrustedOrigin(origin));
}

/**
 * 下载地址是否受信：https 恒放行（既有 marketplace 语义不变）；否则须落在
 * 某信任 origin 之下，且 origin 边界严格——其后必须是路径/查询/片段起始符
 * 或字符串结束，否则 'http://h:1' 会误放行 'http://h:1.evil.test/x'。
 */
export function isTrustedDownloadUrl(url: string): boolean {
  if (url.startsWith('https://')) return true;
  for (const origin of trustedDownloadOrigins) {
    if (!url.startsWith(origin)) continue;
    const rest = url.slice(origin.length);
    if (rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#')) {
      return true;
    }
  }
  return false;
}

/** 测试用：清空可信下载源信任集（隔离用例间信任状态） */
export function __resetTrustedDownloadOriginsForTest(): void {
  trustedDownloadOrigins.clear();
}

/** 已安装包记录（camelCase，与 renderer 端类型约定一致） */
export interface InstalledPackage {
  id: string;
  itemId: string;
  itemType: string;
  slug: string;
  version: string;
  cachePath: string;
  installedAt: string;
}

/**
 * 安装阶段进度监听（M2.2 P2-7——hub 补装链消费，worker 侧大包可见性）。
 *   - 'downloading'：下载起拍一次（无字节）；随后每个流分片一拍（info 携带
 *     receivedBytes 累计值 + totalBytes=Content-Length，响应头缺失时 null）
 *   - 'extracting'：校验通过、解压开始前一次
 * 市场直装链不传此参——行为零变化（可选缝，非新下载链）。
 */
export type InstallPhaseListener = (
  stage: 'downloading' | 'extracting',
  info?: { receivedBytes?: number; totalBytes?: number | null },
) => void;

/** 安装一个 marketplace 包（headers 经 downloadFile 透传——hub 链注入 Bearer 凭证） */
export async function installPackage(
  item: MarketplaceItem,
  _workspaceId?: string,
  headers?: Record<string, string>,
  onProgress?: InstallPhaseListener,
): Promise<{ cachePath: string }> {
  // S1 注入防线：slug/version 会被拼进路径与子进程参数，任何 shell 元字符
  // 都必须在首次使用前被拒绝（checksum 校验不缓解路径注入）。
  if (!isValidSlug(item.slug)) {
    throw new Error(
      `非法 slug: "${item.slug}"（仅允许小写字母/数字开头，后续小写字母/数字/连字符/点/下划线）`,
    );
  }
  if (!isValidVersion(item.version)) {
    throw new Error(
      `非法 version: "${item.version}"（仅允许数字/字母/点/加号/减号）`,
    );
  }
  if (item.type === 'plugin') {
    // plugin 必经 plugin 域注册链（PluginRecord 落库 + 组件激活，hub 安装链的
    // plugin 分支委派 plugin/hub-install）——缓存目录链装不出可用插件，fail-fast
    throw new Error('plugin 包不支持 marketplace 缓存链安装（须走插件注册链）');
  }
  if (item.downloadUrl !== '' && !isTrustedDownloadUrl(item.downloadUrl)) {
    throw new Error(
      `downloadUrl 必须是 https 地址或已注册的可信源: ${item.downloadUrl}`,
    );
  }

  const cacheBase = path.join(resolveUserDataDir(), 'cache', `${item.type}s`);
  const cachePath = path.join(cacheBase, item.slug, item.version);

  // 已安装则幂等跳过
  if (fs.existsSync(path.join(cachePath, '.installed'))) {
    logger.info('包已安装，跳过', { slug: item.slug });
    return { cachePath };
  }

  fs.mkdirSync(cachePath, { recursive: true });

  if (item.downloadUrl) {
    // 远程包：下载 → 校验 → 解压（阶段拍经 onProgress 上报——P2-7 hub 链消费）
    const archivePath = path.join(cachePath, 'package.tar.gz');
    onProgress?.('downloading');
    await downloadFile(
      item.downloadUrl,
      archivePath,
      undefined,
      headers,
      onProgress
        ? (receivedBytes, totalBytes) => onProgress('downloading', { receivedBytes, totalBytes })
        : undefined,
    );

    if (item.checksum) {
      const actualChecksum = await computeChecksum(archivePath);
      if (actualChecksum !== item.checksum) {
        fs.rmSync(cachePath, { recursive: true, force: true });
        throw new Error(`Checksum 不匹配: 期望 ${item.checksum}, 实际 ${actualChecksum}`);
      }
    }

    onProgress?.('extracting');
    await extractTarGz(archivePath, cachePath);
    fs.unlinkSync(archivePath);
  } else {
    // builtin 内联项无下载/解压物理阶段——不拍进度（hub 目录项恒有 downloadUrl）
    createInlinePackage(item, cachePath);
  }

  // 标记已安装
  fs.writeFileSync(path.join(cachePath, '.installed'), new Date().toISOString());

  // 注册到 SQLite——按 item_id + item_type 真 upsert（D6：hub 更新语义 = 同 slug
  // 重装新版本，裸 INSERT（随机 id 主键，OR REPLACE 永不冲突）会在旧版本行旁再
  // 插一行 → 幽灵账兜底行翻倍。先清同键旧账与旧版本缓存目录再插（同款纪律见
  // hub-install plugin 分支；T15a-F1：item_id 非跨类型唯一键，DELETE 必须带
  // item_type，防误删同 slug 另一类型的账）。cache_path 相同（同版本路径重建）
  // 时跳过 rm——目录里是刚解压完的新内容。
  const db = getDb();
  const staleRows = db
    .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ? AND item_type = ?')
    .all(item.id, item.type) as Array<{ cache_path: string }>;
  for (const row of staleRows) {
    if (row.cache_path !== cachePath) {
      fs.rmSync(row.cache_path, { recursive: true, force: true });
    }
  }
  db.prepare('DELETE FROM installed_packages WHERE item_id = ? AND item_type = ?').run(
    item.id,
    item.type,
  );
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, item.id, item.type, item.slug, item.version, cachePath, item.checksum);

  logger.info('包已安装', { slug: item.slug, type: item.type, cachePath });

  // 安装成功后按 type 自动注册到对应定义表。注册失败不阻断安装（仅告警）。
  try {
    registerInstalledPackage(item, cachePath);
  } catch (err) {
    logger.warn('自动注册失败，包已安装但未注册到定义表', {
      slug: item.slug,
      type: item.type,
      error: (err as Error).message,
    });
  }

  return { cachePath };
}

/**
 * 按 type 把已安装包注册到对应定义表，使其可在平台内被引用：
 *   - agent：解析 cachePath/manifest.yaml → saveAgentDefinition（source='marketplace'）
 *   - skill：写 skill_definitions 表（slug + cachePath）
 *   - mcp：读 cachePath/package.json → registerMcpDefinition（command='npx'）
 * 任何分支抛错由调用方捕获（不阻断安装）。
 */
/** marketplace manifest 的 defaultTools 钳制白名单——与 P2P 导入（resource-transfer）一致 */
const SAFE_TOOL_REFS: ReadonlySet<string> = new Set<string>(SAFE_MINIMUM_TOOLS);

/**
 * 安全钳制（S3）：marketplace manifest 属第三方内容，defaultTools 不可信——
 * bash / git 写操作 / web 等越权工具就地剔除，仅保留安全最小集；
 * 用户安装后可在工作空间能力面板（L2）显式重新开启。
 */
function clampImportedDefaultTools(tools: ToolRef[], slug: string): void {
  const kept = tools.filter((t) => t.kind === 'builtin' && SAFE_TOOL_REFS.has(t.ref));
  if (kept.length !== tools.length) {
    logger.warn('Marketplace agent 的 defaultTools 含越权工具，已按安全最小集钳制', {
      slug,
      dropped: tools.length - kept.length,
    });
  }
  tools.splice(0, tools.length, ...kept);
}

function registerInstalledPackage(item: MarketplaceItem, cachePath: string): void {
  if (item.type === 'agent') {
    const manifestPath = path.join(cachePath, 'manifest.yaml');
    const yamlContent = fs.readFileSync(manifestPath, 'utf-8');
    const def = parseAgentManifest(yamlContent);
    def.source = 'marketplace';
    clampImportedDefaultTools(def.defaultTools, item.slug);
    // P2-4（M2.2 Task 4 / M2 D3）：def id 复用限定安装链血缘（marketplace 目录 /
    // hub 记账 / catalog 自愈同落 source='marketplace'，互为更新语义）。不得按裸
    // slug 匹配——同 slug 异源行（builtin / custom / plugin）会被第三方包覆写
    // （M2 验收 D3：hub 安装同 slug 静默替换用户 custom 定义并级联清成员）。
    // 异源行在场时安装另起新行，异源行与其成员引用原样保留。
    const existing = listAgentDefinitions().find(
      (d) => d.slug === def.slug && d.source === 'marketplace',
    );
    if (existing) def.id = existing.id;
    saveAgentDefinition(def);
    logger.info('Marketplace agent 已注册到定义表', { slug: item.slug, id: def.id, reused: Boolean(existing) });
  } else if (item.type === 'skill') {
    const id = crypto.randomUUID();
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO skill_definitions
       (id, name, slug, version, description, allowed_tools, cache_path, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      item.name,
      item.slug,
      item.version,
      item.description,
      '[]',
      cachePath,
      JSON.stringify(item.tags),
    );
    logger.info('Marketplace skill 已注册到定义表', { slug: item.slug, id });
  } else if (item.type === 'mcp') {
    const pkgPath = path.join(cachePath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      name: string;
      version: string;
    };
    // pkg.name 会被原样拼进 `npx <name>` 的 spawn args——注册前必须过 npm 包名
    // 白名单，防下载包里的恶意 package.json 二次注入。
    if (!isValidNpmPackageName(pkg.name)) {
      throw new Error(`MCP 包名 "${pkg.name}" 不符合 npm 包名规范，已拒绝注册`);
    }
    registerMcpDefinition({
      id: crypto.randomUUID(),
      name: pkg.name,
      version: pkg.version,
      command: 'npx',
      args: [pkg.name],
      source: 'marketplace',
    });
    logger.info('Marketplace mcp 已注册到定义表', { slug: item.slug, name: pkg.name });
  }
}

/**
 * 下载文件到本地（流式写盘 + 大小上限防护）。
 * 超过 maxBytes 时中断流、删除半成品文件并抛错——不依赖 Content-Length
 * （该头可伪造），以实际落盘字节数为准。
 *
 * headers（可选）：请求头透传通道——hub 下载端点要求 Bearer 鉴权（hub spec
 * §3.1 三个资源端点全部鉴权），hub 安装链经此注入 `Authorization: Bearer
 * <deviceToken>`；marketplace 公网下载不传，行为不变。
 *
 * onBytes（可选，P2-7）：每个流分片一拍（receivedBytes 为累计落盘字节；
 * totalBytes 取 Content-Length——可伪造故仅供参考展示，缺失时 null）。
 */
export async function downloadFile(
  url: string,
  dest: string,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
  headers?: Record<string, string>,
  onBytes?: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  if (!isTrustedDownloadUrl(url)) {
    throw new Error(`下载地址必须是 https 或已注册的可信源: ${url}`);
  }
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    // 401 人话提示：hub 资源端点全鉴权，凭证缺失/失效是用户可自诊的常见态
    const hint = response.status === 401 ? '（鉴权失败：hub 凭证缺失或已失效，请检查 hub 接入配置）' : '';
    throw new Error(`下载失败: HTTP ${response.status}${hint}`);
  }
  // Content-Length 可得则透传（展示用总量）；缺失/非数字（可伪造头）按 null
  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  // Readable.fromWeb 将 web ReadableStream 转 Node Readable，类型干净无需 as
  const source = Readable.fromWeb(response.body);
  const writeStream = fs.createWriteStream(dest);
  let total = 0;
  try {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        throw new Error(`下载内容超过大小上限（${maxBytes} 字节），已中止: ${url}`);
      }
      if (!writeStream.write(buf)) {
        await once(writeStream, 'drain');
      }
      onBytes?.(total, totalBytes);
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    writeStream.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
}

/** 计算文件 sha256 hex 校验和 */
async function computeChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * 解压 tar.gz 并做符号链接扫描。
 * execFile 数组参数形式：不经 shell——即使路径里混入元字符也不可能被解释执行。
 * followSymbolicLinks:false + onlyFiles:false 让 fast-glob 原样列出链接条目
 * （默认配置会跟随遍历 symlink 指向的外部目录），lstat 判定后整包拒绝。
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir]);
  } catch (err) {
    throw new Error(`解压失败: ${(err as Error).message}`);
  }

  const entries = await fastGlob('**/*', {
    cwd: destDir,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
  });
  for (const rel of entries) {
    if (fs.lstatSync(path.join(destDir, rel)).isSymbolicLink()) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error(`归档包含符号链接成员，已拒绝安装并清理: ${rel}`);
    }
  }
}

/**
 * 内联包：无 downloadUrl 的 builtin item，从 catalog 元数据就地生成文件。
 * agent → manifest.yaml（js-yaml dump，保证可被 parseAgentManifest 解析）；
 * skill → SKILL.md（front matter + 正文）；mcp → package.json stub。
 */
function createInlinePackage(item: MarketplaceItem, cachePath: string): void {
  if (item.type === 'agent') {
    const manifest = {
      apiVersion: 'v1',
      kind: 'AgentDefinition',
      metadata: {
        name: item.name,
        slug: item.slug,
        version: item.version,
        description: item.description,
        iconEmoji: item.iconEmoji,
      },
      spec: {
        type: 'standalone',
        runtime: 'declarative',
        declarative: {
          systemPrompt: item.readme,
          model: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        },
        // builtin agent 安装后等价于 builtin def：默认必须含全部 24 工具
        // （与 v1.5 builtin YAML + Migration v16 同步策略一致），否则 def.defaultTools 落库为空。
        defaultTools: ALL_BUILTIN_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
      },
    };
    fs.writeFileSync(path.join(cachePath, 'manifest.yaml'), yamlDump(manifest));
  } else if (item.type === 'skill') {
    const skillMd = `---
name: ${item.slug}
description: ${item.description}
version: ${item.version}
---

${item.readme}
`;
    fs.writeFileSync(path.join(cachePath, 'SKILL.md'), skillMd);
  } else if (item.type === 'mcp') {
    const pkg = {
      name: item.slug,
      version: item.version,
      description: item.description,
    };
    fs.writeFileSync(path.join(cachePath, 'package.json'), JSON.stringify(pkg, null, 2));
  }
}

/** 列出全部已安装包（最新优先） */
export function listInstalled(): InstalledPackage[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM installed_packages ORDER BY installed_at DESC')
    .all() as Array<{
    id: string;
    item_id: string;
    item_type: string;
    slug: string;
    version: string;
    cache_path: string;
    installed_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemType: r.item_type,
    slug: r.slug,
    version: r.version,
    cachePath: r.cache_path,
    installedAt: r.installed_at,
  }));
}

/**
 * 卸载包：删缓存目录 + 删 DB 记录。
 * 类型过滤（T15a-F1）：item_id 不是跨类型唯一键（hub 记账 `hub:{slug}` 下
 * 同 slug 的 agent 与插件共用 item_id）——DELETE 与 rm cache_path 均须按
 * item_id + itemType 双键圈定，防卸载一方误删另一方的记账与缓存。
 */
export function uninstallPackage(itemId: string, itemType: string): void {
  const db = getDb();
  const rows = db
    .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ? AND item_type = ?')
    .all(itemId, itemType) as Array<{ cache_path: string }>;
  if (rows.length === 0) return;
  for (const row of rows) {
    fs.rmSync(row.cache_path, { recursive: true, force: true });
  }
  db.prepare('DELETE FROM installed_packages WHERE item_id = ? AND item_type = ?').run(
    itemId,
    itemType,
  );
  logger.info('包已卸载', { itemId, itemType });
}
