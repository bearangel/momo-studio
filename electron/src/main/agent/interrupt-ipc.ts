// electron/src/main/agent/interrupt-ipc.ts
//
// 三级中断 IPC（spec §7.2）：回合级 / 会话级 / 链级 + 在途查询。
// 通道面与 renderer/src/ipc/types.d.ts 逐字对齐（boundary 规则 4）——
// listInFlight 返回值类型直接引用 InFlightChainView（编译期锁契约形状）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import type { InFlightChainView } from '../../../../renderer/src/ipc/types';

export function registerInterruptIpc(deps: {
  abortTurn: (sessionId: string) => { stoppedStream: boolean };
  stopAll: (sessionId: string) => { stoppedStreams: number; cancelledChains: number };
  cancelChain: (arg: { taskId?: string; subStreamSessionId?: string }) => { status: string };
  listInFlight: (sessionId?: string) => InFlightChainView[];
}): void {
  ipcMain.handle('agent:abortTurn', (_e, arg: unknown) => {
    const a = arg as { sessionId?: unknown };
    if (typeof a.sessionId !== 'string' || a.sessionId === '') throw new Error('sessionId 非法');
    return deps.abortTurn(a.sessionId);
  });
  ipcMain.handle('session:stopAll', (_e, arg: unknown) => {
    const a = arg as { sessionId?: unknown };
    if (typeof a.sessionId !== 'string' || a.sessionId === '') throw new Error('sessionId 非法');
    return deps.stopAll(a.sessionId);
  });
  ipcMain.handle('dispatch:cancelChain', (_e, arg: unknown) => {
    const a = arg as { taskId?: unknown; subStreamSessionId?: unknown };
    if (typeof a.taskId !== 'string' && typeof a.subStreamSessionId !== 'string') {
      throw new Error('taskId 与 subStreamSessionId 至少一项');
    }
    return deps.cancelChain({ ...(typeof a.taskId === 'string' ? { taskId: a.taskId } : {}), ...(typeof a.subStreamSessionId === 'string' ? { subStreamSessionId: a.subStreamSessionId } : {}) });
  });
  ipcMain.handle('dispatch:listInFlight', (_e, arg: unknown) => {
    const a = (arg ?? {}) as { sessionId?: unknown };
    if (a.sessionId !== undefined && typeof a.sessionId !== 'string') throw new Error('sessionId 非法');
    return deps.listInFlight(typeof a.sessionId === 'string' ? a.sessionId : undefined);
  });
  logger.info('Interrupt IPC handlers 已注册');
}
