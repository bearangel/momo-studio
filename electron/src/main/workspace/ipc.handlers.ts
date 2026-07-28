// electron/src/main/workspace/ipc.handlers.ts
//
// Workspace IPC handlers — 把 T2 的 CRUD 函数包装成 `workspace:*` IPC 通道，
// 并在 create 时联动 Matrix：先创建 Space + 团队群，再把两个 room ID 落到 DB。
//
// 已登录用户的 Matrix client 由 matrix/session.getOwnerMatrixClient 提供
// （从 keychain 恢复 token，构造一次性 client，不启动 /sync）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from './crud';
import {
  getAllocation,
  addAllocation,
  removeAllocation,
  type CapabilityType,
} from './allocation';
import { createMatrixSpace, createRoomInSpace } from '../matrix/rooms';
import { getOwnerMatrixClient, getCurrentUserId } from '../matrix/session';
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

  logger.info('Workspace IPC handlers 已注册');
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
