// electron/src/main/task/groups.ipc.handlers.ts
//
// taskGroup: 命名空间 IPC handler（看板重构 Task 7）。
//
// 暴露通道：
//   - taskGroup:list        按 workspace 列组（archived 三态：exclude 默认 / only / all）
//   - taskGroup:create      新建组（尾插 position）
//   - taskGroup:update      改名 / 换色
//   - taskGroup:reorder     按入参顺序整段重写 position
//   - taskGroup:archive     归档组（单事务级联：组内非终态任务 cancel + 全组 archived）
//   - taskGroup:unarchive   解档组（只复活组本体，任务保持归档）
//
// 设计要点：
//   - CRUD / 级联事务语义单点在 storage/task-groups/repo.ts（Task 1），handler 只做透传
//   - archive 成功后对 cancelledIds 逐个 abortTaskExecution——级联 cancel 的
//     in_progress 来源停运行时流。abort 是进程级副作用，不入 DB 事务：
//     单个失败只 logger.warn，不阻断归档结果
//   - 任务归档改变 task:list 默认可见性，archive 成功后广播 P2P 快照
//     （与既有写通道惯例对齐；unarchive 只复活组本体不动任务，不广播）
import { ipcMain } from 'electron';
import {
  archiveGroup,
  createGroup,
  listGroups,
  reorderGroups,
  unarchiveGroup,
  updateGroup,
} from '../storage/task-groups/repo';
import { abortTaskExecution } from './lifecycle';
import { broadcastLocalTaskSnapshot } from '../p2p/task-broadcast';
import { logger } from '../logger';

export function registerTaskGroupHandlers(): void {
  // 全通道 async——与 ipc.handlers.ts 的 task:* 惯例对齐（invoke 契约恒 promise，
  // handler 内抛错经 ipcMain.handle 转拒绝，测试 .rejects 断言与生产语义一致）
  ipcMain.handle(
    'taskGroup:list',
    async (_evt, workspaceId: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
      listGroups(workspaceId, opts),
  );

  ipcMain.handle(
    'taskGroup:create',
    async (_evt, input: { workspaceId: string; name: string; color?: string }) =>
      createGroup(input),
  );

  ipcMain.handle(
    'taskGroup:update',
    async (_evt, id: string, patch: { name?: string; color?: string }) => updateGroup(id, patch),
  );

  ipcMain.handle('taskGroup:reorder', async (_evt, orderedIds: string[]) => {
    reorderGroups(orderedIds);
  });

  ipcMain.handle('taskGroup:archive', async (_evt, id: string) => {
    const res = archiveGroup(id);
    // 级联 cancel 的 in_progress 来源补执行中断（进程级副作用，不入 DB 事务）——
    // 单个 abort 失败吞错只 warn，不阻断归档结果
    for (const tid of res.cancelledIds) {
      try {
        abortTaskExecution(tid);
      } catch (err) {
        logger.warn(`taskGroup:archive 补执行中断失败 task=${tid}`, err);
      }
    }
    void broadcastLocalTaskSnapshot();
    return res;
  });

  ipcMain.handle('taskGroup:unarchive', async (_evt, id: string) => unarchiveGroup(id));

  logger.info('TaskGroup IPC handlers 已注册');
}
