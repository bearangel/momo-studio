// electron/src/main/agent/spawn-helpers.ts
//
// Agent spawn 共享逻辑：buildDispatchSnapshot + resolveApiKey + buildSpawnOpts。
// 把多个 spawn 站点（agent:addMember / agent:start / restartDefaultAgentInstance /
// start-chain / initTaskDrivenRuntime）共用的 dispatch 快照 + apiKey 解析 +
// opts 构建逻辑集中到一处，保证各路径产出一致的 AGENT_CONFIG（C1 精神延续）。
//
// v1.3 改造要点：
//   - apiKey 解析：override ?? provider key（spawn 前主进程解析，传给子进程）
//   - role 来自 assignment（不再从 def.type 推断）
//   - modelBaseUrl 来自 provider.baseUrl（spawn 前查 model_providers 表）
// v25（Task 10）：subAgents/isLeader 改按 session_members 会话快照计算
//   （取代 v1 parent_instance_id 链查询，spec §4.7）；opts 携带本地身份
//   （agentUserId/teamSessionId），不再传 Matrix 凭据。

import path from 'node:path';
import {
  mergeCapabilities,
  readAllocationLayer,
  readAssignmentDeltas,
} from './capability-merger';
import { resolveSkillsDir } from '../paths';
import { getProvider } from './provider-crud';
import { getSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import type { AgentDefinition } from './types';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import type { AgentRuntimeOpts } from './runtime-config';

/** buildDispatchSnapshot 的产出：dispatch 注入条件 + subAgents 快照（spec §4.7） */
export interface DispatchSnapshot {
  /** 本实例是否为至少一个「有效成员数 > 1」会话的 leader（dispatch 注入条件） */
  isLeader: boolean;
  /** subAgents：上述会话的成员快照除自己（跨会话并集，按实例与 slug 去重） */
  subAgents: SubAgentRef[];
}

/** 快照查询的扁平行：会话内一个有效成员（含自己）对应一行 */
interface SnapshotRow {
  session_id: string;
  instance_id: string;
  slug: string;
  description: string;
}

/**
 * 会话快照判定（v25 Task 10，spec §4.7）：取代 v1 的 role==='main' +
 * assignment.parent_instance_id 链查询。
 *
 * 语义：
 *   1. dispatch 注入条件 = 「会话有效成员数 > 1 且自己是 is_leader」
 *      （is_leader 为建会时快照列，spec §3.3；单 agent / 快速会话唯一成员
 *      即自己 → 成员数 1 → 不注入）
 *   2. subAgents = 命中会话的成员快照除自己；实例在多个命中会话时取并集，
 *      按 instance_id 去重；同 def 两实例（slug 相同，dispatch:<slug> 工具名
 *      冲突）按 added_at 序先到先得
 *   3. 有效性过滤：JOIN workspace_agent_members + agent_definitions——被移出
 *      workspace 的成员（FK 级联通常已清行，防御历史残留）不计入成员数，
 *      也不进 subAgents
 *   4. 按 sessions.workspace_id 限定本 workspace，跨 ws 会话不串位
 *
 * 快照时点：spawn 时一次性计算并随 AGENT_CONFIG 定型；之后成员变化不影响
 * 已 spawn 的配置（下一次 spawn 才重算）。不按 last_running 过滤——spec §4.6
 * 接待路由对离线目标自动拉起，离线成员可被 dispatch。
 *
 * @param workspaceId 目标 workspace（会话归属过滤）
 * @param instanceId 被判定的成员实例
 */
export function buildDispatchSnapshot(
  workspaceId: string,
  instanceId: string,
): DispatchSnapshot {
  const rows = getDb()
    .prepare(
      `SELECT m.session_id, m.instance_id, d.slug, d.description
       FROM session_members m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspace_agent_members a ON a.instance_id = m.instance_id
       JOIN agent_definitions d ON d.id = a.agent_definition_id
       WHERE s.workspace_id = ?
         AND m.session_id IN (
           SELECT session_id FROM session_members WHERE instance_id = ? AND is_leader = 1
         )
       ORDER BY m.added_at ASC`,
    )
    .all(workspaceId, instanceId) as SnapshotRow[];

  // 按会话分组：有效成员数 > 1 的 leader 会话才命中
  const bySession = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const group = bySession.get(row.session_id);
    if (group) group.push(row);
    else bySession.set(row.session_id, [row]);
  }

  const subAgents: SubAgentRef[] = [];
  const seenInstanceIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let isLeader = false;
  for (const group of bySession.values()) {
    if (group.length <= 1) continue; // 有效成员数 1（仅自己）→ 不算多成员会话
    isLeader = true;
    for (const member of group) {
      if (member.instance_id === instanceId) continue;
      if (seenInstanceIds.has(member.instance_id)) continue;
      if (seenSlugs.has(member.slug)) continue; // dispatch:<slug> 工具名冲突防线
      seenInstanceIds.add(member.instance_id);
      seenSlugs.add(member.slug);
      subAgents.push({
        slug: member.slug,
        assignmentId: member.instance_id,
        description: member.description,
      });
    }
  }
  return { isLeader, subAgents };
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
  /** agent 本地身份（workspace_agent_members.agent_user_id） */
  agentUserId: string;
  workspaceId: string;
  workspaceDir: string;
  /**
   * 团队会话 ID（sessions 表主键）。
   * v25 过渡态：workspaces.team_session_id 已退役，无团队会话可传时为空串；
   * AGENT_CONFIG 线协议字段保留（runtime 侧作 dispatch 目标会话兜底）。
   */
  teamSessionId: string;
  def: AgentDefinition;
  /**
   * v25 过渡态：assignment.role 已随去编排退役；缺省 'standalone'。
   * dispatch 注入不再看 role（v25 Task 10 起按会话快照判定，见 buildDispatchSnapshot）。
   */
  role?: AgentRuntimeOpts['role'];
  /** spawn 前主进程已解析的 LLM API key（override ?? provider key） */
  llmApiKey: string;
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
 * v25 Task 10：subAgents/isLeader 改由 buildDispatchSnapshot 会话快照计算
 *   （取代 v1 role==='main' + parent 链查询，spec §4.7）。
 */
export function buildSpawnOpts(input: BuildSpawnOptsInput): AgentRuntimeOpts {
  const {
    instanceId,
    agentUserId,
    workspaceId,
    workspaceDir,
    teamSessionId,
    def,
    llmApiKey,
    role = 'standalone',
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

  // 会话快照：dispatch 注入条件 + subAgents（spec §4.7；spawn 时点定型）
  const { isLeader, subAgents } = buildDispatchSnapshot(workspaceId, instanceId);

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
    isLeader,
    // v1.4 嵌套：传 bot 展示信息，子 agent start chunk 据此填充 chip 头部
    botName: def.name,
    botAvatar: def.iconEmoji,
  };
}
