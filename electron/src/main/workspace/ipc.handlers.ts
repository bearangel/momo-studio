// electron/src/main/workspace/ipc.handlers.ts
//
// Workspace IPC handlers — 把 T2 的 CRUD 函数包装成 `workspace:*` IPC 通道。
// v2（Task 10）：create 不再联动 Matrix（团队会话由 crud.createWorkspace 在
// 本地 sessions 表内创建）。
// v2（Task 11）：无登录概念——单用户本地应用，owner 身份是结构常量 'owner'。
import { ipcMain, shell } from 'electron';
import { logger } from '../logger';
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  deleteWorkspace,
  setDefaultAgent,
  renameWorkspace,
} from './crud';
import {
  getAllocation,
  addAllocation,
  removeAllocation,
  type CapabilityType,
} from './allocation';
import { isAgentRunning } from '../agent/runtime-status';
import { startAgentRuntime, stopAgentRuntime } from '../agent/runtime-registry';
import { getAgentDefinition, listMembers } from '../agent/crud';
import { buildSpawnOpts, resolveApiKey } from '../agent/spawn-helpers';
import type { CreateWorkspaceInput } from './types';

/** 注册 workspace:* IPC handlers。重复注册会被 Electron 拒绝，故仅调用一次。 */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:create', async (_evt, input: CreateWorkspaceInput) => {
    // v2（Task 11）：单用户本地应用——owner 身份为结构常量（原从 Matrix 登录会话读取）
    return createWorkspace(input, 'owner');
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

  // P2 Task 2：重命名 workspace（仅 UPDATE name 列；不存在时抛错给 renderer 提示）
  ipcMain.handle('workspace:rename', async (_evt, id: string, name: string) => {
    renameWorkspace(id, name);
    return { ok: true };
  });

  // P2 Task 2：在系统文件管理器中打开 workspace 目录。
  // shell.openPath 失败语义是返回非空错误字符串（而非 reject），转为抛错让 renderer alert。
  ipcMain.handle('workspace:openDirectory', async (_evt, id: string) => {
    const ws = getWorkspace(id);
    if (!ws) throw new Error(`Workspace 不存在: ${id}`);
    const errMessage = await shell.openPath(ws.directoryPath);
    if (errMessage !== '') throw new Error(`打开目录失败: ${errMessage}`);
    return { ok: true };
  });

  // 设置/清空默认会话 agent；若目标实例正在运行，自动停止并重启以应用新的 isCoordinator 标志。
  // v25：内部实现为 default_agent_instance_id；通道名保留 coordinator（renderer 契约，
  // preload/renderer 侧更名由后续 task 一并处理）
  ipcMain.handle(
    'workspace:setCoordinator',
    async (_evt, workspaceId: string, instanceId: string | null) => {
      setDefaultAgent(workspaceId, instanceId);

      // 设定后自动重启运行中的实例；清空（null）或未运行则跳过
      if (instanceId !== null) {
        await restartDefaultAgentInstance(workspaceId, instanceId);
      }

      return { ok: true };
    },
  );

  // 查询当前默认会话 agent
  ipcMain.handle('workspace:getCoordinator', async (_evt, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    return { instanceId: ws?.defaultAgentInstanceId ?? null };
  });

  logger.info('Workspace IPC handlers 已注册');
}

/**
 * 设定默认会话 agent 后，若目标实例正在运行，自动停止并以 isCoordinator=true 重启，
 * 使新的标志立即对 runtime 子进程生效（取代旧版"提示用户手动停止+启动"）。
 *
 * 实例未运行 / 成员不存在 / 定义已删除 / keychain 缺 apiKey 时，
 * 静默跳过重启（仅 defaultAgentInstanceId 已写入 DB，下次启动时自然带上标志）。
 *
 * I1 修复：先检查 keychain 是否有 apiKey，确认后才 stopAgent，
 * 避免「先停后查、查不到就 return」导致 agent 被停死无法恢复。
 */
async function restartDefaultAgentInstance(
  workspaceId: string,
  instanceId: string,
): Promise<void> {
  const ws = getWorkspace(workspaceId);
  if (!ws || !isAgentRunning(instanceId)) return;

  const member = listMembers(workspaceId).find((a) => a.instanceId === instanceId);
  if (!member) return;

  const def = getAgentDefinition(member.agentDefinitionId);
  if (!def) return;

  // v1.3：apiKey 走 resolveApiKey（override ?? provider key）；def.modelProviderId 必须已配置
  if (!def.modelProviderId) return;
  const apiKey = await resolveApiKey(instanceId, def.modelProviderId);

  await stopAgentRuntime(instanceId);

  await startAgentRuntime(
    buildSpawnOpts({
      instanceId: member.instanceId,
      agentUserId: member.agentUserId,
      workspaceId,
      workspaceDir: ws.directoryPath,
      // v25 过渡态：团队会话列已退役，传空串保持线协议形状
      teamSessionId: '',
      def,
      llmApiKey: apiKey,
      isCoordinator: true,
    }),
  );
  logger.info('默认会话 agent 已自动重启', { instanceId });
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
