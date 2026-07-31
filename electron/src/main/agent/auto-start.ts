// electron/src/main/agent/auto-start.ts
//
// 应用启动时自动恢复已分配的 agent。
// 读取所有 workspace 的 enabled agent assignment，
// 从 keychain 恢复 API key 后 spawn runtime 子进程。
// main agent 的 subAgents 从 DB 中的 definition parentAgentId 关系重建。

import { getDb } from '../storage/db';
import { getSecret } from '../storage/keychain';
import { spawnAgent, isAgentRunning } from './runtime-manager';
import { getAgentDefinition, listAssignments } from './crud';
import { getWorkspace } from '../workspace/crud';
import { getAllocation } from '../workspace/allocation';
import { mergeCapabilities } from './capability-merger';
import { logger } from '../logger';
import type { AgentAssignment } from './types';
import type { SubAgentRef } from './builtin-tools';

interface AssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
}

/**
 * 为指定 workspace 内的 main agent 重建 subAgents 引用。
 * 遍历该 workspace 全部 assignment，找出 parentAgentId 指向该 main definition 的 sub assignment。
 */
function rebuildSubAgents(
  workspaceId: string,
  mainDefId: string,
  wsAssignments: AgentAssignment[],
): SubAgentRef[] {
  const subs: SubAgentRef[] = [];
  for (const assignment of wsAssignments) {
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

export async function autoStartAgents(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_assignments WHERE enabled = 1').all() as AssignmentRow[];
  if (rows.length === 0) {
    logger.info('没有需要自启动的 agent');
    return;
  }

  let started = 0;
  let failed = 0;

  for (const row of rows) {
    if (isAgentRunning(row.instance_id)) continue;

    try {
      const def = getAgentDefinition(row.agent_definition_id);
      if (!def) {
        logger.warn('Agent 定义不存在，跳过', { defId: row.agent_definition_id });
        failed++;
        continue;
      }

      const ws = getWorkspace(row.workspace_id);
      if (!ws) {
        logger.warn('Workspace 不存在，跳过', { wsId: row.workspace_id });
        failed++;
        continue;
      }

      const apiKey = await getSecret(`agent.${row.instance_id}.llm_api_key`);
      if (!apiKey) {
        logger.warn('Agent API key 丢失，跳过', { instanceId: row.instance_id });
        failed++;
        continue;
      }

      const token = await getSecret(`bot.${row.bot_matrix_user_id}.matrix_token`);
      if (!token) {
        logger.warn('Bot Matrix token 丢失，跳过', { botUserId: row.bot_matrix_user_id });
        failed++;
        continue;
      }

      const allocation = getAllocation(row.workspace_id);
      const merged = mergeCapabilities(def, allocation);

      // 为 main agent 从 DB 重建 subAgents（R2 修复）
      let subAgents: SubAgentRef[] = [];
      if (def.type === 'main') {
        const wsAssignments = listAssignments(row.workspace_id);
        subAgents = rebuildSubAgents(row.workspace_id, def.id, wsAssignments);
      }

      spawnAgent({
        instanceId: row.instance_id,
        workspaceId: row.workspace_id,
        workspaceDir: ws.directoryPath,
        botUserId: row.bot_matrix_user_id,
        botAccessToken: token,
        homeserverUrl: 'http://127.0.0.1:8008',
        systemPrompt: def.systemPrompt,
        modelProvider: def.model.provider,
        modelName: def.model.model,
        modelBaseUrl: def.model.baseUrl,
        llmApiKey: apiKey,
        teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
        ownerUserId: ws.ownerId,
        agentType: def.type,
        subAgents,
        skills: [],
        mcpNames: merged.mcps,
        isCoordinator: (ws.coordinatorInstanceId ?? null) === row.instance_id,
      });

      started++;
      logger.info('Agent 已自启动', {
        slug: def.slug,
        instanceId: row.instance_id,
        subAgentCount: subAgents.length,
      });
    } catch (err) {
      failed++;
      logger.error('Agent 自启动失败', {
        instanceId: row.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Agent 自启动完成', { started, failed, total: rows.length });
}
