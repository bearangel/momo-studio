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
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { dump as yamlDump } from 'js-yaml';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { resolveUserDataDir } from '../paths';
import { parseAgentManifest } from '../agent/manifest-parser';
import { saveAgentDefinition, listAgentDefinitions } from '../agent/crud';
import { registerMcpDefinition } from '../mcp/host-manager';
import type { MarketplaceItem } from './types';

const execAsync = promisify(exec);

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
function registerInstalledPackage(item: MarketplaceItem, cachePath: string): void {
  if (item.type === 'agent') {
    const manifestPath = path.join(cachePath, 'manifest.yaml');
    const yamlContent = fs.readFileSync(manifestPath, 'utf-8');
    const def = parseAgentManifest(yamlContent);
    def.source = 'marketplace';
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

/** 下载文件到本地（流式写盘） */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }
  // Readable.fromWeb 将 web ReadableStream 转 Node Readable，类型干净无需 as
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
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

/** 解压 tar.gz（用系统 tar 命令，简单可靠） */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  try {
    await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`);
  } catch (err) {
    throw new Error(`解压失败: ${(err as Error).message}`);
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
        defaultTools: [] as Array<Record<string, unknown>>,
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
