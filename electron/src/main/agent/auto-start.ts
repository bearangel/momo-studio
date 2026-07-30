// electron/src/main/agent/auto-start.ts
//
// 应用启动时自动恢复已分配的 agent。
// 读取所有 workspace 的 enabled agent assignment，
// 从 keychain 恢复 API key 后 spawn runtime 子进程。

import { getDb } from '../storage/db';
import { getSecret } from '../storage/keychain';
import { spawnAgent, isAgentRunning } from './runtime-manager';
import { getAgentDefinition } from './crud';
import { getWorkspace } from '../workspace/crud';
import { getAllocation } from '../workspace/allocation';
import { mergeCapabilities } from './capability-merger';
import { resolveSkillsDir } from '../paths';
import { logger } from '../logger';
import type { AgentAssignment } from './types';

interface AssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
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
      const assignment: AgentAssignment = {
        instanceId: row.instance_id,
        workspaceId: row.workspace_id,
        agentDefinitionId: row.agent_definition_id,
        botMatrixUserId: row.bot_matrix_user_id,
        enabled: row.enabled === 1,
        createdAt: '',
      };

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
        subAgents: [],
        skills: [],
        mcpNames: merged.mcps,
      });

      started++;
      logger.info('Agent 已自启动', { slug: def.slug, instanceId: row.instance_id });
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
