// electron/src/main/agent/auto-start.ts
//
// 应用启动时自动恢复已分配的 agent（v1 fallback 路径）。
//
// task-driven 架构（T7 改造）：
//   - task_driven=1 的 agent 由 main/index.ts 的 initTaskDrivenRuntime 接管
//     （创建 WarmPool + AgentRunner + 预热 + 启动 RouterService）。
//   - task_driven=0 的 agent 仍走本函数的 v1 spawn 路径（长期运行子进程）。
//   - auth 登录流程也调 autoStartAgents——在 task-driven 模式下，
//     initTaskDrivenRuntime 已在 autoRestoreSession 中先于 autoStartAgents 调用，
//     task_driven=1 的 agent 已在 agentRunners/agentWarmPools 中，本函数的
//     isV1SubprocessAlive 仅查 v1 runtimes Map（与 task-driven 路径解耦）；
//     task-driven agent 由下方的 def.taskDriven !== false 守卫跳过。
//
// v1.3 改造：
//   - role 来自 assignment（不再从 def.type 推断）
//   - subAgents 由 buildSpawnOpts 按 assignment.parent_instance_id 重建
//   - apiKey 解析走 resolveApiKey（override ?? provider key）；def.modelProviderId=NULL 时跳过
//   - 老的 llmApiKeyRef keychain key 仅作 fallback（向后兼容）

import { getDb } from '../storage/db';
import { spawnAgent, isV1SubprocessAlive } from './runtime-manager';
import { getAgentDefinition, listSubAssignments } from './crud';
import { getWorkspace } from '../workspace/crud';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import { logger } from '../logger';
import type { AgentRole } from './types';

interface AssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_user_id: string;
  enabled: number;
  /** v1.5.8：用户最近运行意图（1=运行 / 0=主动下线） */
  last_running: number;
  role: string;
}

/**
 * v1 自动启动入口。
 *
 * 行为：
 *   - 查询 enabled=1 AND last_running=1 的 assignment
 *   - 对每个：
 *     - def.taskDriven !== false → 跳过（v2 修复：由 initTaskDrivenRuntime 接管）
 *     - def.taskDriven === false → 走 v1 spawnAgent 路径
 *
 * v2 架构下：
 *   - task-driven agent 的注册 + WarmPool 预热由 initTaskDrivenRuntime 完成（init-runtime.ts 独立模块）
 *   - 本函数仅作为 v1 fallback 路径保留（task_driven=0 的 agent）
 *   - isAgentRunning 现查询 DB last_running（不再查 runtimes Map）
 *   - isV1SubprocessAlive 用于 v1 重复 spawn 防护（auto-start.ts 内部）
 *
 * v1.5.8：保留原 token 验证 + 失效 re-login 流程
 */
export async function autoStartAgents(): Promise<void> {
  const db = getDb();
  // v1.5.8：只启动 enabled=1（assignment 存在）AND last_running=1（用户未主动下线）的 agent
  const rows = db
    .prepare('SELECT * FROM agent_assignments WHERE enabled = 1 AND last_running = 1')
    .all() as AssignmentRow[];
  if (rows.length === 0) {
    logger.info('没有需要自启动的 agent');
    return;
  }

  let started = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isV1SubprocessAlive(row.instance_id)) continue;

    try {
      const def = getAgentDefinition(row.agent_definition_id);
      if (!def) {
        logger.warn('Agent 定义不存在，跳过', { defId: row.agent_definition_id });
        failed++;
        continue;
      }

      // T7：task_driven=1 的 agent 由 initTaskDrivenRuntime 接管，跳过 v1 spawn
      if (def.taskDriven !== false) {
        skipped++;
        continue;
      }

      // v1.3：def 未配置 provider 时跳过（强制用户重配）
      if (!def.modelProviderId) {
        logger.warn('Agent 定义未配置 modelProviderId，跳过自启动', {
          slug: def.slug, instanceId: row.instance_id,
        });
        skipped++;
        continue;
      }

      const ws = getWorkspace(row.workspace_id);
      if (!ws) {
        logger.warn('Workspace 不存在，跳过', { wsId: row.workspace_id });
        failed++;
        continue;
      }

      const apiKey = await resolveApiKey(row.instance_id, def.modelProviderId);

      // v2（Task 10）：agent 无 Matrix 凭据——不再解析/验证 bot token。
      // 注意：v1 spawn 的 runtime 子进程会在 taskDriven=false 时直接报错退出
      // （runtime-entry 已删 Matrix 登录分支），v1 路径整体由 Task 13 移除。
      spawnAgent(
        buildSpawnOpts({
          instanceId: row.instance_id,
          agentUserId: row.agent_user_id,
          workspaceId: row.workspace_id,
          workspaceDir: ws.directoryPath,
          teamSessionId: ws.teamSessionId,
          def,
          role: row.role as AgentRole,
          llmApiKey: apiKey,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === row.instance_id,
        }),
      );
      const subCount = row.role === 'main'
        ? listSubAssignments(row.workspace_id, row.instance_id).length
        : 0;

      started++;
      logger.info('Agent 已自启动（v1 路径）', {
        slug: def.slug,
        instanceId: row.instance_id,
        role: row.role,
        subAgentCount: subCount,
      });
    } catch (err) {
      failed++;
      logger.error('Agent 自启动失败', {
        instanceId: row.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Agent 自启动完成（v1 fallback）', { started, failed, skipped, total: rows.length });
}

