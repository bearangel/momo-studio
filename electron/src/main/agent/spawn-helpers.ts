// electron/src/main/agent/spawn-helpers.ts
//
// Agent spawn 共享逻辑：rebuildSubAgents + resolveApiKey + buildSpawnOpts。
// 把多个 spawn 站点（assignMainAgent / agent:start / autoStartAgents /
// restartCoordinatorInstance）共用的 subAgents 重建 + apiKey 解析 + opts 构建逻辑
// 集中到一处，避免 main agent 在某条重启路径上丢失 dispatch 工具（C1 修复）。
//
// v1.3 改造要点：
//   - subAgents 来源改为按 assignment.parent_instance_id 查询（不再读 def.parentAgentId）
//   - apiKey 解析：override ?? provider key（spawn 前主进程解析，传给子进程）
//   - role 来自 assignment（不再从 def.type 推断）
//   - modelBaseUrl 来自 provider.baseUrl（spawn 前查 model_providers 表）

import path from 'node:path';
import { getAgentDefinition, listAssignments, listSubAssignments } from './crud';
import { getAllocation } from '../workspace/allocation';
import { mergeCapabilities } from './capability-merger';
import { getAssignmentDeltas } from './assignment-capabilities';
import { resolveSkillsDir } from '../paths';
import { getProvider } from './provider-crud';
import { getSecret } from '../storage/keychain';
import type { AgentDefinition, AgentRole } from './types';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import type { AgentRuntimeOpts } from './runtime-manager';

/** Conduwuit 固定监听 8008（与 conduit/manager.ts 的 CONDUIT_PORT 一致）。 */
export const HOMESERVER_URL = 'http://127.0.0.1:8008';

/**
 * 为指定 workspace 内的 main assignment 重建 subAgents 引用。
 * v1.3：按 assignment.parent_instance_id 查询同 ws 的 role='sub' assignments，
 * 不再读 def.parentAgentId（已删除）。
 *
 * @param workspaceId 目标 workspace
 * @param mainInstanceId main assignment 的 instanceId
 * @returns sub agent 引用列表（slug + botUserId + description）
 */
export function rebuildSubAgents(
  workspaceId: string,
  mainInstanceId: string,
): SubAgentRef[] {
  const subAssignments = listSubAssignments(workspaceId, mainInstanceId);
  const subs: SubAgentRef[] = [];
  for (const sub of subAssignments) {
    const subDef = getAgentDefinition(sub.agentDefinitionId);
    if (!subDef) continue;
    subs.push({
      slug: subDef.slug,
      botUserId: sub.botMatrixUserId,
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

/** buildSpawnOpts 的入参 */
export interface BuildSpawnOptsInput {
  instanceId: string;
  botUserId: string;
  workspaceId: string;
  workspaceDir: string;
  teamRoomId: string;
  ownerUserId: string;
  def: AgentDefinition;
  botAccessToken: string;
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
 *   3. createLLMProvider 调用端按 baseUrl 自动检测 platform，AGENT_CONFIG 不再带 modelProvider；
 *   4. def.modelProviderId 必须非空（未配置时拒绝 spawn）。
 */
export function buildSpawnOpts(input: BuildSpawnOptsInput): AgentRuntimeOpts {
  const {
    instanceId,
    botUserId,
    workspaceId,
    workspaceDir,
    teamRoomId,
    ownerUserId,
    def,
    botAccessToken,
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

  // 取 provider baseUrl（runtime 据此自动检测 platform + 调对应 REST API）
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
  const allocation = getAllocation(workspaceId);
  const deltas = getAssignmentDeltas(instanceId);
  const merged = mergeCapabilities(def, allocation, deltas);

  return {
    instanceId,
    workspaceId,
    workspaceDir,
    botUserId,
    botAccessToken,
    homeserverUrl: HOMESERVER_URL,
    systemPrompt: def.systemPrompt,
    // v1.3：runtime 收到 modelName + modelBaseUrl + llmApiKey 即可，
    // createLLMProvider 按 baseUrl 自动检测 platform
    modelName: def.modelName,
    modelBaseUrl: provider.baseUrl,
    llmApiKey,
    teamRoomId,
    ownerUserId,
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
