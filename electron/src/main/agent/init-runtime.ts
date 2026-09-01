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
import { listMembers, getAgentDefinition } from './crud';
import { listWorkspaces } from '../workspace/crud';
import {
  agentRunners,
  createTaskDrivenRuntime,
  populateProviderBuckets,
} from './runtime-registry';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';

/**
 * task-driven runtime 初始化：遍历所有 workspace 的成员，
 * 为每个 last_running=1 的 agent 创建 WarmPool + AgentRunner → 预热 →
 * 触发 RouterService 统一 lazy 启动入口。
 *
 * 过滤层级（全部 AND）：
 *   1. agentRunners 已存在 → 跳过（幂等）
 *   2. member.lastRunning === false → 跳过（用户主动下线意图，不自动恢复）
 *   3. def 不存在 → 跳过
 *   4. def.modelProviderId 为空 → 跳过（未配置 provider）
 */
export async function initTaskDrivenRuntime(): Promise<void> {
  for (const ws of listWorkspaces()) {
    for (const member of listMembers(ws.id)) {
      if (agentRunners.has(member.instanceId)) continue;
      if (!member.lastRunning) continue; // ← 仅恢复用户意图为「在线」的 agent
      const def = getAgentDefinition(member.agentDefinitionId);
      if (!def) continue;
      if (!def.modelProviderId) {
        logger.warn('Agent 未配置 modelProviderId，跳过 task-driven 初始化', {
          instanceId: member.instanceId, slug: def.slug,
        });
        continue;
      }

      try {
        // v2（Task 10）：agent 无 Matrix 凭据，仅需解析 LLM API key
        const llmApiKey = await resolveApiKey(member.instanceId, def.modelProviderId);

        const runtimeConfig = buildSpawnOpts({
          instanceId: member.instanceId,
          agentUserId: member.agentUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directoryPath,
          // v25 过渡态：workspaces.team_session_id 已退役，传空串保持线协议形状
          teamSessionId: '',
          def,
          llmApiKey,
        });

        const pool = createTaskDrivenRuntime(runtimeConfig);

        await pool.warm(member.instanceId).catch((err) => {
          logger.warn('WarmPool 预热失败', {
            instanceId: member.instanceId, error: String(err),
          });
        });

        logger.info('task-driven agent 已初始化', {
          slug: def.slug, instanceId: member.instanceId,
        });
      } catch (err) {
        logger.warn('task-driven agent 初始化失败', {
          instanceId: member.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  populateProviderBuckets();

  // v2 修复：使用 router-bootstrap 统一 lazy 启动入口（替代手动创建 RouterService + 注入）。
  // ensureRouterService 内部已做 null 检查 + 幂等，重复调用 no-op（Task 5 起注入
  // 目标为 internal-event-bridge 的 setBridgeRouter）。动态 import 避开
  // router-bootstrap → router-service → runtime-registry 顶层循环依赖。
  // Task 9 修复：零 runner 也启动——router 携带 ensureRunner 自动拉起能力，
  // 用户停掉全部 agent 后重启的会话消息仍可经接待路由拉起派发。
  const { ensureRouterService } = await import('./router-bootstrap');
  // v2.0.1（spec §9）：dispatcher pickup 链路砍除后 ensureRouterService 只收 runners
  await ensureRouterService(agentRunners);
  logger.info('initTaskDrivenRuntime 完成', { runnerCount: agentRunners.size });
}
