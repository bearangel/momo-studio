// electron/src/main/agent/init-runtime.ts
//
// task-driven runtime 初始化——从 main/index.ts 抽取到独立模块。
//
// 抽取原因：
//   1. 便于单元/集成测试（避免 import index.ts 触发 app.whenReady 等重副作用）。
//   2. 关注点分离——index.ts 只负责 app 生命周期编排，不承载 runtime 遍历细节。
//
// 核心逻辑：
//   遍历所有 workspace 的 assignment，为每个 task_driven=1 且 enabled=1 且
//   last_running=1 的 agent 创建 WarmPool + AgentRunner → 预热 → 启动 RouterService。
//   - task_driven=1 但 last_running=0：跳过（用户主动下线意图，不自动恢复）。
//   - task_driven=0：跳过（走 v1 autoStartAgents，由 auth handler 登录流程触发）。
//
// 返回 RouterService 实例（供 main/index.ts 注入 sync-manager）；无 runner 时返回 null。

import { logger } from '../logger';
import { getDb } from '../storage/db';
import { listAssignments, getAgentDefinition } from './crud';
import { listWorkspaces } from '../workspace/crud';
import { resolveBotToken } from './auto-start';
import {
  agentRunners,
  providerBuckets,
  createTaskDrivenRuntime,
  populateProviderBuckets,
} from './runtime-registry';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import { RouterService } from './router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from '../task/dispatcher';
import type { AgentRole } from './types';

/**
 * task-driven runtime 初始化：遍历所有 workspace 的 assignment，
 * 为每个 task_driven=1 且 enabled=1 且 last_running=1 的 agent 创建 WarmPool +
 * AgentRunner → 预热 → 启动 RouterService。
 *
 * 过滤层级（全部 AND）：
 *   1. agentRunners 已存在 → 跳过（幂等）
 *   2. assignment.enabled === false → 跳过
 *   3. assignment.lastRunning === false → 跳过（Task 5 核心：用户主动下线意图）
 *   4. def 不存在 → 跳过
 *   5. def.taskDriven === false → 跳过（v1 路径处理）
 *   6. def.modelProviderId 为空 → 跳过（未配置 provider）
 *
 * @returns RouterService 实例（至少一个 runner 注册时）；否则 null
 */
export async function initTaskDrivenRuntime(): Promise<RouterService | null> {
  for (const ws of listWorkspaces()) {
    for (const assignment of listAssignments(ws.id)) {
      if (agentRunners.has(assignment.instanceId)) continue;
      if (!assignment.enabled) continue;
      if (!assignment.lastRunning) continue; // ← Task 5：仅恢复用户意图为「在线」的 agent
      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) continue;
      if (def.taskDriven === false) continue;
      if (!def.modelProviderId) {
        logger.warn('Agent 未配置 modelProviderId，跳过 task-driven 初始化', {
          instanceId: assignment.instanceId, slug: def.slug,
        });
        continue;
      }

      try {
        const botAccessToken = await resolveBotToken(assignment.botMatrixUserId);
        if (!botAccessToken) {
          logger.warn('Bot token 丢失，跳过', { instanceId: assignment.instanceId });
          continue;
        }
        const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

        const runtimeConfig = buildSpawnOpts({
          instanceId: assignment.instanceId,
          botUserId: assignment.botMatrixUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directoryPath,
          teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
          ownerUserId: ws.ownerId,
          def,
          botAccessToken,
          llmApiKey,
          role: assignment.role as AgentRole,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === assignment.instanceId,
        });

        const pool = createTaskDrivenRuntime(runtimeConfig);

        await pool.warm(assignment.instanceId).catch((err) => {
          logger.warn('WarmPool 预热失败', {
            instanceId: assignment.instanceId, error: String(err),
          });
        });

        logger.info('task-driven agent 已初始化', {
          slug: def.slug, instanceId: assignment.instanceId, role: assignment.role,
        });
      } catch (err) {
        logger.warn('task-driven agent 初始化失败', {
          instanceId: assignment.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (agentRunners.size === 0) {
    logger.info('无 task-driven agent，跳过 RouterService 初始化');
    return null;
  }

  populateProviderBuckets();

  const dispatcher = new TaskDispatcher({
    runners: agentRunners,
    buckets: providerBuckets,
    getAgentAssignment: (instanceId) => getAssignmentInfo(instanceId),
    getGlobalMax: () => getGlobalMax(),
  });

  const routerService = new RouterService({ runners: agentRunners, dispatcher });
  routerService.start();
  logger.info('RouterService 已启动', { runnerCount: agentRunners.size });
  return routerService;
}

/**
 * 按 instanceId 查 assignment 的调度元数据（供 TaskDispatcher 并发控制）。
 * model_provider_id 为空时返回 null（agent 未配置 provider，不参与 task 调度）。
 */
function getAssignmentInfo(instanceId: string): AgentAssignmentInfo | null {
  const row = getDb().prepare(
    `SELECT a.agent_definition_id, d.model_provider_id, d.max_concurrent_tasks
     FROM agent_assignments a
     JOIN agent_definitions d ON a.agent_definition_id = d.id
     WHERE a.instance_id = ?`,
  ).get(instanceId) as
    | { agent_definition_id: string; model_provider_id: string | null; max_concurrent_tasks: number }
    | undefined;
  if (!row?.model_provider_id) return null;
  return {
    agentDefinitionId: row.agent_definition_id,
    modelProviderId: row.model_provider_id,
    maxConcurrentTasks: row.max_concurrent_tasks,
  };
}

/**
 * 读取全局并发上限（global_settings 表）。表不存在该行时默认 3。
 */
function getGlobalMax(): number {
  const row = getDb().prepare(
    'SELECT max_concurrent_tasks FROM global_settings WHERE id = 1',
  ).get() as { max_concurrent_tasks: number } | undefined;
  return row?.max_concurrent_tasks ?? 3;
}
