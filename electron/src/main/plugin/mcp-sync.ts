// electron/src/main/plugin/mcp-sync.ts
//
// 插件 MCP 激活（spec §10 P2）：components.mcp（mcp.json）→ mcp_definitions
// 注册（source='plugin'，幂等）。坏条目（command 不合法 / 形状漂移）逐项跳过
// 带 warn。卸载级联：删该插件 source='plugin' 的定义 + 清 agent 引用
// （removeMcpRefsFromAgents 同构语义）。
import fs from 'node:fs';
import path from 'node:path';
import { registerMcpDefinition } from '../mcp/host-manager';
import { isValidNpmPackageName } from '../marketplace/types';
import { removeMcpRefsFromAgents } from '../agent/crud';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { resolvePluginRoot } from './assembly';
import type { PluginRecord } from './types';

interface McpEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  transport?: unknown;
  headers?: unknown;
  cwd?: unknown;
}

interface McpFileShape {
  servers?: Record<string, McpEntry>;
}

/** 组 McpServerConfig 的宽松输入（registerMcpDefinition 内做远程白名单等校验） */
function toConfig(
  pluginId: string,
  root: string,
  name: string,
  entry: McpEntry,
): {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: 'stdio' | 'streamable_http';
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  source?: 'plugin';
  pluginId?: string;
} | null {
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const transport =
    entry.transport === 'streamable_http' ? 'streamable_http' : ('stdio' as const);
  if (transport === 'stdio') {
    // npx command 注入防线（P1 marketplace 同款）：非法 npm 名整条拒绝
    if (!command || !isValidNpmPackageName(command.replace(/^npx\s+/, ''))) return null;
  } else if (typeof entry.url !== 'string') {
    return null;
  }
  return {
    id: `plugin-${pluginId}-${name}`,
    name,
    version: '0.0.0',
    command: command ?? '',
    args: Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === 'string')
      : [],
    env:
      typeof entry.env === 'object' && entry.env !== null
        ? (Object.fromEntries(
            Object.entries(entry.env).filter(
              (kv): kv is [string, string] => typeof kv[1] === 'string',
            ),
          ) as Record<string, string>)
        : undefined,
    transport,
    url: typeof entry.url === 'string' ? entry.url : undefined,
    cwd: root,
    source: 'plugin',
    pluginId,
  };
}

/** 注册插件 MCP（幂等覆盖）。返回成功注册的 server 名列表 */
export function syncPluginMcps(rec: PluginRecord): string[] {
  const root = resolvePluginRoot(rec);
  if (root === null) return [];
  let manifest: { components?: { mcp?: string } };
  try {
    manifest = JSON.parse(rec.manifestJson) as { components?: { mcp?: string } };
  } catch {
    return [];
  }
  const mcpRel = manifest.components?.mcp;
  if (typeof mcpRel !== 'string') return [];
  let parsed: McpFileShape;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(root, mcpRel), 'utf-8')) as McpFileShape;
  } catch (err) {
    logger.warn('插件 mcp.json 读取失败（已跳过）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const registered: string[] = [];
  for (const [name, entry] of Object.entries(parsed.servers ?? {})) {
    const config = toConfig(rec.id, root, name, entry);
    if (config === null) {
      logger.warn('插件 MCP 条目不合法（已跳过）', { pluginId: rec.id, name });
      continue;
    }
    try {
      registerMcpDefinition(config);
      registered.push(name);
    } catch (err) {
      logger.warn('插件 MCP 注册失败（已跳过）', {
        pluginId: rec.id,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return registered;
}

/** 卸载级联：删本插件（plugin_id 归属）的 MCP 定义 + 清 agent 引用 */
export function removePluginMcps(pluginId: string): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT name FROM mcp_definitions WHERE plugin_id = ?`)
    .all(pluginId) as Array<{ name: string }>;
  for (const { name } of rows) {
    removeMcpRefsFromAgents(name);
    db.prepare(`DELETE FROM mcp_definitions WHERE name = ?`).run(name);
  }
}
