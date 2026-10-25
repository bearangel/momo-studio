// hub 命名空间 IPC——通道名与 types.d.ts / preload 逐一对齐（momo-boundary-rules）。
import { ipcMain } from 'electron';
import {
  hubConfigure, hubEnroll, hubForget, hubGetDelegationSettings, hubGetStatus, hubRequest,
  hubSetDelegationSettings, replayPresenceSeed,
} from './index';
import { createGroupClient } from './groups';
import { publishToHub, type PublishInput } from './publish';
import { buildAndUploadWorkspaceSnapshot } from './snapshot-upload';
import { RPC, TASK_RPC } from './protocol';

// 组管理客户端单点：绑定 hubRequest（IPC 面复用同一实例；纯函数集，无状态）
const groups = createGroupClient((method, payload, timeoutMs) => hubRequest(method, payload, timeoutMs));

export function registerHubIpc(): void {
  ipcMain.handle('hub:getStatus', () => {
    const status = hubGetStatus();
    // 拉状态 = renderer 面板可能刚挂载（订阅已就位）→ 顺带补发在线节点快照
    replayPresenceSeed();
    return status;
  });
  ipcMain.handle('hub:configure', (_evt, input: { hubUrl: string; nodeName: string }) => hubConfigure(input));
  ipcMain.handle('hub:enroll', (_evt, input: { hubUrl: string; enrollmentToken: string; nodeName: string }) => hubEnroll(input));
  ipcMain.handle('hub:forget', () => hubForget());
  ipcMain.handle('hub:publishResource', (_evt, input: PublishInput) => publishToHub(input));
  // 工作组六通道（M2b spec §3.1）——payload 直接采用 renderer 契约形状
  ipcMain.handle('hub:groupList', () => groups.list());
  ipcMain.handle('hub:groupCreate', (_evt, input: { groupName: string }) => groups.create(input.groupName));
  ipcMain.handle('hub:groupInvite', (_evt, input: { groupId: string }) => groups.invite(input.groupId));
  ipcMain.handle('hub:groupJoin', (_evt, input: { inviteCode: string }) => groups.join(input.inviteCode));
  ipcMain.handle('hub:groupLeave', (_evt, input: { groupId: string }) => groups.leave(input.groupId));
  ipcMain.handle('hub:groupTransfer', (_evt, input: { groupId: string; toNodeId: string }) => groups.transfer(input.groupId, input.toNodeId));
  // 镜像发起链（M2c T8b，向导 S2/S4 消费）
  ipcMain.handle('hub:snapshotBuildUpload', (_evt, input: { workspaceId: string }) =>
    buildAndUploadWorkspaceSnapshot(input.workspaceId));
  ipcMain.handle('hub:mirrorWorkspace', (_evt, input: {
    groupId: string; targetNodeId: string; workspaceName: string; snapshotId: string; confirm?: boolean;
  }) => hubRequest(RPC.workspace.mirror, {
    groupId: input.groupId,
    targetNodeId: input.targetNodeId,
    workspaceName: input.workspaceName,
    snapshotId: input.snapshotId,
    strategy: 'replace',
    ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
  }));
  // 委派子节点设置两通道（M2e T10）：接受开关 + 并发上限（set 返回归一化值）
  ipcMain.handle('hub:getDelegationSettings', () => hubGetDelegationSettings());
  ipcMain.handle('hub:setDelegationSettings', (_evt, input: { acceptTasks: boolean; maxConcurrent: number }) =>
    hubSetDelegationSettings(input));
  // 委派 leader 侧三通道（M2e T12，spec §3.1 task.*）：list（组过滤）/ delegate
  // （账本先行 pending）/ cancel（可取消态单点校验在 hub）；载荷采用 renderer 契约形状
  ipcMain.handle('hub:taskList', (_evt, input?: { groupId?: string }) =>
    hubRequest(TASK_RPC.list, { ...(input?.groupId !== undefined ? { groupId: input.groupId } : {}) }, undefined));
  ipcMain.handle('hub:taskDelegate', (_evt, input: {
    groupId: string; targetNodeId: string; workspaceName: string;
    title: string; prompt: string; agentSlug?: string;
  }) => hubRequest(TASK_RPC.delegate, {
    groupId: input.groupId,
    targetNodeId: input.targetNodeId,
    workspaceName: input.workspaceName,
    task: {
      title: input.title,
      prompt: input.prompt,
      ...(input.agentSlug !== undefined && input.agentSlug !== '' ? { agentSlug: input.agentSlug } : {}),
    },
  }, undefined));
  ipcMain.handle('hub:taskCancel', (_evt, input: { taskId: string }) => hubRequest(TASK_RPC.cancel, input, undefined));
}
