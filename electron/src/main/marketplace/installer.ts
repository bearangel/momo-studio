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

/** 安装一个 marketplace 包 */
export async function installPackage(
  item: MarketplaceItem,
  _workspaceId?: string,
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
  if (item.downloadUrl !== '' && !item.downloadUrl.startsWith('https://')) {
    throw new Error(`downloadUrl 必须是 https 地址: ${item.downloadUrl}`);
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
    // 远程包：下载 → 校验 → 解压
    const archivePath = path.join(cachePath, 'package.tar.gz');
    await downloadFile(item.downloadUrl, archivePath);

    if (item.checksum) {
      const actualChecksum = await computeChecksum(archivePath);
      if (actualChecksum !== item.checksum) {
        fs.rmSync(cachePath, { recursive: true, force: true });
        throw new Error(`Checksum 不匹配: 期望 ${item.checksum}, 实际 ${actualChecksum}`);
      }
    }

    await extractTarGz(archivePath, cachePath);
    fs.unlinkSync(archivePath);
  } else {
    // builtin 内联项：无下载，就地生成
    createInlinePackage(item, cachePath);
  }

  // 标记已安装
  fs.writeFileSync(path.join(cachePath, '.installed'), new Date().toISOString());

  // 注册到 SQLite
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
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
    const existing = listAgentDefinitions().find((d) => d.slug === def.slug);
    if (existing) def.id = existing.id;
    saveAgentDefinition(def);
    logger.info('Marketplace agent 已注册到定义表', { slug: item.slug, id: def.id });
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
 */
export async function downloadFile(
  url: string,
  dest: string,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error(`下载地址必须是 https: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }
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

/** 卸载包：删缓存目录 + 删 DB 记录 */
export function uninstallPackage(itemId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ?')
    .get(itemId) as { cache_path: string } | undefined;
  if (!row) return;
  fs.rmSync(row.cache_path, { recursive: true, force: true });
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(itemId);
  logger.info('包已卸载', { itemId });
}
