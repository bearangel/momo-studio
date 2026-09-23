// electron/src/main/resource/hub-install.ts
//
// hub MCP 安装/卸载与已装映射（spec §4.3）。
// Smithery：POST install-config 拿 stdio 命令（npx）→ S1 校验 → 注册。
// 记账走 installed_packages（item_id = `${source}:${slug}`），与 marketplace 同表
// 不同前缀，卸载互不误伤。
// 魔搭 remote 安装轨已于 P2.1 移除（registry 100% hosted 后放弃）；P3 若公开
// API 落地再评估。
//
// S1 注入防线（Task 2/4 审查传递）：slug 只进 encodeURIComponent 拼的 URL 与 DB 列，
// 禁止直接用作文件路径/本地标识（smithery 条目的 S1 只校验过 namespace 段——
// 完整 qualifiedName 含 @ 与 /，过不了 SLUG_PATTERN，故不在此复用该校验）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { registerMcpDefinition, listRegistered, deleteRegistered } from '../mcp/host-manager';
import { buildResourceId, type ResourceItem, type ResourceType } from './types';

const SMITHERY_BASE = 'https://registry.smithery.ai';

/** installed_packages 记账（item_id = `${source}:${slug}`，重复安装只留一行） */
function recordInstall(itemId: string, slug: string): void {
  const db = getDb();
  // 表 PK 是随机 id——INSERT OR REPLACE 在此永不冲突，挡不住 item_id 重复行。
  // 故先按 item_id 清旧账再插，保证幂等（brief 测试语义：重复安装只留一行）。
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(itemId);
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, 'mcp', ?, '1.0.0', '', '')`,
  ).run(randomUUID(), itemId, slug);
}

/** Smithery stdio 安装：install-config → 校验 → 注册 + 记账 */
export async function installSmitheryMcp(slug: string): Promise<void> {
  const res = await fetch(`${SMITHERY_BASE}/servers/${encodeURIComponent(slug)}/install-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: {} }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Smithery install-config 失败：HTTP ${res.status}`);
  const cfg = (await res.json()) as { command?: string; args?: string[]; env?: Record<string, string> };
  // S1：command 白名单（注册表响应不可信，只放行已知 runtime 启动器）
  if (!cfg.command || !/^(npx|node|uvx|uv|python|python3)$/.test(cfg.command)) {
    throw new Error(`install-config 返回非法 command（拒绝）：${String(cfg.command)}`);
  }
  // S1：args 过滤含双引号的项（防 shell 元字符注入到启动参数）
  const args = (cfg.args ?? []).filter((a) => typeof a === 'string' && !a.includes('"'));
  registerMcpDefinition({
    id: randomUUID(), name: slug, version: '1.0.0',
    command: cfg.command, args, env: cfg.env, source: 'smithery',
  });
  recordInstall(`smithery:${slug}`, slug);
  logger.info('Smithery MCP 已安装', { slug });
}

/** mcp_definitions 中 hub 来源行 → ResourceItem（installed=true / removable=true） */
export function listHubInstalledResources(type?: ResourceType): ResourceItem[] {
  return listRegistered()
    .filter((m) => m.source === 'smithery' && (!type || type === 'mcp'))
    .map((m) => ({
      id: buildResourceId(m.source, 'mcp', m.name),
      type: 'mcp' as const,
      source: m.source,
      slug: m.name,
      name: m.name.replace(/^@/, ''),
      description: m.transport === 'streamable_http' ? `远程 MCP（${m.url ?? ''}）` : `Smithery MCP（${m.command}）`,
      version: m.version,
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: m.installedAt },
    }));
}

/** hub 卸载：删 mcp_definitions 行 + installed_packages 记账（幂等） */
export function uninstallHubMcp(source: 'smithery', slug: string): void {
  deleteRegisteredHubSafe(slug);
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`${source}:${slug}`);
}

/** hub 行允许直接删（deleteRegistered 对 marketplace 有保护，hub 无此约束） */
function deleteRegisteredHubSafe(name: string): void {
  // deleteRegistered 仅拦截 source='marketplace'，hub 行直接走删除
  deleteRegistered(name);
}
