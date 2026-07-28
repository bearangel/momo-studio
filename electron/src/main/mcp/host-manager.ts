// electron/src/main/mcp/host-manager.ts
//
// workspace 级 MCP 进程池。包装 T4 的 McpClient，让同一 workspace 内的多个
// agent 共用同一组 MCP server 子进程，避免重复 spawn 带来的资源浪费与协议握手开销。
//
// 设计要点：
//   - 池的 key = `${workspaceId}:${mcpName}`，天然隔离不同 workspace。
//   - getOrStartMcp 命中已连接的实例则直接复用，否则新起子进程并完成 initialize 握手。
//   - stopAllMcpForWorkspace 用于 workspace 销毁时统一回收该 workspace 的全部 MCP 进程。
//   - MCP server 定义持久化在 SQLite（mcp_definitions 表），通过 name 唯一索引读取。

import { McpClient } from './client';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo } from './types';

/** mcp_definitions 表的一行原始结构（getMcpConfig 读取时做类型断言用） */
interface McpDefinitionRow {
  id: string;
  name: string;
  version: string;
  transport: string;
  command: string;
  args: string;
  env: string;
}

// 按 workspace 分组的 MCP 客户端池
// key = `${workspaceId}:${mcpName}`
const pool = new Map<string, McpClient>();

function poolKey(workspaceId: string, mcpName: string): string {
  return `${workspaceId}:${mcpName}`;
}

/**
 * 启动或复用某 workspace 内指定 MCP server 的客户端实例。
 * 同一 workspace + 同一 mcpName 只持有一个 McpClient（进程复用）；
 * 若已存在但已断开（子进程退出），则重新建立连接。
 */
export async function getOrStartMcp(
  workspaceId: string,
  config: McpServerConfig,
): Promise<McpClient> {
  const key = poolKey(workspaceId, config.name);
  const existing = pool.get(key);
  if (existing && existing.isConnected) return existing;

  const client = new McpClient(config);
  await client.connect();
  pool.set(key, client);
  logger.info('MCP server 已启动', { workspaceId, name: config.name });
  return client;
}

/** 列出某 workspace 内已启动 MCP server 暴露的工具。未启动会抛错。 */
export async function listMcpTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (!client || !client.isConnected) {
    throw new Error(`MCP ${mcpName} 未启动`);
  }
  return client.listTools();
}

/**
 * 调用某 workspace 内已启动 MCP server 的指定工具。
 * 返回值只提取 text 类型内容并用 \n 拼接（上层 agent 只关心文本输出），
 * image/resource 类型由 MCP server 各自定义，暂不在文本流里透传。
 */
export async function callMcpTool(
  workspaceId: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (!client || !client.isConnected) {
    throw new Error(`MCP ${mcpName} 未启动`);
  }
  const result = await client.callTool(toolName, args);
  // 提取文本内容
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** 停止并移除某 workspace 内的指定 MCP server 实例。未启动则静默跳过。 */
export async function stopMcp(workspaceId: string, mcpName: string): Promise<void> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (client) {
    await client.disconnect();
    pool.delete(key);
  }
}

/**
 * 停止某 workspace 名下的全部 MCP server 实例。
 * workspace 销毁时调用，确保子进程不会泄漏。
 * 先收集 key 再统一删除，避免边遍历边修改 Map。
 */
export async function stopAllMcpForWorkspace(workspaceId: string): Promise<void> {
  const toStop: string[] = [];
  for (const key of pool.keys()) {
    if (key.startsWith(`${workspaceId}:`)) {
      toStop.push(key);
    }
  }
  for (const key of toStop) {
    const client = pool.get(key);
    if (client) await client.disconnect();
    pool.delete(key);
  }
}

/** 从 SQLite 读取已注册的 MCP server 定义（按 name 查找）。不存在返回 null。 */
export function getMcpConfig(mcpName: string): McpServerConfig | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, name, version, transport, command, args, env FROM mcp_definitions WHERE name = ?')
    .get(mcpName) as McpDefinitionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    command: row.command,
    args: JSON.parse(row.args) as string[],
    env: (JSON.parse(row.env) as Record<string, string>) ?? {},
  };
}

/**
 * 注册（或覆盖）一条 MCP server 定义到 SQLite。
 * transport 固定为 stdio（当前仅支持 stdio 传输），name 唯一冲突时整体替换。
 */
export function registerMcpDefinition(config: McpServerConfig): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mcp_definitions (id, name, version, transport, command, args, env)
     VALUES (?, ?, ?, 'stdio', ?, ?, ?)`,
  ).run(
    config.id,
    config.name,
    config.version,
    config.command,
    JSON.stringify(config.args),
    JSON.stringify(config.env ?? {}),
  );
  logger.info('MCP 定义已注册', { name: config.name });
}
