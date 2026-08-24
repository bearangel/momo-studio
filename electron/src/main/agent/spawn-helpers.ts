// electron/src/main/agent/spawn-helpers.ts
//
// Agent spawn 共享逻辑：rebuildSubAgents + resolveApiKey + buildSpawnOpts。
// 把多个 spawn 站点（assignMainAgent / agent:start / restartCoordinatorInstance /
// initTaskDrivenRuntime）共用的 subAgents 重建 + apiKey 解析 + opts 构建逻辑
// 集中到一处，避免 main agent 在某条重启路径上丢失 dispatch 工具（C1 修复）。
//
// v1.3 改造要点：
//   - subAgents 来源改为按 assignment.parent_instance_id 查询（不再读 def.parentAgentId）
//   - apiKey 解析：override ?? provider key（spawn 前主进程解析，传给子进程）
//   - role 来自 assignment（不再从 def.type 推断）
//   - modelBaseUrl 来自 provider.baseUrl（spawn 前查 model_providers 表）
// v2（Task 10）：opts 携带本地身份（agentUserId/teamSessionId），不再传 Matrix 凭据；
//   原 HOMESERVER_URL 常量随 bot token 流程一并移除。

import path from 'node:path';
import { getAgentDefinition, listSubAssignments } from './crud';
import {
  mergeCapabilities,
  readAllocationLayer,
  readAssignmentDeltas,
} from './capability-merger';
import { resolveSkillsDir } from '../paths';
import { getProvider } from './provider-crud';
import { getSecret } from '../storage/keychain';
import type { AgentDefinition, AgentRole } from './types';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import type { AgentRuntimeOpts } from './runtime-config';

/**
 * 为指定 workspace 内的 main assignment 重建 subAgents 引用。
 * v1.3：按 assignment.parent_instance_id 查询同 ws 的 role='sub' assignments，
 * 不再读 def.parentAgentId（已删除）。
 *
 * @param workspaceId 目标 workspace
 * @param mainInstanceId main assignment 的 instanceId
 * v2（Task 10）：引用携带 assignmentId（dispatch 路由键），不再携带 Matrix userId。
 *
 * @returns sub agent 引用列表（slug + assignmentId + description）
 */
export function rebuildSubAgents(
  workspaceId: string,
  mainInstanceId: string,
): SubAgentRef[] {
  const subAssignments = listSubAssignments(workspaceId, mainInstanceId);
  const subs: SubAgentRef[] = [];
  for (const sub of subAssignments) {
    if (!sub.lastRunning) continue;  // v2 修复：仅启动的 sub 才在 dispatch 工具列表
    const subDef = getAgentDefinition(sub.agentDefinitionId);
    if (!subDef) continue;
    subs.push({
      slug: subDef.slug,
      assignmentId: sub.instanceId,
      description: subDef.description,
    });
  }
  return subs;
}

/**
 * 解析 assignment 启动用的 API key：
 * 1. 优先读 keychain 'agent.<instanceId>.api_key_override'
 * 2. fallback 到 'provider.<providerId>.api_key'
 * 3. 都没有则抛错（提示用户检查供应商设置）
 */
export async function resolveApiKey(
  instanceId: string,
  providerId: string,
): Promise<string> {
  const override = await getSecret(`agent.${instanceId}.api_key_override`);
  if (override) return override;
  const providerKey = await getSecret(`provider.${providerId}.api_key`);
  if (!providerKey) {
    throw new Error(`供应商 API key 丢失，请检查设置 → 供应商（providerId=${providerId}）`);
  }
  return providerKey;
}

/**
 * 把 skill slug 列表解析成子进程可用的 RuntimeSkillRef。
 * cachePath 按 <userData>/skills/<slug> 约定解析；skill 包尚未安装时该路径可能不存在，
 * 子进程 SkillRegistry.register 会抛错并被 try/catch 跳过（不阻塞 agent 上线）。
 */
export function resolveSkillSlugs(slugs: string[]): RuntimeSkillRef[] {
  const skillsDir = resolveSkillsDir();
  return slugs.map((slug) => ({ slug, cachePath: path.join(skillsDir, slug) }));
}

/** buildSpawnOpts 的入参（v2 Task 10：本地身份形状，无 Matrix 凭据） */
export interface BuildSpawnOptsInput {
  instanceId: string;
  /** agent 本地身份（agent_assignments.agent_user_id） */
  agentUserId: string;
  workspaceId: string;
  workspaceDir: string;
  /** 团队会话 ID（workspaces.team_session_id，sessions 表主键） */
  teamSessionId: string;
  def: AgentDefinition;
  /** 来自 assignment.role（v1.3：不再从 def.type 推断） */
  role: AgentRole;
  /** spawn 前主进程已解析的 LLM API key（override ?? provider key） */
  llmApiKey: string;
  isCoordinator: boolean;
}

/**
 * 构建完整的 AgentRuntimeOpts，供 spawnAgent 使用。
 *
 * v1.3 改造：
 *   1. role 来自 assignment（外部传入）；subAgents 按 main 的 instanceId 查同 ws subs；
 *   2. modelBaseUrl 来自 provider.baseUrl（v1.3 删 def.model.baseUrl）；
 *   3. AGENT_CONFIG 不再带 modelProvider；
 *   4. def.modelProviderId 必须非空（未配置时拒绝 spawn）。
 *
 * P3 Task 1：opts 同时透传 modelPlatform = provider.platform（v24 model_providers.platform 列），
 *   运行时 runChatLoop 据此显式塞给 createLLMProvider，覆盖 baseUrl 启发式。
 */
export function buildSpawnOpts(input: BuildSpawnOptsInput): AgentRuntimeOpts {
  const {
    instanceId,
    agentUserId,
    workspaceId,
    workspaceDir,
    teamSessionId,
    def,
    role,
    llmApiKey,
    isCoordinator,
  } = input;

  // 校验 def 已配置 provider
  if (!def.modelProviderId) {
    throw new Error(
      `agent 定义「${def.name}」未配置 modelProviderId，请到 Agent 库配置`,
    );
  }

  // 取 provider（baseUrl 供 REST 调用与启发式回退；platform 显式透传给 runtime）
  const provider = getProvider(def.modelProviderId);
  if (!provider) {
    throw new Error(`供应商不存在: ${def.modelProviderId}`);
  }

  // 为 main assignment 从 DB 重建 subAgents（C1：保证 dispatch 工具在所有重启路径可用）
  const subAgents: SubAgentRef[] =
    role === 'main' ? rebuildSubAgents(workspaceId, instanceId) : [];

  // 合并三层能力（Layer 1 def 默认 ∪ Layer 2 workspace allocation ∪/- Layer 3 per-assignment delta）
  // v1.6 修复：merged.tools 必须注入 opts.allowedTools。v1.5 此处丢弃 merged.tools，
  // 导致 RuntimeConfig.allowedTools 永远 undefined、permission.ts 全放行——所有 agent
  // 实际能用全部 24 个工具，与 def.defaultTools 配置完全无关（严重安全 bug）。
  const allocation = readAllocationLayer(workspaceId);
  const deltas = readAssignmentDeltas(instanceId);
  const merged = mergeCapabilities(def, allocation, deltas);

  return {
    instanceId,
    workspaceId,
    workspaceDir,
    agentAssignmentId: instanceId,
    agentUserId,
    teamSessionId,
    systemPrompt: def.systemPrompt,
    // P3 Task 1：modelPlatform 由 provider.platform 显式透传（v24 model_providers 列）。
    // runtime-entry runChatLoop 把此字段原样塞给 createLLMProvider 的 model.provider；
    // 非 anthropic.com 域名的 Anthropic 兼容供应商不再被 baseUrl 启发式误判为 openai。
    modelName: def.modelName,
    modelBaseUrl: provider.baseUrl,
    modelPlatform: provider.platform,
    llmApiKey,
    role,
    subAgents,
    // v1.6 修复：allowedTools 来自三层合并后的 merged.tools（非 undefined）
    allowedTools: merged.tools,
    skills: resolveSkillSlugs(merged.skills),
    mcpNames: merged.mcps,
    isCoordinator,
    // v1.4 嵌套：传 bot 展示信息，子 agent start chunk 据此填充 chip 头部
    botName: def.name,
    botAvatar: def.iconEmoji,
  };
}
