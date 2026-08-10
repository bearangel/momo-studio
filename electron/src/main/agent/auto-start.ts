// electron/src/main/agent/auto-start.ts
//
// 应用启动时自动恢复已分配的 agent。
// 读取所有 workspace 的 enabled agent assignment，
// 从 keychain 恢复 API key + bot token 后 spawn runtime 子进程。
//
// v1.3 改造：
//   - role 来自 assignment（不再从 def.type 推断）
//   - subAgents 由 buildSpawnOpts 按 assignment.parent_instance_id 重建
//   - apiKey 解析走 resolveApiKey（override ?? provider key）；def.modelProviderId=NULL 时跳过
//   - 老的 llmApiKeyRef keychain key 仅作 fallback（向后兼容）

import { getDb } from '../storage/db';
import { spawnAgent, isAgentRunning } from './runtime-manager';
import { getAgentDefinition, listSubAssignments } from './crud';
import { getWorkspace } from '../workspace/crud';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import { logger } from '../logger';
import type { AgentRole } from './types';

interface AssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
  /** v1.5.8：用户最近运行意图（1=运行 / 0=主动下线） */
  last_running: number;
  role: string;
}

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
    if (isAgentRunning(row.instance_id)) continue;

    try {
      const def = getAgentDefinition(row.agent_definition_id);
      if (!def) {
        logger.warn('Agent 定义不存在，跳过', { defId: row.agent_definition_id });
        failed++;
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

      const token = await getBotToken(row.bot_matrix_user_id);
      if (!token) {
        logger.warn('Bot Matrix token 丢失，跳过', { botUserId: row.bot_matrix_user_id });
        failed++;
        continue;
      }

      spawnAgent(
        buildSpawnOpts({
          instanceId: row.instance_id,
          botUserId: row.bot_matrix_user_id,
          workspaceId: row.workspace_id,
          workspaceDir: ws.directoryPath,
          teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
          ownerUserId: ws.ownerId,
          def,
          role: row.role as AgentRole,
          botAccessToken: token,
          llmApiKey: apiKey,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === row.instance_id,
        }),
      );

      // main agent 的 sub 数量（日志用，按 assignment.parent_instance_id 查）
      const subCount = row.role === 'main'
        ? listSubAssignments(row.workspace_id, row.instance_id).length
        : 0;

      started++;
      logger.info('Agent 已自启动', {
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

  logger.info('Agent 自启动完成', { started, failed, skipped, total: rows.length });
}

/** 从 keychain 取 bot Matrix token（封装 helper，便于日志统一） */
async function getBotToken(botUserId: string): Promise<string | null> {
  const { getSecret } = await import('../storage/keychain');
  return getSecret(`bot.${botUserId}.matrix_token`);
}
