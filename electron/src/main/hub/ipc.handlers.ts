// hub 命名空间 IPC——通道名与 types.d.ts / preload 逐一对齐（momo-boundary-rules）。
import { ipcMain } from 'electron';
import { hubConfigure, hubEnroll, hubForget, hubGetStatus, hubRequest, replayPresenceSeed } from './index';
import { createGroupClient } from './groups';
import { publishToHub, type PublishInput } from './publish';

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
}
