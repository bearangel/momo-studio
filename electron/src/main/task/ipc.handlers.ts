// electron/src/main/task/ipc.handlers.ts
//
// task: 命名空间 IPC handler（B 子系统 B7）。
//
// 暴露通道：
//   - task:create      新建任务（creatorUserId 由 main process 从当前登录会话注入）
//   - task:list        多维过滤 + 排序查询
//   - task:get         按 id 查单条
//   - task:update      部分字段更新（绕过状态机；正常路径请用 task:transition）
//   - task:transition  状态机驱动的状态转换（可带 extraPatch 副作用字段）
//   - task:cancel      等价 transition(id, 'cancelled')
//   - task:start       启动任务（execution_room 决策树 + 转 in_progress + 锁定 execution_room）
//
// 设计要点：
//   - renderer 的 create 入参不含 creatorUserId（安全考虑：不信任 renderer 传的用户身份），
//     main process 从 readSession() 取当前登录 userId 注入。
//   - 未登录时 task:create 抛错（creatorUserId 是 NOT NULL 列）。
//   - task:list 直接转发 listTasks 的 opts 结构（workspaceId / status / assigneeAgentId 等）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getCurrentUserId } from '../matrix/session';
import {
  insertTask,
  listTasks,
  getTask,
  updateTask,
  transitionTaskStatus,
  type TaskRow,
  type TaskStatus,
} from '../storage/tasks/repo';
import { startTask, type StartTaskOpts } from './starter';

/** renderer task:create 入参（不含 creatorUserId，由 main 注入） */
interface CreateInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: number;
  sourceRoomId?: string | null;
  sourceMessageId?: string | null;
  assigneeAgentId?: string | null;
  scheduledAt?: number | null;
  deadlineAt?: number | null;
}

/** renderer task:list 入参，与 listTasks opts 对齐 */
interface ListOpts {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  assigneeAgentId?: string;
  executionRoomId?: string;
  sourceRoomId?: string;
  orderBy?: 'priority' | 'scheduled_at' | 'created_at';
  limit?: number;
}

export function registerTaskHandlers(): void {
  ipcMain.handle('task:create', async (_evt, input: CreateInput): Promise<TaskRow> => {
    const creatorUserId = getCurrentUserId();
    if (!creatorUserId) {
      throw new Error('task:create 失败：未登录（creatorUserId 不可为空）');
    }
    return insertTask({
      workspaceId: input.workspaceId,
      title: input.title,
      creatorUserId,
      description: input.description,
      priority: input.priority,
      sourceRoomId: input.sourceRoomId,
      sourceMessageId: input.sourceMessageId,
      assigneeAgentId: input.assigneeAgentId,
      scheduledAt: input.scheduledAt,
      deadlineAt: input.deadlineAt,
    });
  });

  ipcMain.handle('task:list', async (_evt, opts: ListOpts): Promise<TaskRow[]> => {
    return listTasks(opts);
  });

  ipcMain.handle('task:get', async (_evt, id: string): Promise<TaskRow | null> => {
    return getTask(id);
  });

  ipcMain.handle(
    'task:update',
    async (_evt, id: string, patch: Parameters<typeof updateTask>[1]): Promise<void> => {
      updateTask(id, patch);
    },
  );

  ipcMain.handle(
    'task:transition',
    async (
      _evt,
      id: string,
      to: TaskStatus,
      extraPatch?: Parameters<typeof transitionTaskStatus>[2],
    ): Promise<TaskRow> => {
      return transitionTaskStatus(id, to, extraPatch);
    },
  );

  ipcMain.handle('task:cancel', async (_evt, id: string): Promise<void> => {
    transitionTaskStatus(id, 'cancelled');
  });

  ipcMain.handle(
    'task:start',
    async (
      _evt,
      id: string,
      opts?: StartTaskOpts,
    ): Promise<{ executionRoomId: string; createdNewRoom: boolean }> => {
      const result = await startTask(id, opts);
      return {
        executionRoomId: result.executionRoomId,
        createdNewRoom: result.createdNewRoom,
      };
    },
  );

  logger.info('Task IPC handlers 已注册');
}
