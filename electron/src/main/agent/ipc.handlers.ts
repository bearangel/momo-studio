// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口（v1.3 schema）。
//
// 暴露给渲染进程的能力：
//   - agent:addToWorkspace —— 一键编排（带 role + parentInstanceId + apiKeyOverride）
//   - agent:assignMain —— 安装 main + 自动跟随 sub
//   - agent:createFromYaml / list / listAssignments —— 低层
//   - agent:createCustom / updateDefinition / deleteDefinition —— def 管理
//   - agent:updateAssignmentRole / updateAssignmentApiKey —— assignment 编辑
//   - agent:start / stop / removeAssignment / isRunning / getBuiltinSuggestions
//
// v1.3 改造要点：
//   - addToWorkspace/assignMain 写 role + parent_instance_id（不再写 def.type/parentAgentId）
//   - apiKey 解析走 resolveApiKey（override ?? provider key），不再用单独 llmApiKey 入参
//   - createCustom/updateDefinition 不含 type/parent/model 字段；含 scope/modelProviderId/modelName
//   - 删除 updateApiKey；新增 updateAssignmentApiKey / deleteDefinition /
//     updateAssignmentRole / getBuiltinSuggestions
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { parseAgentManifest } from './manifest-parser';
import {
  saveAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
  assignAgentToWorkspace,
  listAssignments,
  updateAssignmentRole as crudUpdateAssignmentRole,
  updateAssignmentApiKey as crudUpdateAssignmentApiKey,
  listSubAssignments,
  deleteDefinition as crudDeleteDefinition,
  updateAgentDefinition,
  stopRunningInstancesByDefinition,
} from './crud';
import { getWorkspace, setWorkspaceCoordinator } from '../workspace/crud';
import { getSecret, deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { spawnAgent, stopAgent, isAgentRunning } from './runtime-manager';
import { registerAgentBot, type RegisteredBot } from './bot-registrar';
import { inviteBotToRoom } from '../matrix/rooms';
import { getOwnerMatrixClient } from '../matrix/session';
import { getSyncingClient } from '../matrix/sync-manager';
import { createMatrixClient } from '../matrix/client';
import { buildSpawnOpts, HOMESERVER_URL, resolveApiKey } from './spawn-helpers';
import { getBuiltinSuggestionsMap } from './builtin';
import type { AgentAssignment, AgentDefinition, AgentRole } from './types';
import { randomUUID } from 'node:crypto';

/** agent:addToWorkspace 入参（v1.3） */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  role: AgentRole;
  /** role='sub' 时必填：同 ws 内 main assignment 的 instanceId */
  parentInstanceId?: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
}

/** agent:assignMain 入参（v1.3） */
export interface AssignMainInput {
  workspaceId: string;
  mainDefId: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
  /** 要安装的子 agent 定义 ID 列表；undefined = 不安装任何 sub（仅 main） */
  selectedSubDefIds?: string[];
}

/**
 * 安装一个 main agent，并自动跟随注册选中的 sub agent。
 * v1.3：role/parent_instance_id 写在 assignment 上（不写 def）。
 * 任一步骤失败即抛错，不做回滚（与原 addToWorkspace 失败语义一致）。
 *
 * 校验：main def 和全部 selectedSubDefIds 都必须有 modelProviderId（未配置 → throw）。
 */
export async function assignMainAgent(opts: AssignMainInput): Promise<AgentAssignment[]> {
  const { workspaceId, mainDefId, apiKeyOverride, selectedSubDefIds } = opts;

  const mainDef = getAgentDefinition(mainDefId);
  if (!mainDef) throw new Error(`未找到 agent 定义: ${mainDefId}`);
  if (!mainDef.modelProviderId) {
    throw new Error(`main agent「${mainDef.name}」未配置 modelProviderId，请先到 Agent 库配置`);
  }

  // 守卫：检查 mainDef 是否已安装到该 workspace
  const existingAssignments = listAssignments(workspaceId);
  const alreadyInstalled = existingAssignments.some((a) => a.agentDefinitionId === mainDefId);
  if (alreadyInstalled) {
    throw new Error('该 main agent 已安装到此 workspace，请先移除后再重新安装');
  }

  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
  if (!workspace.teamRoomId) {
    throw new Error('workspace 尚未创建团队群（teamRoomId 为空）');
  }

  // 查找选中的 sub 定义；校验全部已配置 provider
  const subDefs: AgentDefinition[] = [];
  if (selectedSubDefIds && selectedSubDefIds.length > 0) {
    for (const subDefId of selectedSubDefIds) {
      const subDef = getAgentDefinition(subDefId);
      if (!subDef) throw new Error(`未找到子 agent 定义: ${subDefId}`);
      if (!subDef.modelProviderId) {
        throw new Error(`子 agent「${subDef.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }
      subDefs.push(subDef);
    }
  }

  // I2：跳过已安装的 sub（避免重复分配同一 def 到 workspace）
  const installedDefIds = new Set(existingAssignments.map((a) => a.agentDefinitionId));
  const newSubDefs = subDefs.filter((d) => !installedDefIds.has(d.id));

  // owner 的 Matrix client（用于把各 bot 邀请进团队群）
  const ownerClient = await getOwnerMatrixClient();

  // Phase 1：注册 bot + 分配 + 邀请 + 存 apiKeyOverride（如有）
  // 拆两阶段是为了让 main 在 Phase 2 启动时已知道其全部 sub 的 botUserId
  const installed: Array<{ def: AgentDefinition; assignment: AgentAssignment; bot: RegisteredBot }> = [];

  // 1a. 安装 main（role='main'）
  const mainBot = await registerAgentBot({
    slug: mainDef.slug,
    workspaceName: workspace.name,
    ownerUserId: workspace.ownerId,
    homeserverUrl: HOMESERVER_URL,
  });
  const mainAssignment = assignAgentToWorkspace(
    workspaceId, mainDef.id, mainBot.botUserId, 'main',
  );
  await inviteBotToRoom(ownerClient, workspace.teamRoomId, mainBot.botUserId);
  if (apiKeyOverride) {
    await crudUpdateAssignmentApiKey(mainAssignment.instanceId, apiKeyOverride);
  }
  installed.push({ def: mainDef, assignment: mainAssignment, bot: mainBot });

  // 1b. 安装 subs（role='sub', parentInstanceId=mainAssignment.instanceId）
  for (const subDef of newSubDefs) {
    const subBot = await registerAgentBot({
      slug: subDef.slug,
      workspaceName: workspace.name,
      ownerUserId: workspace.ownerId,
      homeserverUrl: HOMESERVER_URL,
    });
    const subAssignment = assignAgentToWorkspace(
      workspaceId, subDef.id, subBot.botUserId, 'sub', mainAssignment.instanceId,
    );
    await inviteBotToRoom(ownerClient, workspace.teamRoomId, subBot.botUserId);
    if (apiKeyOverride) {
      await crudUpdateAssignmentApiKey(subAssignment.instanceId, apiKeyOverride);
    }
    installed.push({ def: subDef, assignment: subAssignment, bot: subBot });
  }

  // Phase 2：启动 runtime（subAgents 由 buildSpawnOpts 内部按 parent_instance_id 重建）
  const results: AgentAssignment[] = [];
  for (const { def, assignment, bot } of installed) {
    const apiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId!);
    spawnAgent(
      buildSpawnOpts({
        instanceId: assignment.instanceId,
        botUserId: bot.botUserId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        teamRoomId: workspace.teamRoomId!,
        ownerUserId: workspace.ownerId,
        def,
        role: assignment.role,
        botAccessToken: bot.botAccessToken,
        llmApiKey: apiKey,
        isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
      }),
    );
    results.push(assignment);
  }

  logger.info('Main agent 及其 sub agents 已安装并启动', {
    workspaceId, mainDefId, mainSlug: mainDef.slug, subCount: newSubDefs.length,
  });
  return results;
}

/**
 * 删除 agent 分配：停止运行 → 让 bot 离开所有房间 → 删 bot token →
 * 清空悬空 coordinator 引用 → 删 assignment 行。
 * v1.3：若删除的是 role='main'，则级联删除同 ws 内 parent_instance_id 指向它的全部 subs。
 */
export async function removeAgentAssignment(instanceId: string): Promise<void> {
  stopAgent(instanceId);
  const row = getDb()
    .prepare('SELECT bot_matrix_user_id, workspace_id, role FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as
    | { bot_matrix_user_id?: string; workspace_id?: string; role?: string }
    | undefined;
  if (!row) return;
  const botUserId = row.bot_matrix_user_id;
  const workspaceId = row.workspace_id;

  // v1.3 级联：main 被删时连带删除同 ws 内 parent_instance_id 指向它的 subs
  if (row.role === 'main' && workspaceId) {
    const subs = listSubAssignments(workspaceId, instanceId);
    for (const sub of subs) {
      await removeAgentAssignment(sub.instanceId);
    }
  }

  if (botUserId) {
    await makeBotLeaveAllRooms(botUserId).catch((e) =>
      logger.warn('bot 离开房间失败（非致命，继续清理）', { botUserId, error: String(e) }),
    );
    await deleteSecret(`bot.${botUserId}.matrix_token`).catch((e) =>
      logger.warn('清理 bot token 失败（非致命）', { error: String(e) }),
    );
  }

  // 清除 API key override（如有）
  await deleteSecret(`agent.${instanceId}.api_key_override`).catch(() => {});

  // 被删实例若是协调 agent，清空引用
  if (workspaceId) {
    const ws = getWorkspace(workspaceId);
    if (ws?.coordinatorInstanceId === instanceId) {
      setWorkspaceCoordinator(workspaceId, null);
    }
  }

  getDb().prepare('DELETE FROM agent_assignments WHERE instance_id = ?').run(instanceId);
  logger.info('Agent 分配已删除', { instanceId, botUserId, workspaceId });
}

/** 用 bot 自身 token 创建临时 client，让它离开所有当前已加入的房间 */
async function makeBotLeaveAllRooms(botUserId: string): Promise<void> {
  const token = await getSecret(`bot.${botUserId}.matrix_token`);
  if (!token) return;
  const syncingClient = getSyncingClient();
  if (!syncingClient) return;
  const botClient = createMatrixClient({ baseUrl: HOMESERVER_URL, userId: botUserId, accessToken: token });
  const joinedRooms = syncingClient
    .getRooms()
    .filter((r) => (r.getMember(botUserId)?.membership ?? '') === 'join');
  for (const room of joinedRooms) {
    try {
      await botClient.leave(room.roomId);
    } catch (err) {
      logger.warn('bot 离开单个房间失败', { botUserId, roomId: room.roomId, err: String(err) });
    }
  }
}

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 一键编排：注册 bot + 分配（带 role/parent）+ 邀请 + 启动 runtime
  ipcMain.handle(
    'agent:addToWorkspace',
    async (_evt, input: AddToWorkspaceInput) => {
      const { workspaceId, agentDefinitionId, role, parentInstanceId, apiKeyOverride } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
      if (!workspace.teamRoomId) {
        throw new Error('workspace 尚未创建团队群（teamRoomId 为空）');
      }

      const bot = await registerAgentBot({
        slug: def.slug,
        workspaceName: workspace.name,
        ownerUserId: workspace.ownerId,
        homeserverUrl: HOMESERVER_URL,
      });

      const assignment = assignAgentToWorkspace(
        workspaceId, agentDefinitionId, bot.botUserId, role, parentInstanceId ?? null,
      );

      const ownerClient = await getOwnerMatrixClient();
      await inviteBotToRoom(ownerClient, workspace.teamRoomId, bot.botUserId);

      if (apiKeyOverride) {
        await crudUpdateAssignmentApiKey(assignment.instanceId, apiKeyOverride);
      }

      const apiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);
      spawnAgent(
        buildSpawnOpts({
          instanceId: assignment.instanceId,
          botUserId: bot.botUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          teamRoomId: workspace.teamRoomId,
          ownerUserId: workspace.ownerId,
          def,
          role: assignment.role,
          botAccessToken: bot.botAccessToken,
          llmApiKey: apiKey,
          isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
        }),
      );

      logger.info('Agent 已添加到 workspace 并启动', {
        slug: def.slug, workspaceId, instanceId: assignment.instanceId, role,
      });
      return assignment;
    },
  );

  ipcMain.handle(
    'agent:assignMain',
    async (_evt, opts: AssignMainInput) => assignMainAgent(opts),
  );

  // 从 YAML 创建 agent 定义。v1.3：不再做 parentAgentId slug→UUID 解析
  //（角色/父子关系已移到 assignment 级，def 不再存这些字段）
  ipcMain.handle('agent:createFromYaml', async (_evt, yamlContent: string) => {
    const def = parseAgentManifest(yamlContent);
    saveAgentDefinition(def);
    logger.info('Agent 定义已创建（来自 YAML）', { slug: def.slug });
    return def;
  });

  // 创建自定义 agent 定义（v1.3：scope + modelProviderId + modelName）
  ipcMain.handle(
    'agent:createCustom',
    async (_evt, input: {
      name: string;
      slug: string;
      description: string;
      systemPrompt: string;
      iconEmoji?: string;
      scope: 'global' | 'workspace';
      modelProviderId: string;
      modelName: string;
    }) => {
      // 解析 scope → workspaceId
      const workspaceId = input.scope === 'workspace'
        ? (input as { workspaceId?: string }).workspaceId ?? null
        : null;

      const def: AgentDefinition = {
        id: randomUUID(),
        name: input.name,
        slug: input.slug,
        version: '1.0.0',
        runtime: 'declarative',
        systemPrompt: input.systemPrompt,
        defaultTools: [
          { kind: 'builtin', ref: 'read_file' },
          { kind: 'builtin', ref: 'write_file' },
          { kind: 'builtin', ref: 'list_files' },
        ],
        defaultMcps: [],
        defaultSkills: [],
        source: 'custom',
        description: input.description,
        iconEmoji: input.iconEmoji ?? '🤖',
        workspaceId,
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
      };
      saveAgentDefinition(def);
      logger.info('自定义 Agent 定义已创建', { slug: def.slug, scope: input.scope });
      return def;
    },
  );

  // 编辑 agent 定义（v1.3：scope + modelProviderId + modelName；不含 type/parent）
  ipcMain.handle(
    'agent:updateDefinition',
    async (_evt, input: {
      id: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      iconEmoji?: string;
      scope?: 'global' | 'workspace';
      modelProviderId?: string;
      modelName?: string;
    }) => {
      // scope 转 workspaceId
      const workspaceId = input.scope === 'global'
        ? null
        : input.scope === 'workspace'
          ? (input as { workspaceId?: string }).workspaceId
          : undefined;

      const updated = updateAgentDefinition({
        id: input.id,
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        iconEmoji: input.iconEmoji,
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
        workspaceId,
      });
      const stopped = stopRunningInstancesByDefinition(input.id);
      if (stopped.length > 0) {
        logger.info('Agent 定义更新，已停止运行中实例', { id: input.id, stopped: stopped.length });
      }
      return { definition: updated, stoppedInstanceIds: stopped };
    },
  );

  // 删除自定义 agent 定义（builtin 不可删；级联清理 assignment）
  ipcMain.handle(
    'agent:deleteDefinition',
    async (_evt, defId: string) => crudDeleteDefinition(defId),
  );

  // 列出 agent 定义（v1.3：可选 workspaceId 过滤）
  ipcMain.handle('agent:list', async (_evt, workspaceId?: string) => {
    return listAgentDefinitions(workspaceId);
  });

  ipcMain.handle(
    'agent:assign',
    async (_evt, workspaceId: string, agentDefinitionId: string, botMatrixUserId: string) => {
      // 低层 API：保留向后兼容，默认 role='standalone'
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, botMatrixUserId, 'standalone');
    },
  );

  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    stopAgent(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:removeAssignment', async (_evt, instanceId: string) => {
    await removeAgentAssignment(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 修改 assignment 的 role + parent（含循环引用校验）
  // 主进程只更新 DB；调用方需自行停止 + 重启 runtime 才能应用新角色
  ipcMain.handle(
    'agent:updateAssignmentRole',
    async (
      _evt,
      instanceId: string,
      role: AgentRole,
      parentInstanceId?: string,
    ) => {
      crudUpdateAssignmentRole(instanceId, role, parentInstanceId ?? null);

      // 如从 main 改为非 main，停止其全部 subs（它们失去父）
      const wsRow = instanceId
        ? (getDb()
            .prepare('SELECT workspace_id FROM agent_assignments WHERE instance_id = ?')
            .get(instanceId) as { workspace_id: string } | undefined)
        : undefined;
      const wsId = wsRow?.workspace_id ?? '';
      const allAssignments = wsId ? listAssignments(wsId) : [];
      const stopped: string[] = [];
      const current = allAssignments.find((a) => a.instanceId === instanceId);
      // 仅当从 main 改为非 main 时级联停止 subs
      if (current && current.role === 'main' && role !== 'main') {
        const oldSubs = listSubAssignments(current.workspaceId, instanceId);
        for (const sub of oldSubs) {
          if (isAgentRunning(sub.instanceId)) {
            stopAgent(sub.instanceId);
            stopped.push(sub.instanceId);
          }
        }
      }
      return { stoppedInstanceIds: stopped };
    },
  );

  // 设置/清除 assignment 的 API key override
  ipcMain.handle(
    'agent:updateAssignmentApiKey',
    async (_evt, instanceId: string, apiKey: string | null) => {
      await crudUpdateAssignmentApiKey(instanceId, apiKey);
      return { ok: true };
    },
  );

  // 返回 builtin 建议 Map（UI 添加 builtin 时预填 role/platform）
  ipcMain.handle('agent:getBuiltinSuggestions', async () => {
    return getBuiltinSuggestionsMap();
  });

  // 重启 agent：从 keychain 恢复 token + 解析 apiKey，spawn runtime
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
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`未找到 workspace: ${workspaceId}`);
      }

      const botAccessToken = await getSecret(`bot.${assignment.botMatrixUserId}.matrix_token`);
      if (!botAccessToken) {
        throw new Error('Bot access token 丢失（请先注册 bot 账号）');
      }

      const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

      spawnAgent(
        buildSpawnOpts({
          instanceId: assignment.instanceId,
          botUserId: assignment.botMatrixUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          teamRoomId,
          ownerUserId: workspace.ownerId,
          def,
          role: assignment.role,
          botAccessToken,
          llmApiKey,
          isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
        }),
      );

      return { instanceId: assignment.instanceId };
    },
  );

  logger.info('Agent IPC handlers 已注册');
}
