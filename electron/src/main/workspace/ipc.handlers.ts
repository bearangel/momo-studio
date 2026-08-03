// electron/src/main/workspace/ipc.handlers.ts
//
// Workspace IPC handlers — 把 T2 的 CRUD 函数包装成 `workspace:*` IPC 通道，
// 并在 create 时联动 Matrix：先创建 Space + 团队群，再把两个 room ID 落到 DB。
//
// 已登录用户的 Matrix client 由 matrix/session.getOwnerMatrixClient 提供
// （从 keychain 恢复 token，构造一次性 client，不启动 /sync）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace, setWorkspaceCoordinator } from './crud';
import {
  getAllocation,
  addAllocation,
  removeAllocation,
  type CapabilityType,
} from './allocation';
import { createMatrixSpace, createRoomInSpace } from '../matrix/rooms';
import { getOwnerMatrixClient, getCurrentUserId } from '../matrix/session';
import { stopAgent, spawnAgent, isAgentRunning } from '../agent/runtime-manager';
import { getAgentDefinition, listAssignments, llmApiKeyRef } from '../agent/crud';
import { buildSpawnOpts } from '../agent/spawn-helpers';
import { getSecret } from '../storage/keychain';
import type { CreateWorkspaceInput } from './types';

/** 注册 workspace:* IPC handlers。重复注册会被 Electron 拒绝，故仅调用一次。 */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:create', async (_evt, input: CreateWorkspaceInput) => {
    const userId = getCurrentUserId();
    if (!userId) throw new Error('未登录，无法创建 workspace');

    const client = await getOwnerMatrixClient();
    const spaceId = await createMatrixSpace(client, input.name);
    // 同时创建团队群：用户 + 所有 agent bot 在此 room 内交流，
    // 挂到刚创建的 Space 下，room ID 存入 workspace 记录供 agent 启动时引用。
    const teamRoomId = await createRoomInSpace(client, spaceId, `${input.name} · 团队群`);

    return createWorkspace(input, userId, spaceId, teamRoomId);
  });

  ipcMain.handle('workspace:list', async () => {
    return listWorkspaces();
  });

  ipcMain.handle('workspace:get', async (_evt, id: string) => {
    return getWorkspace(id);
  });

  ipcMain.handle('workspace:delete', async (_evt, id: string) => {
    deleteWorkspace(id);
    return;
  });

  // 设置/清空协调 agent；若目标实例正在运行，自动停止并重启以应用新的 isCoordinator 标志
  ipcMain.handle(
    'workspace:setCoordinator',
    async (_evt, workspaceId: string, instanceId: string | null) => {
      setWorkspaceCoordinator(workspaceId, instanceId);

      // 设定协调后自动重启运行中的实例；清空（null）或未运行则跳过
      if (instanceId !== null) {
        await restartCoordinatorInstance(workspaceId, instanceId);
      }

      return { ok: true };
    },
  );

  // 查询当前协调 agent
  ipcMain.handle('workspace:getCoordinator', async (_evt, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    return { instanceId: ws?.coordinatorInstanceId ?? null };
  });

  logger.info('Workspace IPC handlers 已注册');
}

/**
 * 设定协调 agent 后，若目标实例正在运行，自动停止并以 isCoordinator=true 重启，
 * 使新的协调标志立即对 runtime 子进程生效（取代旧版"提示用户手动停止+启动"）。
 *
 * 实例未运行 / assignment 不存在 / 定义已删除 / keychain 缺 token 或 apiKey 时，
 * 静默跳过重启（仅 coordinatorInstanceId 已写入 DB，下次启动时自然带上标志）。
 *
 * I1 修复：先检查 keychain 是否有 apiKey + token，确认后才 stopAgent，
 * 避免「先停后查、查不到就 return」导致 agent 被停死无法恢复。
 */
async function restartCoordinatorInstance(
  workspaceId: string,
  instanceId: string,
): Promise<void> {
  const ws = getWorkspace(workspaceId);
  if (!ws || !isAgentRunning(instanceId)) return;

  const assignment = listAssignments(workspaceId).find((a) => a.instanceId === instanceId);
  if (!assignment) return;

  const def = getAgentDefinition(assignment.agentDefinitionId);
  if (!def) return;

  // I1 修复：先恢复 keychain，确认 apiKey + token 都在，再停止旧实例。
  // 否则若 key 丢失，agent 会停在已停止状态无法重启。
  const apiKey = await getSecret(llmApiKeyRef(instanceId));
  const token = await getSecret(`bot.${assignment.botMatrixUserId}.matrix_token`);
  if (!apiKey || !token) return;

  stopAgent(instanceId);

  spawnAgent(
    buildSpawnOpts({
      instanceId: assignment.instanceId,
      botUserId: assignment.botMatrixUserId,
      workspaceId,
      workspaceDir: ws.directoryPath,
      teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
      ownerUserId: ws.ownerId,
      def,
      botAccessToken: token,
      // v1.3：role 来自 assignment；协调重启保留原 role
      role: assignment.role,
      llmApiKey: apiKey,
      isCoordinator: true,
    }),
  );
  logger.info('协调 agent 已自动重启', { instanceId });
}

/**
 * 注册 allocation:* IPC handlers —— workspace 级能力分配 CRUD。
 * 与 workspace:* 分开注册（通道命名空间不同），但仍归属 workspace 域。
 */
export function registerAllocationHandlers(): void {
  // 读取某 workspace 的全部能力分配（按 tool/mcp/skill 分桶）
  ipcMain.handle('allocation:get', async (_evt, workspaceId: string) => {
    return getAllocation(workspaceId);
  });

  // 增加一条能力分配（INSERT OR IGNORE，重复添加幂等）
  ipcMain.handle(
    'allocation:add',
    async (_evt, workspaceId: string, type: CapabilityType, ref: string) => {
      addAllocation(workspaceId, type, ref);
      return;
    },
  );

  // 移除一条能力分配
  ipcMain.handle(
    'allocation:remove',
    async (_evt, workspaceId: string, type: CapabilityType, ref: string) => {
      removeAllocation(workspaceId, type, ref);
      return;
    },
  );

  logger.info('Allocation IPC handlers 已注册');
}
