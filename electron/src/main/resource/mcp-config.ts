// electron/src/main/resource/mcp-config.ts
//
// P2.2 Task 4：已装远程 MCP 配置查看/编辑服务（spec §4.1/§4.2 契约形状、
// §5.1/§5.2 主进程逻辑）。
//   - getMcpConfigView：三级 schema 降级（§5.1）——库存 config_schema →
//     Smithery 详情实时拉取 + 顺手回写（下次离线可用，回写失败仅 warn）→
//     裸模式 bare=true；values 按 x-from 反解回显（query 字段从 url query
//     参数 decode、header 字段读 headers_json）
//   - updateRemoteMcpConfig：校验（存在 / streamable_http / https）→ 按
//     resolveSchema 分流（与 getMcpConfigView 判定一致）：schema 模式经
//     composeRemoteConfig（Task 2 单点）重组，裸模式 url + headers 整包
//     直写 → updateRemoteMcpDefinition（Task 3 专用 UPDATE，保 id/
//     installed_at）→ evictMcpByName 驱逐池连接（下回合 getOrStartMcp 用
//     新定义重建即生效）
// P2.2 Task 5 追加：listDanglingMcpRefs 悬空引用扫描（spec §4.3/§5.4）——
// agent 全量 defaultMcps 引用与已注册 MCP 名集比对，查无者按 refName 聚合
// agent 名单（UI DanglingRefsCard 数据源）。
// 类型 McpConfigView / McpConfigUpdateInput / DanglingMcpRef 在本文件定义并
// 导出，Task 6 做 renderer types.d.ts 镜像。

import { getDb } from '../storage/db';
import { logger } from '../logger';
import {
  evictMcpByName,
  getMcpConfig,
  listRegistered,
  updateMcpEntryDefinition,
  updateRemoteMcpDefinition,
} from '../mcp/host-manager';
import { listAgentDefinitions } from '../agent/crud';
import type { McpConfigSchema, McpEntryUpdateInput, RegisteredMcp } from '../mcp/types';
import { composeRemoteConfig, fetchSmitheryDetail } from './hub-install';
import { broadcastLocalResourceCatalog } from '../p2p/resource-share';

/** P2.5：全字段编辑入参（定义在 mcp/types.ts；renderer types.d.ts 同形镜像） */
export type { McpEntryUpdateInput };

/** resource:getMcpConfig 返回形状（spec §4.1，renderer types.d.ts 镜像源） */
export interface McpConfigView {
  name: string;
  transport: 'stdio' | 'streamable_http';
  /** 裸模式标志：无 schema 时 true，前端渲染 url 整条 + headers 键值行 */
  bare: boolean;
  /** schema 模式的字段元数据（bare=false 时必有；裸模式缺省） */
  schema?: McpConfigSchema;
  /** 各字段现值回显（schema 模式：header 字段取 headers、query 字段从 url
   *  query 参数按字段名 decode 反解；裸模式为空对象） */
  values: Record<string, string>;
  /** 远程端点整条（裸模式可编辑回显用） */
  url: string;
  /** 裸模式的现有 headers 键值（schema 模式为空对象） */
  headers: Record<string, string>;
}

/** resource:updateMcpConfig 入参形状（spec §4.2） */
export interface McpConfigUpdateInput {
  /** 须 https（与安装链同防线，主进程双防线拒绝） */
  url: string;
  /** schema 模式：字段级值（trim 后空串剔除——可选字段留空不下发） */
  config: Record<string, string>;
  /** 仅裸模式：整包 headers 覆盖 */
  headers?: Record<string, string>;
  /** 编辑期间拉到的新 schema 顺手落库 */
  schema?: McpConfigSchema;
}

/** 三级降级（spec §5.1）：库存 → Smithery 实时拉取+回写 → 裸模式。
 *  回写副作用幂等：拉到即落 config_schema 列，二次调用命中第一级。 */
async function resolveSchema(
  def: RegisteredMcp,
): Promise<{ schema: McpConfigSchema; bare: false } | { bare: true }> {
  if (def.configSchema && Object.keys(def.configSchema).length > 0) {
    return { schema: def.configSchema, bare: false };
  }
  // 仅 smithery 远程有详情接口可拉（slug = 注册名）；custom/marketplace 直接裸模式
  if (def.source === 'smithery') {
    try {
      const schema = (await fetchSmitheryDetail(def.name)).connections[0]?.configSchema;
      if (schema && Object.keys(schema).length > 0) {
        try {
          getDb()
            .prepare('UPDATE mcp_definitions SET config_schema = ? WHERE name = ?')
            .run(JSON.stringify(schema), def.name);
        } catch {
          // 回写失败不阻塞编辑（本次内存中已可用，只是下次还要再拉）
          logger.warn('config_schema 回写失败（不影响编辑）', { name: def.name });
        }
        return { schema, bare: false };
      }
    } catch {
      // 拉取失败（网络/非 2xx）降级裸模式，不阻塞编辑（spec §7）
      logger.warn('Smithery schema 拉取失败，降级裸模式', { name: def.name });
    }
  }
  return { bare: true };
}

/** query 字段从 url 反解、header 字段读 headers（spec §4.1 values 语义）。
 *  字段无现值（url 无该参数 / headers 无该键）不产生占位项。 */
function extractValues(
  url: string,
  headers: Record<string, string>,
  schema: McpConfigSchema,
): Record<string, string> {
  const values: Record<string, string> = {};
  // URLSearchParams.get 已按字段名 decode（与 composeRemoteConfig 的
  // encodeURIComponent 往返一致）
  const params = new URLSearchParams(url.split('?')[1] ?? '');
  for (const key of Object.keys(schema.properties ?? {})) {
    if (schema.properties?.[key]?.['x-from'] === 'query') {
      const v = params.get(key);
      if (v !== null) values[key] = v;
    } else if (headers[key] !== undefined) {
      values[key] = headers[key];
    }
  }
  return values;
}

/** 查看已装 MCP 配置（仅远程条目；三级降级见 resolveSchema） */
export async function getMcpConfigView(name: string): Promise<McpConfigView> {
  // getMcpConfig 声明返回 McpServerConfig，实际经 rowToRegistered 恒产出
  // RegisteredMcp（transport/source 必有值）——按运行时真形收窄
  const def = getMcpConfig(name) as RegisteredMcp | null;
  if (!def) throw new Error(`MCP ${name} 未注册`);
  if (def.transport !== 'streamable_http') {
    throw new Error(`MCP ${name} 不是远程条目，不支持配置编辑`);
  }
  const url = def.url ?? '';
  const headers = def.headers ?? {};
  const resolved = await resolveSchema(def);
  if (!resolved.bare) {
    return {
      name,
      transport: def.transport,
      bare: false,
      schema: resolved.schema,
      values: extractValues(url, headers, resolved.schema),
      url,
      // schema 模式下回显走 values，headers 保持空对象（spec §4.1）
      headers: {},
    };
  }
  return { name, transport: def.transport, bare: true, values: {}, url, headers };
}

/** 编辑已装远程 MCP 配置：校验 → 重组/直写 → 专用 UPDATE → 驱逐池连接 */
export async function updateRemoteMcpConfig(
  name: string,
  input: McpConfigUpdateInput,
): Promise<void> {
  // https 校验先行——非法输入不触发任何 DB/网络副作用
  if (!input.url.startsWith('https://')) {
    throw new Error(`远程 MCP ${name} 配置更新失败：url 必须以 https:// 开头`);
  }
  const def = getMcpConfig(name) as RegisteredMcp | null;
  if (!def) throw new Error(`MCP ${name} 未注册`);
  if (def.transport !== 'streamable_http') {
    throw new Error(`MCP ${name} 不是远程条目，不支持配置编辑`);
  }
  // 裸/schema 判定与 getMcpConfigView 一致（smithery 空 schema 在此触发
  // fetch + 回写，副作用幂等无害）
  const resolved = await resolveSchema(def);
  let finalUrl: string;
  let headers: Record<string, string>;
  if (!resolved.bare) {
    // spec §5.2：config 值 trim 后空串剔除（同安装语义：可选字段空值不下发）
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.config)) {
      const trimmed = value.trim();
      if (trimmed !== '') config[key] = trimmed;
    }
    ({ finalUrl, headers } = composeRemoteConfig(input.url, config, resolved.schema));
  } else {
    // 裸模式：url 直写 + headers 整包覆盖（无 schema 分流）
    finalUrl = input.url;
    headers = input.headers ?? {};
  }
  // input.schema 透传落库（编辑期间拉到的新 schema 顺手保存；缺省保留原列值）
  updateRemoteMcpDefinition(name, finalUrl, headers, input.schema);
  await evictMcpByName(name);
}

/** 悬空 MCP 引用条目（spec §4.3，renderer types.d.ts 镜像源） */
export interface DanglingMcpRef {
  /** 悬空引用名（如 'filesystem'） */
  refName: string;
  /** 引用了该未注册名字的全部 agent（definitionId + 展示名） */
  agents: Array<{ definitionId: string; name: string }>;
}

/**
 * P2.2 Task 5：悬空 MCP 引用扫描（spec §5.4）——agent 全量（含已启用
 * builtin 的 DB 行与 custom/marketplace 定义）defaultMcps[].ref 与
 * listRegistered() 名字集比对，查无者按 refName 聚合 agent 名单；同 def
 * 重复引用去重。扫描异常 warn + 空数组（UI 卡片静默不显示，spec §7）。
 */
export function listDanglingMcpRefs(): DanglingMcpRef[] {
  try {
    const registeredNames = new Set(listRegistered().map((m) => m.name));
    const byRef = new Map<string, Array<{ definitionId: string; name: string }>>();
    for (const def of listAgentDefinitions()) {
      // 同 def 重复引用同名 MCP 去重（Set 收敛，一个 def 只计一次）
      const refs = new Set(def.defaultMcps.map((r) => r.ref));
      for (const ref of refs) {
        if (registeredNames.has(ref)) continue;
        const agents = byRef.get(ref) ?? [];
        agents.push({ definitionId: def.id, name: def.name });
        byRef.set(ref, agents);
      }
    }
    return Array.from(byRef.entries()).map(([refName, agents]) => ({ refName, agents }));
  } catch (err) {
    logger.warn('悬空 MCP 引用扫描失败，返回空列表', { error: (err as Error).message });
    return [];
  }
}

/** P2.5：全字段编辑视图（stdio + 远程通吃；renderer types.d.ts 镜像源） */
export interface McpEditView {
  name: string;
  transport: 'stdio' | 'streamable_http';
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 仅远程；stdio 为 undefined */
  url?: string;
  /** 仅远程；stdio 为空对象 */
  headers: Record<string, string>;
  /** 仅 stdio */
  cwd?: string;
}

/** 读全字段编辑视图（未注册抛中文错） */
export function getMcpEditView(name: string): McpEditView {
  const def = getMcpConfig(name) as RegisteredMcp | null;
  if (!def) throw new Error(`MCP ${name} 未注册`);
  return {
    name,
    transport: def.transport,
    version: def.version,
    command: def.command,
    args: def.args ?? [],
    env: def.env ?? {},
    url: def.url,
    headers: def.transport === 'streamable_http' ? (def.headers ?? {}) : {},
    cwd: def.cwd,
  };
}

/** 全字段编辑：校验 → UPDATE（保 id/source/installed_at/config_schema）→ 驱逐池连接 → 广播目录 */
export async function updateMcpEntry(name: string, input: McpEntryUpdateInput): Promise<void> {
  updateMcpEntryDefinition(name, input);
  await evictMcpByName(name);
  void broadcastLocalResourceCatalog();
}
