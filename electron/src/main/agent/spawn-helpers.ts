// electron/src/main/agent/spawn-helpers.ts
//
// Agent spawn 共享逻辑：rebuildSubAgents + buildSpawnOpts。
// 把 4 个 spawn 站点（assignMainAgent / agent:start / autoStartAgents /
// restartCoordinatorInstance）共用的 subAgents 重建 + opts 构建逻辑集中到一处，
// 避免 main agent 在某条重启路径上丢失 dispatch 工具（C1 修复）。
//
// 设计要点：
//   - rebuildSubAgents 从 DB 的 definition.parentAgentId + assignment 关系重建
//     subAgents 引用，使 main agent 在任何重启路径（手动 agent:start、协调重启、
//     应用启动恢复）都能拿到完整的 dispatch:<slug> 工具集。
//   - buildSpawnOpts 统一构造 AgentRuntimeOpts，避免各站点字段遗漏（C1 根因）。

import path from 'node:path';
import { getAgentDefinition, listAssignments } from './crud';
import { getAllocation } from '../workspace/allocation';
import { mergeCapabilities } from './capability-merger';
import { resolveSkillsDir } from '../paths';
import type { AgentDefinition, AgentAssignment } from './types';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import type { AgentRuntimeOpts } from './runtime-manager';

/** Conduwuit 固定监听 8008（与 conduit/manager.ts 的 CONDUIT_PORT 一致）。 */
export const HOMESERVER_URL = 'http://127.0.0.1:8008';

/**
 * 为指定 workspace 内的 main agent 重建 subAgents 引用。
 * 遍历该 workspace 全部 assignment，找出 parentAgentId 指向该 main definition 的 sub assignment。
 *
 * @param workspaceId 目标 workspace
 * @param mainDefId main agent 定义 ID
 * @param wsAssignments 可选：调用方预取的 workspace assignments（避免重复查 DB）；不传则内部 listAssignments
 * @returns sub agent 引用列表（slug + botUserId + description）
 */
export function rebuildSubAgents(
  workspaceId: string,
  mainDefId: string,
  wsAssignments?: AgentAssignment[],
): SubAgentRef[] {
  const assignments = wsAssignments ?? listAssignments(workspaceId);
  const subs: SubAgentRef[] = [];
  for (const assignment of assignments) {
    if (assignment.instanceId === '') continue;
    const subDef = getAgentDefinition(assignment.agentDefinitionId);
    if (!subDef) continue;
    if (subDef.parentAgentId === mainDefId) {
      subs.push({
        slug: subDef.slug,
        botUserId: assignment.botMatrixUserId,
        description: subDef.description,
      });
    }
  }
  return subs;
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
  llmApiKey: string;
  isCoordinator: boolean;
}

/**
 * 构建完整的 AgentRuntimeOpts，供 spawnAgent 使用。
 *
 * 该函数是所有 spawn 站点的唯一 opts 构建入口，保证：
 *   1. main agent 的 subAgents 从 DB 重建（C1 核心修复：避免重启路径丢失 dispatch 工具）；
 *   2. 三层能力合并（def 默认 ∪ workspace allocation）一致应用；
 *   3. skills 解析逻辑统一（cachePath 约定一致）。
 *
 * 调用方只需提供已恢复的 token / apiKey + 基本 identity 字段，
 * 其余（subAgents / skills / mcps / homeserverUrl）由本函数内部推导。
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
    llmApiKey,
    isCoordinator,
  } = input;

  // 为 main agent 从 DB 重建 subAgents（C1：保证 dispatch 工具在所有重启路径可用）
  const subAgents: SubAgentRef[] =
    def.type === 'main' ? rebuildSubAgents(workspaceId, def.id) : [];

  // 合并三层能力（def 默认 ∪ workspace allocation）
  const allocation = getAllocation(workspaceId);
  const merged = mergeCapabilities(def, allocation);

  return {
    instanceId,
    workspaceId,
    workspaceDir,
    botUserId,
    botAccessToken,
    homeserverUrl: HOMESERVER_URL,
    systemPrompt: def.systemPrompt,
    modelProvider: def.model.provider,
    modelName: def.model.model,
    modelBaseUrl: def.model.baseUrl,
    llmApiKey,
    teamRoomId,
    ownerUserId,
    agentType: def.type,
    subAgents,
    skills: resolveSkillSlugs(merged.skills),
    mcpNames: merged.mcps,
    isCoordinator,
  };
}
