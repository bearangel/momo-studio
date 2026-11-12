// electron/src/main/agent/resource-ops.ts
//
// resource-ops 主进程服务层（spec 2026-11-09-resource-creation-skills §5/§6）：
// 会话内资源创建的白名单 op。全部复用主进程既有服务（与 UI 创建同链——单一
// 真相源）。workspaceId 由桥的主进程侧从 spawn 上下文注入，本层入参不含
// workspaceId——子进程不可伪造归属。
import { createCustomDef, addMember, generateAgentUserId } from './crud';
import { listAgentDefinitions, getAgentDefinition, listMembers, getMemberByInstanceId } from './agent-queries';
import { mergeCapabilities, readAllocationLayer, readAssignmentDeltas } from './capability-merger';
import type { AgentDefinition, WorkspaceAgentMember } from './types';
import { getProvider, listProviders, listProviderModels } from './provider-crud';
import { getGlobalSettings } from '../settings/crud';
import { parseAgentManifest } from './manifest-parser';
import { createTeam, listTeams } from './team';
import { getSkillsDir, listInstalled as listInstalledSkills } from '../skill/zip-uploader';
import { parseSkillMd } from '../skill/loader';
import { listRegistered, registerMcpDefinition } from '../mcp/host-manager';
import { McpClient } from '../mcp/client';
import { HttpMcpClient, McpHttpError } from '../mcp/http-client';
import type { McpServerConfig, McpToolInfo, RegisteredMcp } from '../mcp/types';
import { getDb } from '../storage/db';
import { isValidSlug } from '../marketplace/types';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/** 白名单 op 枚举——桥面只放行这八个入口（spec §6：桥不是通用 RPC 面） */
export const RESOURCE_OP_NAMES = [
  'list',
  'createAgent',
  'addMember',
  'createSkill',
  'createMcp',
  'createTeam',
  'listModels',
  'describeAgent',
] as const;

/** resource_list 聚合清单（缺省全量；type 过滤时仅填对应段） */
export interface ResourceListResult {
  agents?: Array<{ id: string; slug: string; name: string; source: string; modelConfigured: boolean }>;
  members?: Array<{ instanceId: string; definitionId: string; name: string; running: boolean }>;
  skills?: Array<{ slug: string; name: string; source: string }>;
  mcps?: Array<{ name: string; transport: RegisteredMcp['transport']; enabled: boolean }>;
  teams?: Array<{ id: string; name: string; leaderInstanceId: string; memberInstanceIds: string[] }>;
}

/** create_agent 返回（addToWorkspace=true 时附带成员 instanceId） */
export interface CreateAgentResult {
  definitionId: string;
  slug: string;
  member?: { instanceId: string };
}

/** add_agent_member 返回（幂等：同 ws 同 def 已存在时返回既有成员） */
export interface AddMemberResult {
  instanceId: string;
  agentName: string;
}

/** create_skill 返回 */
export interface CreateSkillResult {
  slug: string;
  name: string;
}

/** create_mcp 返回（toolNames 为首层工具名摘要，截断至前 20）。
 *  needsAuthorization：服务器返回 OAuth 挑战（401/403）——已落库未绑定，
 *  工具面为空，用户须在资源库完成授权后可用（R14）。 */
export interface CreateMcpResult {
  name: string;
  toolCount: number;
  toolNames: string[];
  needsAuthorization?: boolean;
  notice?: string;
}

/** create_team 返回（team.ts 原事务，错误信息原样透出） */
export interface CreateTeamResult {
  teamId: string;
  name: string;
  memberCount: number;
}

/** list_models 返回（最小暴露面：绝不携带 baseUrl / apiKey / api_key_ref） */
export interface ListModelsResult {
  providers: Array<{
    providerId: string; name: string; platform: string; isDefault: boolean;
    verified: boolean; defaultModel: string | null;
    models: Array<{ modelId: string; enabled: boolean; contextWindow: number | null; vision: boolean }>;
  }>;
  globalDefault: { providerId: string; modelId: string } | null;
}

/** op 分发。args 一律视为不可信输入（形状先验，非法即抛中文错误）。 */
export async function executeResourceOp(
  op: string,
  args: unknown,
  workspaceId: string,
  deps?: ResourceOpDeps,
): Promise<unknown> {
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    throw new Error(`未知 resource op: ${op}`);
  }
  const a = (args ?? {}) as Record<string, unknown>;
  switch (op) {
    case 'list': return opList(a['type'], workspaceId);
    case 'createAgent': return opCreateAgent(a, workspaceId);
    case 'addMember': return opAddMember(a, workspaceId);
    case 'createSkill': return opCreateSkill(a);
    case 'createMcp': return opCreateMcp(a, deps);
    case 'createTeam': return opCreateTeam(a, workspaceId);
    case 'listModels': return opListModels();
    case 'describeAgent': return opDescribeAgent(a, workspaceId);
    default: throw new Error(`未知 resource op: ${op}`);
  }
}

// ── list ──
// MCP 段用 listRegistered（mcp_definitions 全量同步读）而非 resource/library 的
// listResources——后者是 async 且会触发 catalog/hub 目录聚合（浏览面语义），
// 会话内 op 只需要「已配」清单（配置面语义），同步读零网络依赖。
function opList(typeFilter: unknown, workspaceId: string): ResourceListResult {
  const t = typeof typeFilter === 'string' ? typeFilter : undefined;
  const need = (x: string): boolean => t === undefined || t === x;
  const result: ResourceListResult = {};
  if (need('agents')) {
    result.agents = listAgentDefinitions().map((d) => ({
      id: d.id, slug: d.slug, name: d.name, source: d.source,
      modelConfigured: Boolean(d.modelProviderId),
    }));
  }
  if (need('members')) {
    result.members = listMembers(workspaceId).map((m) => ({
      instanceId: m.instanceId, definitionId: m.agentDefinitionId,
      name: m.agentName, running: m.lastRunning,
    }));
  }
  if (need('skills')) {
    result.skills = listInstalledSkills().map((s) => ({
      slug: s.slug, name: s.name, source: s.source,
    }));
  }
  if (need('mcps')) {
    // spec §5.1：name + transport + 启停态（字段名对齐 RegisteredMcp 真实形状）
    result.mcps = listRegistered().map((m) => ({
      name: m.name,
      transport: m.transport,
      enabled: m.enabled,
    }));
  }
  if (need('teams')) {
    result.teams = listTeams(workspaceId).map((tm) => ({
      id: tm.id, name: tm.name, leaderInstanceId: tm.leaderInstanceId,
      memberInstanceIds: tm.members.map((m) => m.instanceId),
    }));
  }
  return result;
}

// ── describeAgent（读面，spec §5.1）──
export interface DescribeAgentResult {
  definition: { id: string; slug: string; name: string; source: string; modelProviderId: string | null; modelName: string;
    defaultTools: Array<{ kind: string; ref: string }>; defaultMcps: unknown[]; defaultSkills: unknown[];
    deniedTools: string[] };
  member: { instanceId: string; running: boolean };
  effective: { tools: string[]; mcps: string[]; skills: string[] };
  attribution: { fromDefinition: string[]; fromWorkspace: string[]; memberAdded: string[]; memberRemoved: string[] };
  otherWorkspaceMembers: number;
}

/** agent 入参解析（describe/updateCapabilities/updateProfile 共用）：instanceId → 成员表 definitionId 匹配 → slug 反查 */
export function resolveAgentTarget(agent: string, workspaceId: string): { member: WorkspaceAgentMember; def: AgentDefinition } | null {
  const byInstance = getMemberByInstanceId(agent);
  if (byInstance) {
    const def = getAgentDefinition(byInstance.agentDefinitionId);
    if (def) return { member: byInstance, def };
    return null;
  }
  const byDefId = listMembers(workspaceId).find((m) => m.agentDefinitionId === agent);
  if (byDefId) {
    const def = getAgentDefinition(byDefId.agentDefinitionId);
    if (def) return { member: byDefId, def };
  }
  const bySlugDef = listAgentDefinitions().find((d) => d.slug === agent);
  if (bySlugDef) {
    const m = listMembers(workspaceId).find((x) => x.agentDefinitionId === bySlugDef.id);
    if (m) return { member: m, def: bySlugDef };
  }
  return null;
}

function opDescribeAgent(a: Record<string, unknown>, workspaceId: string): DescribeAgentResult {
  const key = str(a['agent'], 'agent');
  const target = resolveAgentTarget(key, workspaceId);
  if (!target) throw new Error(`未找到 agent 成员: ${key}（可先 resource_list 查询真实 instanceId/slug）`);
  const { member, def } = target;
  const alloc = readAllocationLayer(member.workspaceId);
  const deltas = readAssignmentDeltas(member.instanceId);
  const merged = mergeCapabilities(def, alloc, deltas);
  const defRefs = [
    ...def.defaultTools.map((t) => t.ref),
    ...def.defaultMcps.map((m) => m.ref),
    ...def.defaultSkills.map((s) => s.ref),
  ];
  const wsRefs = [...alloc.tools, ...alloc.mcps, ...alloc.skills];
  const otherWs = getDb()
    .prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM workspace_agent_members WHERE agent_definition_id = ? AND workspace_id != ?')
    .get(def.id, member.workspaceId) as { n: number };
  return {
    definition: {
      id: def.id, slug: def.slug, name: def.name, source: def.source,
      modelProviderId: def.modelProviderId, modelName: def.modelName,
      defaultTools: def.defaultTools, defaultMcps: def.defaultMcps, defaultSkills: def.defaultSkills,
      deniedTools: def.deniedTools ?? [],
    },
    member: { instanceId: member.instanceId, running: member.lastRunning },
    effective: { tools: merged.tools, mcps: merged.mcps, skills: merged.skills },
    attribution: {
      fromDefinition: defRefs,
      fromWorkspace: wsRefs.filter((r) => !defRefs.includes(r)),
      memberAdded: [...deltas.addedTools, ...deltas.addedMcps, ...deltas.addedSkills, ...deltas.addedPluginTools],
      memberRemoved: [...deltas.removedTools, ...deltas.removedMcps, ...deltas.removedSkills, ...deltas.removedPluginTools],
    },
    otherWorkspaceMembers: otherWs.n,
  };
}

// ── createAgent（与 UI 导入链 agent.createFromYaml 同语义：parse → 冲突拒绝 →
//    createCustomDef（含 defaultChatModel 兜底 + SAFE_MINIMUM_TOOLS 缺省））──
async function opCreateAgent(a: Record<string, unknown>, workspaceId: string): Promise<CreateAgentResult> {
  const manifestYaml = str(a['manifestYaml'], 'manifestYaml');
  const addToWorkspace = a['addToWorkspace'] === true;
  const parsed = parseAgentManifest(manifestYaml); // 校验失败抛逐字段错误（agent 可修后重试）
  if (!isValidSlug(parsed.slug)) throw new Error(`非法 slug: ${parsed.slug}`);
  // v25 定义全局化：任何 source 同 slug 即冲突（spec §5.2）——不做静默后缀
  const clash = listAgentDefinitions().find((d) => d.slug === parsed.slug);
  if (clash) {
    throw new Error(`slug 已存在: ${parsed.slug}（id=${clash.id}, source=${clash.source}）——请换 slug 或先在资源库管理既有定义`);
  }
  // 显式模型入参可选；providerId 显式时校验存在（友好报错优于 FK 中止）
  let modelProviderId = '';
  let modelName = '';
  if (typeof a['modelProviderId'] === 'string' && a['modelProviderId']) {
    modelProviderId = a['modelProviderId'];
    modelName = str(a['modelName'], 'modelName');
    if (!getProvider(modelProviderId)) throw new Error(`供应商不存在: ${modelProviderId}`);
  }
  const def = createCustomDef(null, {
    name: parsed.name,
    slug: parsed.slug,
    description: parsed.description,
    systemPrompt: parsed.systemPrompt,
    iconEmoji: parsed.iconEmoji,
    modelProviderId, // 空 → createCustomDef 走 defaultChatModel 兜底
    modelName,
    defaultTools: parsed.defaultTools,
    defaultMcps: parsed.defaultMcps,
    defaultSkills: parsed.defaultSkills,
  });
  let member: { instanceId: string } | undefined;
  if (addToWorkspace) {
    const m = await opAddMember({ definitionIdOrSlug: def.id }, workspaceId);
    member = { instanceId: m.instanceId };
  }
  logger.info('会话内创建 agent 定义', { slug: def.slug, id: def.id, addToWorkspace });
  return { definitionId: def.id, slug: def.slug, member };
}

// ── addMember（幂等：同 ws 同 def 已存在返回既有成员）──
async function opAddMember(
  a: Record<string, unknown>,
  workspaceId: string,
): Promise<AddMemberResult> {
  const key = str(a['definitionIdOrSlug'], 'definitionIdOrSlug');
  const def = getAgentDefinition(key) ?? listAgentDefinitions().find((d) => d.slug === key);
  if (!def) throw new Error(`未找到 agent 定义: ${key}（可先 resource_list 查询真实 id/slug）`);
  const existing = listMembers(workspaceId).find((m) => m.agentDefinitionId === def.id);
  if (existing) return { instanceId: existing.instanceId, agentName: existing.agentName };
  const member = await addMember(workspaceId, def.id, generateAgentUserId(def.slug));
  return { instanceId: member.instanceId, agentName: member.agentName };
}

// ── createSkill（与 zip 上传 / resource:createSkill 表单链同布局：目录 + SKILL.md +
//    .sha256 标记；skill_definitions 表是 marketplace 安装专用——写入会被 listInstalled
//    误标 marketplace 源，故不落库）──
interface SkillFileInput {
  path: string;
  content: string;
}

/** 解析后的路径必须仍在 skill 目录内（防 ../ 与绝对路径穿越——readSkillResource 同款纪律） */
function safeJoin(dir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error(`references 路径越界: ${rel}`);
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error(`references 路径越界: ${rel}`);
  }
  return full;
}

function opCreateSkill(a: Record<string, unknown>): CreateSkillResult {
  const slug = str(a['slug'], 'slug'); // 显式必填——中文 name 无法可靠派生英文 slug（spec §5.4）
  const skillMd = str(a['skillMd'], 'skillMd');
  const rawRefs = Array.isArray(a['references']) ? a['references'] : [];
  const refs: SkillFileInput[] = rawRefs.map((r): SkillFileInput => {
    if (typeof r !== 'object' || r === null) {
      throw new Error('references 条目须含 path 与 content 字符串');
    }
    const rec = r as Record<string, unknown>;
    if (typeof rec['path'] !== 'string' || rec['path'].length === 0 || typeof rec['content'] !== 'string') {
      throw new Error('references 条目须含 path 与 content 字符串');
    }
    return { path: rec['path'], content: rec['content'] };
  });
  if (!isValidSlug(slug)) throw new Error(`非法 slug: ${slug}`);
  const dup = listInstalledSkills().find((s) => s.slug === slug);
  if (dup) throw new Error(`skill 已存在: ${slug}（source=${dup.source}）——如需覆盖请先在资源库删除`);

  const dir = path.join(getSkillsDir(), slug);
  const def = parseSkillMd(skillMd, dir); // name/description 必填校验（缺则抛）
  // 全部校验（含 references 越界）先于任何写盘——错误路径零落盘
  const targets = refs.map((r) => safeJoin(dir, r.path));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf-8');
  refs.forEach((r, i) => {
    fs.mkdirSync(path.dirname(targets[i]!), { recursive: true });
    fs.writeFileSync(targets[i]!, r.content, 'utf-8');
  });
  // .sha256 标记 = custom 源标识（zip-uploader / form-create 同款）：listInstalled 据此识别
  fs.writeFileSync(
    path.join(dir, '.sha256'),
    createHash('sha256').update(skillMd, 'utf-8').digest('hex'),
  );
  logger.info('会话内安装 skill', { slug });
  return { slug, name: def.name };
}

// ── createMcp（先测后落库，spec §5.5：瞬态客户端不经进程池、失败零落库）──

/** MCP 连通握手超时——对齐 mcp-bridge 既有 30s 常量 */
export const MCP_TEST_TIMEOUT_MS = 30_000;

/** 瞬态客户端最小面（McpClient / HttpMcpClient 均满足） */
export interface TransientMcpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  disconnect(): Promise<void>;
}

/** 测试注入点（makeClient）：生产缺省真实工厂（stdio→McpClient / http→HttpMcpClient） */
export interface ResourceOpDeps {
  makeClient: (config: McpServerConfig) => TransientMcpClient;
}

function opCreateMcp(a: Record<string, unknown>, deps?: ResourceOpDeps): Promise<CreateMcpResult> {
  const name = str(a['name'], 'name');
  if (!isValidSlug(name)) throw new Error(`非法 MCP name: ${name}`);
  const taken = getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get(name);
  if (taken) throw new Error(`MCP 已存在: ${name}`);
  const raw = a['transport'];
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('transport 必须为 { kind: "stdio", command, args?, env? } 或 { kind: "http", url, headers? }');
  }
  const t = raw as Record<string, unknown>;
  const kind = t['kind'];
  if (kind !== 'stdio' && kind !== 'http') {
    throw new Error('transport 必须为 { kind: "stdio", command, args?, env? } 或 { kind: "http", url, headers? }');
  }

  // 配置形状：逐字段对齐 resource/ipc.handlers.ts resource:registerMcp 的 RegisterMcpInput
  // 组装（id/version 主进程补全、source 固定 'custom'；http 形态 command 空串占位）
  let config: McpServerConfig;
  if (kind === 'stdio') {
    config = {
      id: randomUUID(),
      name,
      version: '1.0.0',
      transport: 'stdio',
      command: str(t['command'], 'transport.command'),
      args: t['args'] === undefined ? [] : strArray(t['args'], 'transport.args'),
      env: optStrMap(t['env'], 'transport.env') ?? {},
      source: 'custom',
    };
  } else {
    config = {
      id: randomUUID(),
      name,
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [], // http 形态无启动参数——handler 同款空数组占位（args 列 NOT NULL）
      url: str(t['url'], 'transport.url'),
      headers: optStrMap(t['headers'], 'transport.headers') ?? {},
      source: 'custom',
    };
  }

  return (async (): Promise<CreateMcpResult> => {
    const makeClient =
      deps?.makeClient ??
      ((cfg: McpServerConfig): TransientMcpClient =>
        cfg.transport === 'streamable_http' ? new HttpMcpClient(cfg) : new McpClient(cfg));
    const client = makeClient(config);
    let toolNames: string[];
    try {
      await withTimeout(client.connect(), MCP_TEST_TIMEOUT_MS, `MCP ${name} 连接超时`);
      const tools = await withTimeout(client.listTools(), MCP_TEST_TIMEOUT_MS, `MCP ${name} 工具发现超时`);
      toolNames = tools.map((tool) => tool.name);
    } catch (err) {
      // R14：OAuth 挑战例外（判定口径与 host-manager getOrStartMcp 一致——401/403 的
      // McpHttpError 即「服务器要求授权」，不依赖 wwwAuthenticate 存在性）。授权码+
      // PKCE 须用户在浏览器完成，agent 无法代劳，故落库未绑定 + 返回引导而非报错，
      // 避免用户被迫手工重建同一 server
      if (err instanceof McpHttpError && (err.status === 401 || err.status === 403)) {
        registerMcpDefinition(config);
        logger.info('会话内注册 MCP（待 OAuth 授权）', { name });
        return {
          name,
          toolCount: 0,
          toolNames: [],
          needsAuthorization: true,
          notice:
            `MCP ${name} 需要 OAuth 授权，已注册但暂未连接（工具面为空）。` +
            '授权须由用户在应用内完成，agent 无法代为操作：请在 资源库 → MCP → ' +
            `${name} → 编辑，提交后点「去授权」完成认证。完成后即可直接使用，无需重新创建。`,
        };
      }
      throw err;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
    registerMcpDefinition(config);
    logger.info('会话内注册 MCP', { name, toolCount: toolNames.length });
    return { name, toolCount: toolNames.length, toolNames: toolNames.slice(0, 20) };
  })();
}

/** Promise 竞速超时（定时器 unref——不阻塞进程退出） */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(msg)), ms);
      timer.unref?.();
    }),
  ]);
}

// ── createTeam（复用 team.ts 事务，错误原样透出）──
function opCreateTeam(a: Record<string, unknown>, workspaceId: string): CreateTeamResult {
  const name = str(a['name'], 'name');
  const icon = typeof a['iconEmoji'] === 'string' && a['iconEmoji'].trim() ? a['iconEmoji'] : '👥';
  const memberInstanceIds = strArray(a['memberInstanceIds'], 'memberInstanceIds');
  const leaderInstanceId = str(a['leaderInstanceId'], 'leaderInstanceId');
  const team = createTeam(workspaceId, name, icon, memberInstanceIds, leaderInstanceId);
  return { teamId: team.id, name: team.name, memberCount: team.members.length };
}

// ── listModels（只读：agent 建号选模型的真清单——与 UI 供应商页同链。输出白名单
//    字段——baseUrl/apiKey/api_key_ref 在此层显式丢弃，不进会话上下文）──
function opListModels(): ListModelsResult {
  const providers = listProviders().map((p) => ({
    providerId: p.id,
    name: p.name,
    platform: p.platform,
    isDefault: p.isDefault,
    verified: p.lastVerifiedAt !== null,
    defaultModel: p.defaultModel,
    models: listProviderModels(p.id).map((m) => ({
      modelId: m.modelId,
      enabled: m.enabled,
      contextWindow: m.contextWindow,
      vision: m.vision,
    })),
  }));
  return { providers, globalDefault: getGlobalSettings().defaultChatModel ?? null };
}

// ── 入参形状小工具（no any：unknown 先验后窄化）──
function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${field} 必须为非空字符串`);
  return v;
}
function strArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${field} 必须为字符串数组`);
  }
  return v as string[];
}
function optStrMap(v: unknown, field: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${field} 必须为字符串键值对象`);
  }
  for (const val of Object.values(v)) {
    if (typeof val !== 'string') throw new Error(`${field} 必须为字符串键值对象`);
  }
  return v as Record<string, string>;
}
