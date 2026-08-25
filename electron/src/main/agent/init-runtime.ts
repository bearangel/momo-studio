// electron/src/main/agent/init-runtime.ts
//
// task-driven runtime 初始化——从 main/index.ts 抽取到独立模块。
//
// 抽取原因：
//   1. 便于单元/集成测试（避免 import index.ts 触发 app.whenReady 等重副作用）。
//   2. 关注点分离——index.ts 只负责 app 生命周期编排，不承载 runtime 遍历细节。
//
// 核心逻辑：
//   遍历所有 workspace 的 assignment，为每个 enabled=1 且 last_running=1 的
//   agent 创建 WarmPool + AgentRunner → 预热 → 经 router-bootstrap 统一入口
//   ensureRouterService 启动 RouterService。
//   last_running=0：跳过（用户主动下线意图，不自动恢复）。
//
// 启动 RouterService 由 router-bootstrap 内部完成（setRouterService 调用同步发生）；
// 本函数返回 void，调用方无需拿到 RouterService 实例。

import { logger } from '../logger';
import { listAssignments, getAgentDefinition } from './crud';
import { listWorkspaces } from '../workspace/crud';
import {
  agentRunners,
  createTaskDrivenRuntime,
  populateProviderBuckets,
} from './runtime-registry';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import type { AgentRole } from './types';

/**
 * task-driven runtime 初始化：遍历所有 workspace 的 assignment，
 * 为每个 task_driven=1 且 enabled=1 且 last_running=1 的 agent 创建 WarmPool +
 * AgentRunner → 预热 → 触发 RouterService 统一 lazy 启动入口。
 *
 * 过滤层级（全部 AND）：
 *   1. agentRunners 已存在 → 跳过（幂等）
 *   2. assignment.enabled === false → 跳过
 *   3. assignment.lastRunning === false → 跳过（Task 5 核心：用户主动下线意图）
 *   4. def 不存在 → 跳过
 *   5. def.modelProviderId 为空 → 跳过（未配置 provider）
 */
export async function initTaskDrivenRuntime(): Promise<void> {
  for (const ws of listWorkspaces()) {
    for (const assignment of listAssignments(ws.id)) {
      if (agentRunners.has(assignment.instanceId)) continue;
      if (!assignment.enabled) continue;
      if (!assignment.lastRunning) continue; // ← Task 5：仅恢复用户意图为「在线」的 agent
      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) continue;
      if (!def.modelProviderId) {
        logger.warn('Agent 未配置 modelProviderId，跳过 task-driven 初始化', {
          instanceId: assignment.instanceId, slug: def.slug,
        });
        continue;
      }

      try {
        // v2（Task 10）：agent 无 Matrix 凭据，仅需解析 LLM API key
        const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

        const runtimeConfig = buildSpawnOpts({
          instanceId: assignment.instanceId,
          agentUserId: assignment.agentUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directoryPath,
          teamSessionId: ws.teamSessionId ?? '',
          def,
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
    return;
  }

  populateProviderBuckets();

  // v2 修复：使用 router-bootstrap 统一 lazy 启动入口（替代手动创建 RouterService + 注入）。
  // ensureRouterService 内部已做 null 检查 + 幂等，重复调用 no-op（Task 5 起注入
  // 目标为 internal-event-bridge 的 setBridgeRouter）。动态 import 避开
  // router-bootstrap → router-service → runtime-registry 顶层循环依赖。
  const { ensureRouterService } = await import('./router-bootstrap');
  // v2.0.1（spec §9）：dispatcher pickup 链路砍除后 ensureRouterService 只收 runners
  await ensureRouterService(agentRunners);
  logger.info('initTaskDrivenRuntime 完成', { runnerCount: agentRunners.size });
}
