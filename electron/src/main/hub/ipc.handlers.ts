// hub 命名空间 IPC——通道名与 types.d.ts / preload 逐一对齐（momo-boundary-rules）。
import { ipcMain } from 'electron';
import { hubConfigure, hubEnroll, hubForget, hubGetStatus, replayPresenceSeed } from './index';

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
}
