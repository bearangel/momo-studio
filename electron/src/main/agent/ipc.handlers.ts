// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口。
// 暴露给渲染进程的能力：
//   - agent:addToWorkspace —— 一键编排：注册 bot 账号 + 分配到 workspace +
//     邀请 bot 进团队群 + 存 LLM API key + 启动 runtime（UI 主要入口）
//   - agent:createFromYaml / list / assign / listAssignments —— 低层能力
//   - agent:start / stop —— 单独控制已分配 agent 的启停
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
import { getSecret, setSecret } from '../storage/keychain';
import { spawnAgent, stopAgent, isAgentRunning } from './runtime-manager';
import { registerAgentBot } from './bot-registrar';
import { inviteBotToRoom } from '../matrix/rooms';
import { getOwnerMatrixClient } from '../matrix/session';
import type { AgentAssignment } from './types';

// Conduwuit 固定监听 8008（与 conduit/manager.ts 的 CONDUIT_PORT 一致）。
const HOMESERVER_URL = 'http://127.0.0.1:8008';

/** LLM API key 在 keychain 中的存储 key 前缀 */
const llmApiKeyStorageKey = (instanceId: string): string => `agent.${instanceId}.llm_api_key`;

/** agent:addToWorkspace 入参 */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  llmApiKey: string;
}

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 一键编排：注册 bot 账号 → 分配到 workspace → 邀请 bot 进团队群 →
  // 存 LLM API key → 启动 runtime。UI "添加 agent" 按钮的主入口。
  // 任一步骤失败都抛错，由 renderer 转为用户可见的错误提示。
  ipcMain.handle(
    'agent:addToWorkspace',
    async (_evt, input: AddToWorkspaceInput) => {
      const { workspaceId, agentDefinitionId, llmApiKey } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
      if (!workspace.teamRoomId) {
        throw new Error('workspace 尚未创建团队群（teamRoomId 为空）');
      }

      // 1. 注册 bot Matrix 账号（token 自动存 keychain）
      const bot = await registerAgentBot({
        slug: def.slug,
        workspaceName: workspace.name,
        ownerUserId: workspace.ownerId,
        homeserverUrl: HOMESERVER_URL,
      });

      // 2. 分配 agent 到 workspace（DB 记录，绑定 botMatrixUserId）
      const assignment = assignAgentToWorkspace(workspaceId, agentDefinitionId, bot.botUserId);

      // 3. 邀请 bot 进团队群（用 owner 的 client 发 invite）
      const ownerClient = await getOwnerMatrixClient();
      await inviteBotToRoom(ownerClient, workspace.teamRoomId, bot.botUserId);

      // 4. LLM API key 存 keychain（runtime 启动时不再需要 renderer 传入）
      await setSecret(llmApiKeyStorageKey(assignment.instanceId), llmApiKey);

      // 5. 启动 runtime 子进程
      spawnAgent({
        instanceId: assignment.instanceId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        botUserId: bot.botUserId,
        botAccessToken: bot.botAccessToken,
        homeserverUrl: HOMESERVER_URL,
        systemPrompt: def.systemPrompt,
        modelProvider: def.model.provider,
        modelName: def.model.model,
        llmApiKey,
        teamRoomId: workspace.teamRoomId,
      });

      logger.info('Agent 已添加到 workspace 并启动', {
        slug: def.slug,
        workspaceId,
        instanceId: assignment.instanceId,
      });
      return assignment;
    },
  );

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

  // 停止指定 instanceId 的 agent 子进程
  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    stopAgent(instanceId);
    return { ok: true };
  });

  // 查询指定 instanceId 的 agent 是否正在运行（UI 据此显示 running/stopped 状态）
  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 重启已分配的 agent：从 keychain 恢复 API key + bot token 后 spawn
  // （应用重启后 agent 不会自动恢复，需用户手动重启或后续实现自动恢复）
  ipcMain.handle(
    'agent:start',
    async (
      _evt,
      opts: {
        assignment: AgentAssignment;
        workspaceId: string;
        teamRoomId: string;
      },
    ) => {
      const { assignment, workspaceId, teamRoomId } = opts;

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

      // LLM API key 从 keychain 恢复（addToWorkspace 时存入）
      const llmApiKey = await getSecret(llmApiKeyStorageKey(assignment.instanceId));
      if (!llmApiKey) {
        throw new Error('LLM API key 丢失，请重新添加 agent');
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

  logger.info('Agent IPC handlers 已注册');
}
