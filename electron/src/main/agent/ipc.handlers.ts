// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口。
// 暴露给渲染进程的能力：从 YAML 创建 agent、列出 agent 定义、把 agent 分配到 workspace、查某 workspace 的分配列表。
// 注意：bot 账号本身的 matrix 注册（创建 @bot:* 用户）由后续任务处理，这里只接收已注册好的 bot user id。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { parseAgentManifest } from './manifest-parser';
import {
  saveAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
  assignAgentToWorkspace,
  listAssignments,
} from './crud';
import { getWorkspace } from '../workspace/crud';
import { getSecret } from '../storage/keychain';
import { spawnAgent, stopAgent } from './runtime-manager';
import type { AgentAssignment } from './types';

// Conduwuit 固定监听 8008（与 conduit/manager.ts 的 CONDUIT_PORT 一致）。
const HOMESERVER_URL = 'http://127.0.0.1:8008';

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 从 YAML manifest 字符串创建 agent 定义并持久化。校验失败会抛错（parseAgentManifest），由 IPC 层转为 rejection。
  ipcMain.handle('agent:createFromYaml', async (_evt, yamlContent: string) => {
    const def = parseAgentManifest(yamlContent);
    saveAgentDefinition(def);
    logger.info('Agent 定义已创建', { slug: def.slug });
    return def;
  });

  // 列出全部已持久化的 agent 定义
  ipcMain.handle('agent:list', async () => {
    return listAgentDefinitions();
  });

  // 把 agent 定义分配到 workspace，绑定一个 bot matrix 账号
  ipcMain.handle(
    'agent:assign',
    async (_evt, workspaceId: string, agentDefinitionId: string, botMatrixUserId: string) => {
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, botMatrixUserId);
    },
  );

  // 查询某 workspace 下的全部 agent 分配记录
  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  // 启动一个 agent 实例的 runtime 子进程：拉取 agent 定义 + workspace 目录 +
  // 从 keychain 恢复 bot token，组装配置后 spawn。
  ipcMain.handle(
    'agent:start',
    async (
      _evt,
      opts: {
        assignment: AgentAssignment;
        workspaceId: string;
        teamRoomId: string;
        llmApiKey: string;
      },
    ) => {
      const { assignment, workspaceId, teamRoomId, llmApiKey } = opts;

      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) {
        throw new Error(`未找到 agent 定义: ${assignment.agentDefinitionId}`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`未找到 workspace: ${workspaceId}`);
      }

      const botAccessToken = await getSecret(
        `bot.${assignment.botMatrixUserId}.matrix_token`,
      );
      if (!botAccessToken) {
        throw new Error('Bot access token 丢失（请先注册 bot 账号）');
      }

      spawnAgent({
        instanceId: assignment.instanceId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        botUserId: assignment.botMatrixUserId,
        botAccessToken,
        homeserverUrl: HOMESERVER_URL,
        systemPrompt: def.systemPrompt,
        modelProvider: def.model.provider,
        modelName: def.model.model,
        llmApiKey,
        teamRoomId,
      });

      return { instanceId: assignment.instanceId };
    },
  );

  // 停止指定 instanceId 的 agent 子进程
  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    stopAgent(instanceId);
    return { ok: true };
  });

  logger.info('Agent IPC handlers 已注册');
}
