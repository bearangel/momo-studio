// electron/src/main/task/starter.ts
//
// 任务执行启动 + execution_room 决策树（B 子系统 B8）。
//
// 4 种启动机制的统一入口，决策 execution_room 后把任务推进 in_progress。
//
// 决策优先级（按 brief 关键设计点）：
//   1. 调用方显式传 executionRoomId → 用预设
//   2. createNewRoom=true → 强制创建新任务会话
//   3. task.sourceRoomId 存在 → 锁定 source_room（任务诞生的会话）
//   4. 都没 → 创建新会话（命名：任务 #T-XXX: 标题前 20 字）
//
// 锁定规则：任务一旦进入 in_progress，execution_room_id 不可改。
// 重新启动已 in_progress 的任务时：
//   - 若调用方传的 executionRoomId 与已锁定的不同 → 抛"锁定"错
//   - 否则幂等返回（不重复 transition，因为状态机 in_progress→in_progress 非法）
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { createRoomInSpace, inviteBotToRoom } from '../matrix/rooms';
import { getOwnerMatrixClient } from '../matrix/session';
import { getWorkspace } from '../workspace/crud';
import { logger } from '../logger';

export interface StartTaskResult {
  task: TaskRow;
  executionRoomId: string;
  createdNewRoom: boolean;
}

export interface StartTaskOpts {
  /** 显式指定 execution_room，优先级最高 */
  executionRoomId?: string;
  /** 强制新建会话，覆盖 source_room 锁定 */
  createNewRoom?: boolean;
}

/**
 * 启动任务：决策 execution_room + 转 in_progress + 锁定 execution_room_id。
 *
 * @throws task 不存在 / status 非法 / 已 in_progress 且 executionRoomId 冲突 / Matrix 操作失败
 */
export async function startTask(
  taskId: string,
  opts?: StartTaskOpts,
): Promise<StartTaskResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);

  // 重新启动已 in_progress 任务：execution_room 锁定语义。
  // （状态机 in_progress → in_progress 非法，故幂等返回而非再 transition）
  if (task.status === 'in_progress') {
    if (
      opts?.executionRoomId &&
      task.executionRoomId &&
      opts.executionRoomId !== task.executionRoomId
    ) {
      throw new Error(
        `task ${taskId} 已锁定 execution_room=${task.executionRoomId}，不能改为 ${opts.executionRoomId}`,
      );
    }
    return {
      task,
      executionRoomId: task.executionRoomId ?? '',
      createdNewRoom: false,
    };
  }

  // 新启动：只允许 assigned / pending（draft 等需先调度器提升）
  if (task.status !== 'assigned' && task.status !== 'pending') {
    throw new Error(
      `task ${taskId} status=${task.status}，不能启动（必须为 assigned 或 pending）`,
    );
  }

  // 决策 execution_room：预设 → createNewRoom → source_room → 新建会话
  let executionRoomId: string;
  let createdNewRoom = false;
  if (opts?.executionRoomId) {
    executionRoomId = opts.executionRoomId;
  } else if (opts?.createNewRoom) {
    executionRoomId = await createNewTaskRoom(task);
    createdNewRoom = true;
  } else if (task.sourceRoomId) {
    executionRoomId = task.sourceRoomId;
  } else {
    executionRoomId = await createNewTaskRoom(task);
    createdNewRoom = true;
  }

  // 新建会话时邀请 assignee（如果是新建的 room 且有指定 assignee）
  if (createdNewRoom && task.assigneeAgentId) {
    await inviteAssignee(executionRoomId, task.assigneeAgentId);
  }

  // 状态机转换 + 锁定 execution_room（assigned/pending → in_progress）
  const updated = transitionTaskStatus(taskId, 'in_progress', {
    executionRoomId,
    startedAt: Date.now(),
  });

  logger.info('Task 已启动', {
    taskId,
    executionRoomId,
    createdNewRoom,
    assignee: task.assigneeAgentId,
  });

  return { task: updated, executionRoomId, createdNewRoom };
}

/**
 * 创建任务专属 execution_room。命名约定：任务 #T-XXX: 标题前 20 字。
 * room 挂在 workspace 的 Matrix Space 下（便于 UI 按 Space 过滤）。
 */
async function createNewTaskRoom(task: TaskRow): Promise<string> {
  const titlePrefix = task.title.slice(0, 20);
  const roomName = `任务 #${task.id}: ${titlePrefix}`;
  const client = await getOwnerMatrixClient();
  const ws = getWorkspace(task.workspaceId);
  const spaceId = ws?.matrixSpaceId ?? '';
  return createRoomInSpace(client, spaceId, roomName);
}

/**
 * 邀请 assignee 加入 execution_room。
 * assigneeAgentId 当前约定为 bot user id（agent instance → Matrix user 映射在 D 子系统细化）。
 */
async function inviteAssignee(roomId: string, assigneeAgentId: string): Promise<void> {
  const client = await getOwnerMatrixClient();
  await inviteBotToRoom(client, roomId, assigneeAgentId);
}
