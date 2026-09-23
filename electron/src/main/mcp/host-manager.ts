// electron/src/main/mcp/host-manager.ts
//
// workspace 级 MCP 进程池。包装 T4 的 McpClient（stdio）与 HttpMcpClient
// （streamable_http 远程），让同一 workspace 内的多个 agent 共用同一组 MCP
// 客户端实例，避免重复 spawn / 握手带来的资源浪费与开销。
//
// 设计要点：
//   - 池的 key = `${workspaceId}:${mcpName}`，天然隔离不同 workspace。
//   - getOrStartMcp 命中已连接的实例则直接复用；否则按 config.transport 分流
//     创建客户端（stdio 新起子进程并完成 initialize 握手；remote 发 HTTP 握手）。
//   - stopAllMcpForWorkspace 用于 workspace 销毁时统一回收该 workspace 的全部 MCP 实例。
//   - MCP server 定义持久化在 SQLite（mcp_definitions 表），通过 name 唯一索引读取。

import { McpClient } from './client';
import { HttpMcpClient } from './http-client';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, RegisteredMcp } from './types';

/** mcp_definitions 表的一行原始结构（getMcpConfig / listRegistered 读取时做类型断言用） */
interface McpDefinitionRow {
  id: string;
  name: string;
  version: string;
  transport: string;
  command: string;
  args: string;
  env: string;
  url: string | null;
  headers_json: string | null;
  cwd: string | null;
  source: string;
  installed_at: string;
}

/** transport 合法值集合——白名单外的行值（历史脏数据/未知形态）一律回退 'stdio' */
const TRANSPORT_VALUES: ReadonlySet<string> = new Set(['stdio', 'streamable_http']);

function normalizeTransport(raw: string): 'stdio' | 'streamable_http' {
  return TRANSPORT_VALUES.has(raw) ? (raw as 'stdio' | 'streamable_http') : 'stdio';
}

/** headers_json 列解析：NULL/空串 → undefined；坏 JSON 或合法 JSON 但非
 *  plain object（数组/字符串/数字等）→ warn + undefined（脏数据不炸读取链路）。
 *  warn 不带原始值——该列可能含 Authorization token，不落日志。 */
function parseHeadersJson(
  raw: string | null,
  name: string,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('mcp_definitions.headers_json 非 JSON object，已忽略该列', { name });
      return undefined;
    }
    return parsed as Record<string, string>;
  } catch {
    logger.warn('mcp_definitions.headers_json 非法 JSON，已忽略该列', { name });
    return undefined;
  }
}

/** mcp_definitions 行 → RegisteredMcp（getMcpConfig / listRegistered 共用映射，
 *  两处读回的二态语义保持一致）。 */
function rowToRegistered(row: McpDefinitionRow): RegisteredMcp {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    transport: normalizeTransport(row.transport),
    command: row.command,
    args: JSON.parse(row.args) as string[],
    env: (JSON.parse(row.env) as Record<string, string>) ?? {},
    url: row.url ?? undefined,
    headers: parseHeadersJson(row.headers_json, row.name),
    cwd: row.cwd ?? undefined,
    source: row.source as RegisteredMcp['source'],
    installedAt: row.installed_at,
  };
}

/** 池内客户端联合类型。两种传输同表面（isConnected / connect / listTools /
 *  callTool / disconnect），仅 callTool 返回形态不同：stdio 返回 McpToolResult
 *  （由 callMcpTool 统一提取文本），remote 已返回提取后的 text 字符串。 */
type PooledMcpClient = McpClient | HttpMcpClient;

// 按 workspace 分组的 MCP 客户端池。
// 存 Promise 而非客户端实例：并发调用 getOrStartMcp 时共享同一个
// in-flight Promise，避免重复 spawn 同一个 MCP server。
// key = `${workspaceId}:${mcpName}`
const pool = new Map<string, Promise<PooledMcpClient>>();

function poolKey(workspaceId: string, mcpName: string): string {
  return `${workspaceId}:${mcpName}`;
}

/**
 * 启动或复用某 workspace 内指定 MCP server 的客户端实例。
 * 同一 workspace + 同一 mcpName 只持有一个客户端（进程/连接复用）。
 * 按 config.transport 分流：stdio（缺省）→ McpClient 子进程；
 * streamable_http → HttpMcpClient 远程连接。
 *
 * 并发防护：pool 存的是 in-flight Promise。多个调用同时到达时，第一个写入 Promise
 * 后其余调用 await 同一 Promise，只 spawn 一次。若已存在但已断开（子进程退出）或上次
 * 启动失败，则重新建立连接。
 */
export async function getOrStartMcp(
  workspaceId: string,
  config: McpServerConfig,
): Promise<PooledMcpClient> {
  const key = poolKey(workspaceId, config.name);
  const existing = pool.get(key);
  if (existing) {
    try {
      const client = await existing;
      if (client.isConnected) return client;
    } catch {
      // 上次启动失败，落到下方重新启动
    }
  }
  // in-flight Promise：并发调用共享，只 spawn 一次
  const promise = (async (): Promise<PooledMcpClient> => {
    const client =
      (config.transport ?? 'stdio') === 'streamable_http'
        ? new HttpMcpClient(config)
        : new McpClient(config);
    await client.connect();
    logger.info('MCP server 已启动', { workspaceId, name: config.name });
    return client;
  })();
  pool.set(key, promise);
  return promise;
}

/** 列出某 workspace 内已启动 MCP server 暴露的工具。未启动会抛错。 */
export async function listMcpTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]> {
  const key = poolKey(workspaceId, mcpName);
  const promise = pool.get(key);
  if (!promise) throw new Error(`MCP ${mcpName} 未启动`);
  const client = await promise;
  if (!client.isConnected) throw new Error(`MCP ${mcpName} 未启动`);
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
  const promise = pool.get(key);
  if (!promise) throw new Error(`MCP ${mcpName} 未启动`);
  const client = await promise;
  if (!client.isConnected) throw new Error(`MCP ${mcpName} 未启动`);
  const result = await client.callTool(toolName, args);
  // 远程客户端已返回提取后的文本；stdio 客户端返回 McpToolResult，在此统一提取
  if (typeof result === 'string') return result;
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** 停止并移除某 workspace 内的指定 MCP server 实例。未启动则静默跳过。 */
export async function stopMcp(workspaceId: string, mcpName: string): Promise<void> {
  const key = poolKey(workspaceId, mcpName);
  const promise = pool.get(key);
  pool.delete(key);
  if (!promise) return;
  // 先从池中删除，再 await disconnect；启动失败/已退出的 promise await 会抛错，忽略
  try {
    const client = await promise;
    await client.disconnect();
  } catch {
    // 启动失败或进程已退出，无需 disconnect
  }
}

/**
 * 停止某 workspace 名下的全部 MCP server 实例。
 * workspace 销毁时调用，确保子进程不会泄漏。
 * 并发 disconnect 各实例以加快回收；单实例失败不影响其余。
 */
export async function stopAllMcpForWorkspace(workspaceId: string): Promise<void> {
  const toStop: string[] = [];
  for (const key of pool.keys()) {
    if (key.startsWith(`${workspaceId}:`)) toStop.push(key);
  }
  // 先收集并删除全部 key，再并发 await+disconnect（避免边遍历边改 Map）
  const promises = toStop.map((key) => {
    const p = pool.get(key);
    pool.delete(key);
    return p;
  });
  await Promise.all(
    promises.map(async (p) => {
      if (!p) return;
      try {
        const client = await p;
        await client.disconnect();
      } catch {
        // 启动失败或进程已退出，忽略
      }
    }),
  );
}

/** 从 SQLite 读取已注册的 MCP server 定义（按 name 查找）。不存在返回 null。 */
export function getMcpConfig(mcpName: string): McpServerConfig | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, name, version, transport, command, args, env, url, headers_json, cwd, source, installed_at FROM mcp_definitions WHERE name = ?',
    )
    .get(mcpName) as McpDefinitionRow | undefined;
  if (!row) return null;
  return rowToRegistered(row);
}

/**
 * 注册（或覆盖）一条 MCP server 定义到 SQLite。二态：
 *   - stdio（缺省）：command/args/env 启动子进程
 *   - streamable_http：url（强制 https）+ headers 远程连接，command 写空串占位
 *     （DB 列 NOT NULL，migration 038 不重建表），url/headers_json 仅 remote 形态落值。
 * name 唯一冲突时整体替换。source 缺省按 'marketplace' 写入（与 DB 列默认值一致），
 * installed_at 由 DB 默认值填充。
 */
export function registerMcpDefinition(config: McpServerConfig): void {
  const transport = config.transport ?? 'stdio';
  if (transport === 'streamable_http' && !config.url?.startsWith('https://')) {
    throw new Error(`远程 MCP ${config.name} 注册失败：url 必须是 https 地址`);
  }
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mcp_definitions
       (id, name, version, transport, command, args, env, source, url, headers_json, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    config.id,
    config.name,
    config.version,
    transport,
    transport === 'streamable_http' && !config.command ? '' : config.command,
    JSON.stringify(config.args),
    JSON.stringify(config.env ?? {}),
    config.source ?? 'marketplace',
    transport === 'streamable_http' ? (config.url ?? null) : null,
    transport === 'streamable_http' ? JSON.stringify(config.headers ?? {}) : null,
    config.cwd ?? null,
  );
  logger.info('MCP 定义已注册', {
    name: config.name,
    transport,
    source: config.source ?? 'marketplace',
  });
}

/**
 * v1.6：列出所有已注册 MCP（含 source 区分），按 installed_at 倒序（最新优先）。
 * DB 列 source / installed_at / transport 均为 NOT NULL DEFAULT，故返回项这三个字段必填。
 */
export function listRegistered(): RegisteredMcp[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, name, version, transport, command, args, env, url, headers_json, cwd, source, installed_at FROM mcp_definitions ORDER BY installed_at DESC',
    )
    .all() as McpDefinitionRow[];
  return rows.map(rowToRegistered);
}

/**
 * v1.6：删除已注册 MCP（按 name）。marketplace 装的不可删——提示用户走卸载按钮
 * （卸载会同步清理缓存目录与 installed_packages 记录，单纯删 mcp_definitions 行会留下孤儿）。
 * 不存在的 name 静默跳过（幂等）。
 */
export function deleteRegistered(name: string): void {
  const db = getDb();
  const row = db.prepare('SELECT source FROM mcp_definitions WHERE name = ?').get(name) as
    | { source: string }
    | undefined;
  if (!row) return;
  if (row.source === 'marketplace') {
    throw new Error(
      `MCP ${name} 是 marketplace 安装的，请用卸载按钮移除（卸载会同步清理缓存目录）`,
    );
  }
  db.prepare('DELETE FROM mcp_definitions WHERE name = ?').run(name);
  logger.info('MCP 定义已删除', { name });
}
