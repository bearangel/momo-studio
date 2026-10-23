// hub 命名空间 IPC——通道名与 types.d.ts / preload 逐一对齐（momo-boundary-rules）。
import { ipcMain } from 'electron';
import { hubConfigure, hubEnroll, hubForget, hubGetStatus } from './index';

export function registerHubIpc(): void {
  ipcMain.handle('hub:getStatus', () => hubGetStatus());
  ipcMain.handle('hub:configure', (_evt, input: { hubUrl: string; nodeName: string }) => hubConfigure(input));
  ipcMain.handle('hub:enroll', (_evt, input: { hubUrl: string; enrollmentToken: string; nodeName: string }) => hubEnroll(input));
  ipcMain.handle('hub:forget', () => hubForget());
}
