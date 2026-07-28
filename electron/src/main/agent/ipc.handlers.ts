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
  assignAgentToWorkspace,
  listAssignments,
} from './crud';

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

  logger.info('Agent IPC handlers 已注册');
}
