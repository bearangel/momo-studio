// electron/src/main/agent/resource-ops.ts
//
// resource-ops 主进程服务层（spec 2026-11-09-resource-creation-skills §5/§6）：
// 会话内资源创建的白名单 op。全部复用主进程既有服务（与 UI 创建同链——单一
// 真相源）。workspaceId 由桥的主进程侧从 spawn 上下文注入，本层入参不含
// workspaceId——子进程不可伪造归属。
import { createCustomDef, addMember, generateAgentUserId } from './crud';
import { listAgentDefinitions, getAgentDefinition, listMembers } from './agent-queries';
import { getProvider } from './provider-crud';
import { parseAgentManifest } from './manifest-parser';
import { createTeam, listTeams } from './team';
import { getSkillsDir, listInstalled as listInstalledSkills } from '../skill/zip-uploader';
import { listRegistered } from '../mcp/host-manager';
import { getDb } from '../storage/db';
import { isValidSlug } from '../marketplace/types';
import { logger } from '../logger';

/** 白名单 op 枚举——桥面只放行这六个入口（spec §6：桥不是通用 RPC 面） */
export const RESOURCE_OP_NAMES = [
  'list',
  'createAgent',
  'addMember',
  'createSkill',
  'createMcp',
  'createTeam',
] as const;

/** resource_list 聚合清单（缺省全量；type 过滤时仅填对应段） */
export interface ResourceListResult {
  agents?: Array<{ id: string; slug: string; name: string; source: string; modelConfigured: boolean }>;
  members?: Array<{ instanceId: string; definitionId: string; name: string; running: boolean }>;
  skills?: Array<{ slug: string; name: string; source: string }>;
  mcps?: Array<{ name: string }>;
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

/** create_team 返回（team.ts 原事务，错误信息原样透出） */
export interface CreateTeamResult {
  teamId: string;
  name: string;
  memberCount: number;
}

/** op 分发。args 一律视为不可信输入（形状先验，非法即抛中文错误）。 */
export async function executeResourceOp(
  op: string,
  args: unknown,
  workspaceId: string,
): Promise<unknown> {
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    throw new Error(`未知 resource op: ${op}`);
  }
  const a = (args ?? {}) as Record<string, unknown>;
  switch (op) {
    case 'list': return opList(a['type'], workspaceId);
    case 'createAgent': return opCreateAgent(a, workspaceId);
    case 'addMember': return opAddMember(a, workspaceId);
    case 'createSkill': throw new Error('createSkill 未实现');
    case 'createMcp': throw new Error('createMcp 未实现');
    case 'createTeam': return opCreateTeam(a, workspaceId);
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
    result.mcps = listRegistered().map((m) => ({ name: m.name }));
  }
  if (need('teams')) {
    result.teams = listTeams(workspaceId).map((tm) => ({
      id: tm.id, name: tm.name, leaderInstanceId: tm.leaderInstanceId,
      memberInstanceIds: tm.members.map((m) => m.instanceId),
    }));
  }
  return result;
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

// ── createTeam（复用 team.ts 事务，错误原样透出）──
function opCreateTeam(a: Record<string, unknown>, workspaceId: string): CreateTeamResult {
  const name = str(a['name'], 'name');
  const icon = typeof a['iconEmoji'] === 'string' && a['iconEmoji'].trim() ? a['iconEmoji'] : '👥';
  const memberInstanceIds = strArray(a['memberInstanceIds'], 'memberInstanceIds');
  const leaderInstanceId = str(a['leaderInstanceId'], 'leaderInstanceId');
  const team = createTeam(workspaceId, name, icon, memberInstanceIds, leaderInstanceId);
  return { teamId: team.id, name: team.name, memberCount: team.members.length };
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
