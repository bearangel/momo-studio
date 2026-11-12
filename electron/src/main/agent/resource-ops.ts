// electron/src/main/agent/resource-ops.ts
//
// resource-ops 主进程服务层（spec 2026-11-09-resource-creation-skills §5/§6）：
// 会话内资源创建的白名单 op。全部复用主进程既有服务（与 UI 创建同链——单一
// 真相源）。workspaceId 由桥的主进程侧从 spawn 上下文注入，本层入参不含
// workspaceId——子进程不可伪造归属。
import { createCustomDef, addMember, generateAgentUserId, updateAgentDefinition, stopRunningInstancesByDefinition } from './crud';
import { listAgentDefinitions, getAgentDefinition, listMembers, getMemberByInstanceId } from './agent-queries';
import { mergeCapabilities, readAllocationLayer, readAssignmentDeltas, union, subtract, type MergedCapabilities } from './capability-merger';
import { setAssignmentDeltas } from './assignment-capabilities';
import { applyCapabilityDelta, type CapabilityDeltaInput } from './resource-ops-delta';
import { isAgentRunning } from './runtime-status';
import { toolRefMatches } from '../plugin/assembly';
import type { AgentDefinition, WorkspaceAgentMember, McpRef, SkillRef } from './types';
import { getProvider, listProviders, listProviderModels } from './provider-crud';
import { getGlobalSettings } from '../settings/crud';
import { parseAgentManifest } from './manifest-parser';
import { createTeam, listTeams } from './team';
import { getSkillsDir, listInstalled as listInstalledSkills } from '../skill/zip-uploader';
import { parseSkillMd } from '../skill/loader';
import { listRegistered, registerMcpDefinition } from '../mcp/host-manager';
import { McpClient } from '../mcp/client';
import { HttpMcpClient, McpHttpError } from '../mcp/http-client';
import type { McpServerConfig, McpToolInfo, RegisteredMcp, McpEntryUpdateInput } from '../mcp/types';
import { updateMcpEntry } from '../resource/mcp-config';
import { getWorkspace } from '../workspace/crud';
import { getDb } from '../storage/db';
import { isValidSlug } from '../marketplace/types';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import type { AgentOpConfirmPayload } from './agent-op-confirm';

/** 白名单 op 枚举——桥面只放行这十二个入口（spec §6：桥不是通用 RPC 面） */
export const RESOURCE_OP_NAMES = [
  'list',
  'createAgent',
  'addMember',
  'createSkill',
  'updateSkill',
  'createMcp',
  'updateMcp',
  'createTeam',
  'listModels',
  'describeAgent',
  'updateCapabilities',
  'updateProfile',
] as const;

/** op 执行上下文（spec 2026-11-12 §6）：background=后台派发；callerInstanceId=
 *  触发本次 op 的成员自身（restart=auto 时的「绝不 mid-call 杀自己」判定依据）。
 *  桥接线（Task 10）从 spawn 上下文填充；缺省视为前台且无自身调用 */
export interface OpContext {
  background: boolean;
  callerInstanceId?: string;
}

// ── 确认档位与确认载荷（spec 2026-11-12 §5.6/§7.1——桥面确认门的单一真相源）──

/** 确认档位矩阵（spec §5.6）：updateProfile / updateSkill / updateMcp 恒确认；
 *  updateCapabilities 含任一非空 add（含加 skill）或 scope='definition' 需确认，
 *  纯 member 纯 remove（纯减权，方向安全可逆）免确认；其余 op（含全部既有
 *  create 族与只读族）一律 none。args 宽容读取（桥面在形状先验之前判档） */
export function confirmTierForOp(op: string, args: Record<string, unknown>): 'required' | 'none' {
  if (op === 'updateProfile' || op === 'updateSkill' || op === 'updateMcp') return 'required';
  if (op === 'updateCapabilities') {
    if (args['scope'] === 'definition') return 'required';
    const add = args['add'];
    if (typeof add === 'object' && add !== null && !Array.isArray(add)) {
      const r = add as Record<string, unknown>;
      for (const k of ['skills', 'mcps', 'tools', 'pluginTools'] as const) {
        if (Array.isArray(r[k]) && (r[k] as unknown[]).length > 0) return 'required';
      }
    }
    return 'none';
  }
  return 'none';
}

/** op → 确认卡展示的工具名（requester.toolName） */
const OP_TOOL_NAMES: Readonly<Record<string, string>> = {
  describeAgent: 'describe_agent',
  updateCapabilities: 'update_agent_capabilities',
  updateProfile: 'update_agent_profile',
  updateSkill: 'update_skill',
  updateMcp: 'update_mcp',
};

/** 确认载荷构建的宽容小工具（diff 是展示面不是校验面——非法形状降级展示，
 *  严格形状先验仍由 executeResourceOp 在裁决通过后执行） */
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function deltaEntries(v: unknown): Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
  const r = v as Record<string, unknown>;
  const out: Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }> = [];
  for (const k of ['skills', 'mcps', 'tools', 'pluginTools'] as const) {
    const arr = r[k];
    if (Array.isArray(arr)) {
      for (const ref of arr) if (typeof ref === 'string') out.push({ field: k, ref });
    }
  }
  return out;
}
/** 确认卡长文本预览截断（systemPrompt / skillMd 不入卡全文） */
function preview(v: string, max = 120): string {
  return v.length <= max ? v : v.slice(0, max - 1) + '…';
}
/** agent 目标名解析（容忍失败：查无 / DB 异常 → undefined，卡面降级展示） */
function agentTargetNames(agent: unknown, workspaceId: string): { memberName?: string; defName?: string } {
  const key = optStr(agent);
  if (!key) return {};
  try {
    const t = resolveAgentTarget(key, workspaceId);
    return t ? { memberName: t.member.agentName, defName: t.def.name } : {};
  } catch {
    return {};
  }
}
/** workspace 名（可选展示字段；容忍 DB 异常 → 缺席） */
function workspaceNameOf(workspaceId: string): string | undefined {
  try {
    return getWorkspace(workspaceId)?.name ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 确认卡结构化 diff（spec §7.1）——主进程真相源，renderer 只渲染。
 * 只对 tier=required 的 4 个 op 产出非 null；其余返回 null（桥面判档在前，
 * 不会对 none 档调用）。before 值一律省略（只展示 after，避免回显 prompt
 * 全文翻倍）；systemPrompt / skillMd 经 preview 截断。
 */
export function buildConfirmPayload(
  op: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Omit<AgentOpConfirmPayload, 'requestId' | 'expiresAt'> | null {
  const toolName = OP_TOOL_NAMES[op] ?? op;
  const wsName = workspaceNameOf(workspaceId);
  const targetWith = (kind: 'member' | 'definition' | 'skill' | 'mcp', name: string) => ({
    kind, name, ...(wsName !== undefined && { workspaceName: wsName }),
  });

  if (op === 'updateCapabilities') {
    const names = agentTargetNames(args['agent'], workspaceId);
    const scope = args['scope'] === 'definition' ? 'definition' : 'member';
    const adds = deltaEntries(args['add']);
    const removes = deltaEntries(args['remove']);
    const risks: string[] = [];
    if (adds.some((e) => e.field === 'tools' || e.field === 'pluginTools')) risks.push('将授予新工具（扩权）');
    if (scope === 'definition') risks.push('将修改 agent 定义（全局生效）');
    return {
      workspaceId,
      requester: {
        agentName: names.memberName ?? names.defName ?? '(unknown)',
        op, toolName,
      },
      diff: {
        target: targetWith(scope === 'definition' ? 'definition' : 'member',
          names.memberName ?? names.defName ?? optStr(args['agent']) ?? '(unknown)'),
        scope,
        adds, removes,
      },
      ...(risks.length > 0 && { riskNote: risks.join('；') }),
    };
  }

  if (op === 'updateProfile') {
    const names = agentTargetNames(args['agent'], workspaceId);
    const fieldChanges: Array<{ field: string; after?: string }> = [];
    const name = optStr(args['name']);
    if (name !== undefined) fieldChanges.push({ field: 'name', after: name });
    const description = optStr(args['description']);
    if (description !== undefined) fieldChanges.push({ field: 'description', after: preview(description) });
    const systemPrompt = optStr(args['systemPrompt']);
    if (systemPrompt !== undefined) fieldChanges.push({ field: 'systemPrompt', after: preview(systemPrompt) });
    const iconEmoji = optStr(args['iconEmoji']);
    if (iconEmoji !== undefined) fieldChanges.push({ field: 'iconEmoji', after: iconEmoji });
    const deniedTools = args['deniedTools'];
    if (Array.isArray(deniedTools) && deniedTools.every((x) => typeof x === 'string')) {
      fieldChanges.push({ field: 'deniedTools', after: JSON.stringify(deniedTools) });
    }
    if (typeof args['model'] === 'object' && args['model'] !== null) {
      const m = args['model'] as Record<string, unknown>;
      const providerId = optStr(m['providerId']);
      const modelName = optStr(m['modelName']);
      if (providerId !== undefined && modelName !== undefined) {
        fieldChanges.push({ field: 'model', after: `${providerId} / ${modelName}` });
      }
    }
    return {
      workspaceId,
      requester: {
        agentName: names.memberName ?? names.defName ?? '(unknown)',
        op, toolName,
      },
      diff: {
        target: targetWith('definition', names.defName ?? names.memberName ?? optStr(args['agent']) ?? '(unknown)'),
        adds: [], removes: [],
        ...(fieldChanges.length > 0 && { fieldChanges }),
      },
    };
  }

  if (op === 'updateSkill') {
    const slug = optStr(args['slug']) ?? '(unknown)';
    const skillMd = optStr(args['skillMd']);
    return {
      workspaceId,
      requester: { agentName: slug, op, toolName },
      diff: {
        target: targetWith('skill', slug),
        adds: [], removes: [],
        ...(skillMd !== undefined && { fieldChanges: [{ field: 'skillMd', after: preview(skillMd) }] }),
      },
    };
  }

  if (op === 'updateMcp') {
    const name = optStr(args['name']) ?? '(unknown)';
    const fieldChanges: Array<{ field: string; after?: string }> = [];
    const t = args['transport'];
    if (typeof t === 'object' && t !== null && !Array.isArray(t)) {
      const r = t as Record<string, unknown>;
      if (r['kind'] === 'http') {
        const url = optStr(r['url']);
        if (url !== undefined) fieldChanges.push({ field: 'transport', after: `http ${url}` });
      } else if (r['kind'] === 'stdio') {
        const command = optStr(r['command']);
        if (command !== undefined) {
          // 凭证不回显：headers / env 只入配置不进卡（spec §5.5/§11）
          const extra = Array.isArray(r['args']) && r['args'].every((x) => typeof x === 'string')
            ? ` ${(r['args'] as string[]).join(' ')}`
            : '';
          fieldChanges.push({ field: 'transport', after: `stdio ${command}${extra}` });
        }
      }
    }
    return {
      workspaceId,
      requester: { agentName: name, op, toolName },
      diff: {
        target: targetWith('mcp', name),
        adds: [], removes: [],
        ...(fieldChanges.length > 0 && { fieldChanges }),
      },
      riskNote: '连接与凭证变更',
    };
  }

  return null;
}

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

/** update_mcp 返回（与 CreateMcpResult 同形，spec §5.5。needsAuthorization =
 *  R14 OAuth 例外——新配置已落库但连接被 401/403 挑战，工具面为空待用户授权） */
export interface UpdateMcpResult {
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

/** op 分发。args 一律视为不可信输入（形状先验，非法即抛中文错误）。
 *  ctx（Task 5 起）：background / callerInstanceId——桥接线在 Task 10 填充，
 *  既有 4 参调用缺省 undefined，行为不变 */
export async function executeResourceOp(
  op: string,
  args: unknown,
  workspaceId: string,
  deps?: ResourceOpDeps,
  ctx?: OpContext,
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
    case 'updateSkill': return opUpdateSkill(a);
    case 'createMcp': return opCreateMcp(a, deps);
    case 'updateMcp': return opUpdateMcp(a, deps);
    case 'createTeam': return opCreateTeam(a, workspaceId);
    case 'listModels': return opListModels();
    case 'describeAgent': return opDescribeAgent(a, workspaceId);
    case 'updateCapabilities': return opUpdateCapabilities(a, workspaceId, ctx);
    case 'updateProfile': return opUpdateProfile(a, workspaceId, ctx);
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
    defaultTools: Array<{ kind: string; ref: string }>; defaultMcps: McpRef[]; defaultSkills: SkillRef[];
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

// ── updateCapabilities（写面，spec 2026-11-12 §5.2/§6/§8——member delta 落
//    Layer 3 / definition 落 def.default*，restart 三行接线）──

/** update_capabilities 返回。restart 相关键互斥出现（spec §8 三行表）：
 *  deferred → needsRestart:true；auto+自身 → effectiveFrom:'next-turn'；
 *  auto+他人在跑 → restarted:true；auto+未在跑 → needsRestart:false */
export interface UpdateCapabilitiesResult {
  appliedTo: 'member' | 'definition';
  changed: { adds: string[]; removes: string[] };
  effective: { tools: string[]; mcps: string[]; skills: string[]; deniedTools: string[]; grantedPlugin: string[] };
  restarted?: boolean;
  needsRestart?: boolean;
  effectiveFrom?: 'next-turn';
  notice?: string;
  stoppedInstances?: number;
  otherWorkspaceMembers: number;
}

/** add/remove 归一：四字段缺省空数组，出现即须为字符串数组（返回全字段必填形状） */
function normDelta(v: unknown, field: string): Required<CapabilityDeltaInput> {
  if (v === undefined) return { skills: [], mcps: [], tools: [], pluginTools: [] };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${field} 必须为 { skills?, mcps?, tools?, pluginTools? } 对象`);
  }
  const r = v as Record<string, unknown>;
  const refs = (x: unknown, k: string): string[] => (x === undefined ? [] : strArray(x, `${field}.${k}`));
  return {
    skills: refs(r['skills'], 'skills'),
    mcps: refs(r['mcps'], 'mcps'),
    tools: refs(r['tools'], 'tools'),
    pluginTools: refs(r['pluginTools'], 'pluginTools'),
  };
}

/** 成员级插件授权基线（spec §6 公式）：授权通道（ws allocation ∪ def.defaultTools）
 *  中的 plugin: refs，剔除被 def.deniedTools 模式串命中者（toolRefMatches 同款语义） */
function pluginGrantBaseline(def: AgentDefinition, allocTools: string[]): string[] {
  const denied = def.deniedTools ?? [];
  return [...new Set([...allocTools, ...def.defaultTools.map((t) => t.ref)])]
    .filter((r) => r.startsWith('plugin:') && !toolRefMatches(r, denied));
}

/** 成员级插件授权现状——与 spawn 真值同源（spawn-helpers grant-set 口径）：
 *  候选 = merged.tools 的 plugin: refs ∪ addedPluginTools（re-enable 行），
 *  deny 侧 = merged.deniedTools = (def禁 ∪ removed) − added（added 可抵消
 *  def 禁——另拼 removed ∪ defDenied 会擦除 re-enable 行）。
 *  applyCapabilityDelta 的 EffectiveState.grantedPlugin 入参 */
function pluginGrantedFrom(merged: MergedCapabilities, addedPluginTools: string[]): string[] {
  const candidates = [...new Set([...merged.tools.filter((r) => r.startsWith('plugin:')), ...addedPluginTools])];
  return candidates.filter((p) => !toolRefMatches(p, merged.deniedTools));
}

/** 发起者豁免停机时的换芯登记（spec §8「绝不 mid-call 杀自己」definition 面）：
 *  caller 是该定义的运行成员 → 动态 import 登记 respawn-on-idle 并返回
 *  'next-turn'；否则返回 undefined。member 分支自改同款模式（动态 import 打破
 *  runtime-registry → runtime-spawner → resource-ops-bridge → 本模块 回环） */
async function callerRespawnOnIdle(defId: string, ctx: OpContext | undefined): Promise<'next-turn' | undefined> {
  const caller = ctx?.callerInstanceId;
  if (caller === undefined) return undefined;
  if (getMemberByInstanceId(caller)?.agentDefinitionId !== defId) return undefined;
  if (!isAgentRunning(caller)) return undefined;
  const { requestRespawnAfterIdle } = await import('./runtime-registry');
  requestRespawnAfterIdle(caller);
  return 'next-turn';
}

async function opUpdateCapabilities(
  a: Record<string, unknown>,
  workspaceId: string,
  ctx?: OpContext,
): Promise<UpdateCapabilitiesResult> {
  const key = str(a['agent'], 'agent');
  // 形状先验：scope / restart 枚举值非法即抛（缺省 member / auto）
  const scope = a['scope'] === undefined ? 'member' : a['scope'];
  if (scope !== 'member' && scope !== 'definition') throw new Error(`scope 必须为 'member' 或 'definition'`);
  const restart = a['restart'] === undefined ? 'auto' : a['restart'];
  if (restart !== 'auto' && restart !== 'deferred') throw new Error(`restart 必须为 'auto' 或 'deferred'`);
  const add = normDelta(a['add'], 'add');
  const remove = normDelta(a['remove'], 'remove');
  const totalRefs =
    add.tools.length + add.mcps.length + add.skills.length + add.pluginTools.length +
    remove.tools.length + remove.mcps.length + remove.skills.length + remove.pluginTools.length;
  if (totalRefs === 0) throw new Error('add 与 remove 至少其一须含非空引用（skills/mcps/tools/pluginTools）');

  const target = resolveAgentTarget(key, workspaceId);
  if (!target) throw new Error(`未找到 agent 成员: ${key}（可先 resource_list 查询真实 instanceId/slug）`);
  const { member, def } = target;

  // ref 校验 fail-fast（零写库）：全部非法项聚合成一条中文错误
  const invalid: string[] = [];
  const toolLike = [...add.tools, ...remove.tools, ...add.pluginTools, ...remove.pluginTools];
  if (toolLike.length > 0) {
    // 动态 import：known-tool-names 静态链牵 plugin 装配目录，沿本文件 runtime 边界动态纪律
    const { collectKnownToolNames } = await import('./known-tool-names');
    const known = collectKnownToolNames(workspaceId);
    for (const t of [...add.tools, ...remove.tools]) if (!known.has(t)) invalid.push(`tool=${t}`);
    for (const p of [...add.pluginTools, ...remove.pluginTools]) if (!known.has(p)) invalid.push(`pluginTool=${p}`);
  }
  if (add.skills.length + remove.skills.length > 0) {
    const slugs = new Set(listInstalledSkills().map((s) => s.slug));
    for (const s of [...add.skills, ...remove.skills]) if (!slugs.has(s)) invalid.push(`skill=${s}`);
  }
  if (add.mcps.length + remove.mcps.length > 0) {
    const names = new Set(listRegistered().map((m) => m.name));
    for (const m of [...add.mcps, ...remove.mcps]) if (!names.has(m)) invalid.push(`mcp=${m}`);
  }
  if (invalid.length > 0) {
    throw new Error(`非法引用: ${invalid.join(', ')}（可先 resource_list 查询可用清单）`);
  }

  const otherWs = getDb()
    .prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM workspace_agent_members WHERE agent_definition_id = ? AND workspace_id != ?')
    .get(def.id, member.workspaceId) as { n: number };
  const changed = {
    adds: [...add.tools, ...add.mcps, ...add.skills, ...add.pluginTools],
    removes: [...remove.tools, ...remove.mcps, ...remove.skills, ...remove.pluginTools],
  };

  if (scope === 'definition') {
    if (def.source === 'builtin') {
      throw new Error('builtin 预设定义只读。给成员调整能力用默认 member scope 即可；改定义请在资源库 UI（自定义 agent）');
    }
    if (add.pluginTools.length + remove.pluginTools.length > 0) {
      throw new Error('definition scope 不支持 pluginTools（插件工具授权是成员级语义，请用默认 member scope）');
    }
    // 终态 = (def 现有 refs ∪ add) − remove；映射回 {kind,ref} 时既有条目保原形状
    const toolByRef = new Map(def.defaultTools.map((t) => [t.ref, t]));
    const mcpByRef = new Map(def.defaultMcps.map((m) => [m.ref, m]));
    const skillByRef = new Map(def.defaultSkills.map((s) => [s.ref, s]));
    const nextTools = subtract(union(def.defaultTools.map((t) => t.ref), add.tools), remove.tools);
    const nextMcps = subtract(union(def.defaultMcps.map((m) => m.ref), add.mcps), remove.mcps);
    const nextSkills = subtract(union(def.defaultSkills.map((s) => s.ref), add.skills), remove.skills);
    updateAgentDefinition({
      id: def.id,
      defaultTools: nextTools.map((r) => toolByRef.get(r) ?? { kind: 'builtin', ref: r }),
      defaultMcps: nextMcps.map((r) => mcpByRef.get(r) ?? { kind: 'mcp', ref: r }),
      defaultSkills: nextSkills.map((r) => skillByRef.get(r) ?? { kind: 'skill', ref: r }),
    });
    // 发起者自身若是该定义的运行成员：豁免停机（spec §8 绝不 mid-call 杀自己），
    // 回合结束后 respawn-on-idle 换芯；其它运行实例停机语义不变
    const stopped = await stopRunningInstancesByDefinition(def.id, { excludeInstanceId: ctx?.callerInstanceId });
    const effectiveFrom = await callerRespawnOnIdle(def.id, ctx);
    const defDenied = def.deniedTools ?? [];
    const result: UpdateCapabilitiesResult = {
      appliedTo: 'definition',
      changed,
      effective: {
        tools: nextTools,
        mcps: nextMcps,
        skills: nextSkills,
        deniedTools: defDenied,
        grantedPlugin: nextTools.filter((r) => r.startsWith('plugin:') && !toolRefMatches(r, defDenied)),
      },
      stoppedInstances: stopped.length,
      otherWorkspaceMembers: otherWs.n,
      ...(effectiveFrom !== undefined && { effectiveFrom }),
    };
    if (a['restart'] !== undefined) {
      result.notice = 'definition 分支 stop-only：restart 参数已忽略（其它运行实例保持停止态，下次派发自然拉起新配置）'
        + (effectiveFrom !== undefined ? '；发起者自身豁免停机，回合结束后自动换芯' : '');
    }
    return result;
  }

  // member 分支：基线 = def ∪ ws allocation；现状 = 三层合并后的生效面（读面同链）
  const alloc = readAllocationLayer(member.workspaceId);
  const oldDeltas = readAssignmentDeltas(member.instanceId);
  const merged = mergeCapabilities(def, alloc, oldDeltas);
  const baseGrantedPlugin = pluginGrantBaseline(def, alloc.tools);
  const grantedPlugin = pluginGrantedFrom(merged, oldDeltas.addedPluginTools);
  const newDeltas = applyCapabilityDelta(
    {
      tools: union(def.defaultTools.map((t) => t.ref), alloc.tools),
      mcps: union(def.defaultMcps.map((m) => m.ref), alloc.mcps),
      skills: union(def.defaultSkills.map((s) => s.ref), alloc.skills),
      baseGrantedPlugin,
    },
    { tools: merged.tools, mcps: merged.mcps, skills: merged.skills, grantedPlugin },
    { add, remove },
  );
  setAssignmentDeltas(member.instanceId, newDeltas);

  // 写后重算生效面（Layer 3 已换新 deltas——与 describeAgent 读面同口径）
  const mergedAfter = mergeCapabilities(def, alloc, newDeltas);
  const grantedAfter = pluginGrantedFrom(mergedAfter, newDeltas.addedPluginTools);

  // restart 三行接线（spec §8，仅 member 分支）
  let restarted: boolean | undefined;
  let needsRestart: boolean | undefined;
  let effectiveFrom: 'next-turn' | undefined;
  if (restart === 'deferred') {
    needsRestart = true;
  } else if (ctx?.callerInstanceId === member.instanceId) {
    // 自改：绝不 mid-call 杀自己——登记回合后 respawn-on-idle
    const { requestRespawnAfterIdle } = await import('./runtime-registry');
    requestRespawnAfterIdle(member.instanceId);
    effectiveFrom = 'next-turn';
  } else if (isAgentRunning(member.instanceId)) {
    // 他人在跑：stop + 立即拉起（新配置下次回合生效）。动态 import 打破
    // runtime-registry → runtime-spawner → resource-ops-bridge → 本模块 回环
    const { stopAgentRuntime } = await import('./runtime-registry');
    await stopAgentRuntime(member.instanceId);
    const { ensureMemberRuntime } = await import('./start-chain');
    await ensureMemberRuntime(member.instanceId);
    restarted = true;
  } else {
    needsRestart = false;
  }

  logger.info('会话内更新成员能力', { instanceId: member.instanceId, defId: def.id, appliedTo: 'member' });
  return {
    appliedTo: 'member',
    changed,
    effective: {
      tools: mergedAfter.tools,
      mcps: mergedAfter.mcps,
      skills: mergedAfter.skills,
      deniedTools: mergedAfter.deniedTools,
      grantedPlugin: grantedAfter,
    },
    ...(restarted !== undefined && { restarted }),
    ...(needsRestart !== undefined && { needsRestart }),
    ...(effectiveFrom !== undefined && { effectiveFrom }),
    otherWorkspaceMembers: otherWs.n,
  };
}

// ── updateProfile（写面，spec §5.3——定义档案/模型绑定/禁用串整列覆盖；
//    builtin 只读保护；写后恒 stop-only，无 restart 接线故不需要 ctx）──

/** update_profile 返回（definition=写后读回行；stoppedInstances=停机实例数） */
export interface UpdateProfileResult {
  definition: AgentDefinition;
  stoppedInstances: number;
  /** 发起者自身是该定义的运行成员时出现：豁免停机，回合结束后 respawn-on-idle 换芯 */
  effectiveFrom?: 'next-turn';
}

async function opUpdateProfile(a: Record<string, unknown>, workspaceId: string, ctx?: OpContext): Promise<UpdateProfileResult> {
  const key = str(a['agent'], 'agent');
  const target = resolveAgentTarget(key, workspaceId);
  if (!target) throw new Error(`未找到 agent 成员: ${key}（可先 resource_list 查询真实 instanceId/slug）`);
  const { def } = target;
  if (def.source === 'builtin') {
    throw new Error('builtin 预设定义只读。给成员调整能力请用 update_agent_capabilities（默认 member scope）；改定义请在资源库 UI（自定义 agent）');
  }

  // 形状先验：可选字段出现即须为字符串（undefined=不改，透传 updateAgentDefinition 同语义）
  const name = a['name'] === undefined ? undefined : str(a['name'], 'name');
  const description = a['description'] === undefined ? undefined : str(a['description'], 'description');
  const systemPrompt = a['systemPrompt'] === undefined ? undefined : str(a['systemPrompt'], 'systemPrompt');
  const iconEmoji = a['iconEmoji'] === undefined ? undefined : str(a['iconEmoji'], 'iconEmoji');
  const deniedTools = a['deniedTools'] === undefined ? undefined : strArray(a['deniedTools'], 'deniedTools');

  // model 块：出现即整体生效——providerId 必非空且须存在（友好报错优于 FK 中止，opCreateAgent 同口径）
  let modelProviderId: string | undefined;
  let modelName: string | undefined;
  if (a['model'] !== undefined) {
    if (typeof a['model'] !== 'object' || a['model'] === null || Array.isArray(a['model'])) {
      throw new Error('model 必须为 { providerId, modelName } 对象');
    }
    const m = a['model'] as Record<string, unknown>;
    modelProviderId = str(m['providerId'], 'model.providerId');
    modelName = str(m['modelName'], 'model.modelName');
    if (!getProvider(modelProviderId)) throw new Error(`供应商不存在: ${modelProviderId}`);
  }

  const updated = updateAgentDefinition({
    id: def.id,
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(iconEmoji !== undefined && { iconEmoji }),
    ...(modelProviderId !== undefined && { modelProviderId }),
    ...(modelName !== undefined && { modelName }),
    ...(deniedTools !== undefined && { deniedTools }),
  });
  // 发起者自身若是该定义的运行成员：豁免停机（spec §8），回合后 respawn-on-idle 换芯
  const stopped = await stopRunningInstancesByDefinition(def.id, { excludeInstanceId: ctx?.callerInstanceId });
  const effectiveFrom = await callerRespawnOnIdle(def.id, ctx);
  logger.info('会话内更新 agent 档案', { defId: def.id, stopped: stopped.length });
  return { definition: updated, stoppedInstances: stopped.length, ...(effectiveFrom !== undefined && { effectiveFrom }) };
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

// ── updateSkill（写面，spec 2026-11-12 §5.4——仅 custom 源可更新；全部校验
//    （含 references 越界）先于任何写盘，错误路径零部分写、旧内容原样保留。
//    references 省略 = 只换 SKILL.md，附属文件原样保留（undefined=不改，对齐
//    工具描述承诺与 updateProfile 先例）；显式提供（含 []）= 全量替换，[] 即
//    有意清空。引用面计数跨 workspace 全量：def.default_skills ∪ 成员 delta add 行）──

/** update_skill 返回（agentsUsingIt=引用该 skill 的成员数，任意 workspace；
 *  refCount=references 提供时为其长度、省略时为实际保留的附属文件数；
 *  needsRestart 据 agentsUsingIt 推导） */
export interface UpdateSkillResult {
  slug: string;
  name: string;
  refCount: number;
  agentsUsingIt: number;
  needsRestart: boolean;
}

/** 引用面成员计数：def.default_skills JSON 含该 slug 的成员 ∪ delta add 行
 *  （capability_type='skill' AND mode='add'）的成员。LIKE 初筛 + JS 精确解析复核
 *  ——防 substring 误报（slug="skill" 不得命中 "my-skill"）；delta 侧 ref 精确等值。 */
function countSkillMembers(slug: string): number {
  const likeRows = getDb()
    .prepare(
      `SELECT m.instance_id AS instance_id, d.default_skills AS default_skills
       FROM workspace_agent_members m
       JOIN agent_definitions d ON d.id = m.agent_definition_id
       WHERE d.default_skills LIKE ?`,
    )
    .all(`%"${slug}"%`) as Array<{ instance_id: string; default_skills: string }>;
  const ids = new Set<string>();
  for (const row of likeRows) {
    try {
      const skills: unknown = JSON.parse(row.default_skills ?? '[]');
      if (Array.isArray(skills) && skills.some((s) => (s as { ref?: unknown })?.ref === slug)) {
        ids.add(row.instance_id);
      }
    } catch {
      // 非法 JSON 行不计入（与能力合并层解析失败容忍同口径）
    }
  }
  const deltaRows = getDb()
    .prepare(
      `SELECT m.instance_id AS instance_id
       FROM agent_assignment_capabilities c
       JOIN workspace_agent_members m ON m.instance_id = c.assignment_id
       WHERE c.capability_type = 'skill' AND c.mode = 'add' AND c.ref = ?`,
    )
    .all(slug) as Array<{ instance_id: string }>;
  for (const row of deltaRows) ids.add(row.instance_id);
  return ids.size;
}

/** 递归统计 skill 目录附属文件数（排除 SKILL.md 与 .sha256 标记）——references
 *  省略分支 refCount 的诚实口径（反映实际保留现状） */
function countAttachmentFiles(dir: string): number {
  let n = 0;
  const walk = (p: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(p, e.name));
      else if (e.name !== 'SKILL.md' && e.name !== '.sha256') n += 1;
    }
  };
  walk(dir);
  return n;
}

function opUpdateSkill(a: Record<string, unknown>): UpdateSkillResult {
  const slug = str(a['slug'], 'slug');
  const skillMd = str(a['skillMd'], 'skillMd');
  if (!isValidSlug(slug)) throw new Error(`非法 slug: ${slug}`);
  // 省略 = 保留附属文件（undefined=不改）；显式提供（含 []）= 全量替换。
  // 形状先验：非数组值若放行会走全量替换分支 rmSync 清空全部附属文件（静默数据销毁）
  if (a['references'] !== undefined && !Array.isArray(a['references'])) {
    throw new Error('references 必须为数组（每项 {path, content}），省略则保留既有附属文件');
  }
  const refsProvided = a['references'] !== undefined;
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

  const dir = path.join(getSkillsDir(), slug);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`skill 不存在: ${slug}（新建请用 create_skill）`);
  }
  // .sha256 标记缺失 = builtin/marketplace 源——只读，引导用户去资源库 UI
  if (!fs.existsSync(path.join(dir, '.sha256'))) {
    throw new Error(`仅 custom 源技能可更新（请在 资源库 → 技能 管理: ${slug}）`);
  }
  const def = parseSkillMd(skillMd, dir); // name/description 必填校验（缺则抛）
  // 全部校验先于任何写盘——越界等错误路径零落盘（rm 在此之后，旧内容原样保留）
  const targets = refs.map((r) => safeJoin(dir, r.path));

  if (!refsProvided) {
    // 省略分支：只覆写 SKILL.md + 重算 .sha256，附属文件原样保留（目录不 rm）
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf-8');
    fs.writeFileSync(
      path.join(dir, '.sha256'),
      createHash('sha256').update(skillMd, 'utf-8').digest('hex'),
    );
    const agentsUsingIt = countSkillMembers(slug);
    logger.info('会话内更新 skill（保留附属文件）', { slug, agentsUsingIt });
    return {
      slug, name: def.name, refCount: countAttachmentFiles(dir),
      agentsUsingIt, needsRestart: agentsUsingIt > 0,
    };
  }

  // 全量替换分支：显式 references（含 [] = 有意清空）
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf-8');
  refs.forEach((r, i) => {
    fs.mkdirSync(path.dirname(targets[i]!), { recursive: true });
    fs.writeFileSync(targets[i]!, r.content, 'utf-8');
  });
  fs.writeFileSync(
    path.join(dir, '.sha256'),
    createHash('sha256').update(skillMd, 'utf-8').digest('hex'),
  );

  const agentsUsingIt = countSkillMembers(slug);
  logger.info('会话内更新 skill', { slug, agentsUsingIt });
  return { slug, name: def.name, refCount: refs.length, agentsUsingIt, needsRestart: agentsUsingIt > 0 };
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

// ── updateMcp（先测后落库，spec §5.5：复用 createMcp 的瞬态客户端连通验证，
//    失败零落库；落库走 updateMcpEntry——保 id/source/installed_at/config_schema，
//    连接参数变化时其内部驱逐池连接，下回合 getOrStartMcp 按新定义重建）──

async function opUpdateMcp(a: Record<string, unknown>, deps?: ResourceOpDeps): Promise<UpdateMcpResult> {
  const name = str(a['name'], 'name');
  // 存在性校验（listRegistered 同步读）。查无即指路 create_mcp，不静默新建；
  // 顺带取 id/version——瞬态客户端要 McpServerConfig 全形状，落库要保 version
  //（updateMcpEntryDefinition 对缺省 version 会重置为 '1.0.0'，不透传即降级）
  const existing = listRegistered().find((m) => m.name === name);
  if (!existing) throw new Error(`MCP 不存在: ${name}（新建请用 create_mcp）`);
  const raw = a['transport'];
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('transport 必须为 { kind: "stdio", command, args?, env?, cwd? } 或 { kind: "http", url, headers? }');
  }
  const t = raw as Record<string, unknown>;
  const kind = t['kind'];
  if (kind !== 'stdio' && kind !== 'http') {
    throw new Error('transport 必须为 { kind: "stdio", command, args?, env?, cwd? } 或 { kind: "http", url, headers? }');
  }

  // 配置形状：逐字段对齐 opCreateMcp 同款先验（id/version 取现存行——客户端不
  // 消费，仅为满足 McpServerConfig 形状；http 形态 command 空串占位，DB 列 NOT NULL）
  let config: McpServerConfig;
  if (kind === 'stdio') {
    config = {
      id: existing.id,
      name,
      version: existing.version,
      transport: 'stdio',
      command: str(t['command'], 'transport.command'),
      args: t['args'] === undefined ? [] : strArray(t['args'], 'transport.args'),
      env: optStrMap(t['env'], 'transport.env') ?? {},
      cwd: t['cwd'] === undefined ? undefined : str(t['cwd'], 'transport.cwd'),
    };
  } else {
    config = {
      id: existing.id,
      name,
      version: existing.version,
      transport: 'streamable_http',
      command: '',
      args: [],
      url: str(t['url'], 'transport.url'),
      headers: optStrMap(t['headers'], 'transport.headers') ?? {},
    };
  }
  const input: McpEntryUpdateInput = {
    transport: config.transport,
    version: config.version,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    url: config.url,
    headers: config.headers,
  };

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
    // R14：OAuth 挑战例外（判定口径与 opCreateMcp / host-manager getOrStartMcp
    // 一致——401/403 的 McpHttpError 即「服务器要求授权」）。与 create 场景的
    // 差异：新配置本就是要写入库的值，照常落库（已更新但未连接），返回引导而非报错
    if (err instanceof McpHttpError && (err.status === 401 || err.status === 403)) {
      await updateMcpEntry(name, input);
      logger.info('会话内更新 MCP（已更新配置但未连接，待 OAuth 授权）', { name });
      return {
        name,
        toolCount: 0,
        toolNames: [],
        needsAuthorization: true,
        notice:
          `MCP ${name} 的新配置已保存，但连接时服务器要求 OAuth 授权，暂未连通（工具面为空）。` +
          '授权须由用户在应用内完成，agent 无法代为操作：请在 资源库 → MCP → ' +
          `${name} → 编辑，提交后点「去授权」完成认证。完成后即可直接使用，无需再次更新。`,
      };
    }
    throw err;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
  await updateMcpEntry(name, input);
  logger.info('会话内更新 MCP', { name, toolCount: toolNames.length });
  return { name, toolCount: toolNames.length, toolNames: toolNames.slice(0, 20) };
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
