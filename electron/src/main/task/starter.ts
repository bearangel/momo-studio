// electron/src/main/task/starter.ts
//
// 任务执行启动 + execution_room 决策树（B 子系统 B8）。
//
// 4 种启动机制的统一入口，决策 execution_room 后把任务推进 in_progress。
//
// 决策优先级（按 brief 关键设计点）：
//   1. 调用方显式传 executionSessionId → 用预设
//   2. createNewRoom=true → 强制创建新任务会话
//   3. task.sourceSessionId 存在 → 锁定 source_session（任务诞生的会话）
//   4. 都没 → 创建新会话（命名：任务 #T-XXX: 标题前 20 字）
//
// 锁定规则：任务一旦进入 in_progress，execution_session_id 不可改。
// 重新启动已 in_progress 的任务时：
//   - 若调用方传的 executionSessionId 与已锁定的不同 → 抛"锁定"错
//   - 否则幂等返回（不重复 transition，因为状态机 in_progress→in_progress 非法）
//
// v2.0 P1 Task 11：新建 execution 会话改写本地 sessions 表（kind='task_execution'），
// assignee 直接入 session_members——不再经 Matrix 建房/邀请（getOwnerMatrixClient 已无登录态）。
//
// Task 12 原子化：新建会话路径的三步写包（insertSession + addSessionMember +
// transitionTaskStatus）包在同一 SQLite 事务——任一步失败（典型：assignee 的 FK
// 不合法）整笔回滚，不留 orphan session / 半启动任务。
import { getDb } from '../storage/db';
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { insertSession, addSessionMember } from '../storage/sessions/repo';
import { logger } from '../logger';

export interface StartTaskResult {
  task: TaskRow;
  executionSessionId: string;
  createdNewRoom: boolean;
}

export interface StartTaskOpts {
  /** 显式指定 execution_room，优先级最高 */
  executionSessionId?: string;
  /** 强制新建会话，覆盖 source_session 锁定 */
  createNewRoom?: boolean;
}

/**
 * 启动任务：决策 execution_room + 转 in_progress + 锁定 execution_session_id。
 *
 * @throws task 不存在 / status 非法 / 已 in_progress 且 executionSessionId 冲突 / Matrix 操作失败
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
      opts?.executionSessionId &&
      task.executionSessionId &&
      opts.executionSessionId !== task.executionSessionId
    ) {
      throw new Error(
        `task ${taskId} 已锁定 execution_room=${task.executionSessionId}，不能改为 ${opts.executionSessionId}`,
      );
    }
    return {
      task,
      executionSessionId: task.executionSessionId ?? '',
      createdNewRoom: false,
    };
  }

  // 新启动：只允许 assigned / pending（draft 等需先调度器提升）
  if (task.status !== 'assigned' && task.status !== 'pending') {
    throw new Error(
      `task ${taskId} status=${task.status}，不能启动（必须为 assigned 或 pending）`,
    );
  }

  // 决策 execution_room + 三步写入，包在同一事务（Task 12 原子化）：
  // 预设 → createNewRoom → source_session → 新建会话
  const result = getDb().transaction((o: StartTaskOpts): StartTaskResult => {
    let executionSessionId: string;
    let createdNewRoom = false;
    if (o.executionSessionId) {
      executionSessionId = o.executionSessionId;
    } else if (o.createNewRoom) {
      executionSessionId = createNewTaskRoom(task);
      createdNewRoom = true;
    } else if (task.sourceSessionId) {
      executionSessionId = task.sourceSessionId;
    } else {
      executionSessionId = createNewTaskRoom(task);
      createdNewRoom = true;
    }

    // 新建会话时把 assignee 加为成员（如果是新建的会话且有指定 assignee）
    if (createdNewRoom && task.assigneeAgentId) {
      addSessionMember(executionSessionId, task.assigneeAgentId);
    }

    // 状态机转换 + 锁定 execution_room（assigned/pending → in_progress）
    const updated = transitionTaskStatus(taskId, 'in_progress', {
      executionSessionId,
      startedAt: Date.now(),
    });

    return { task: updated, executionSessionId, createdNewRoom };
  })(opts ?? {});

  logger.info('Task 已启动', {
    taskId,
    executionSessionId: result.executionSessionId,
    createdNewRoom: result.createdNewRoom,
    assignee: task.assigneeAgentId,
  });

  return result;
}

/** 创建任务专属 execution 会话（本地 sessions 表行）。命名约定：任务 #T-XXX: 标题前 20 字。 */
function createNewTaskRoom(task: TaskRow): string {
  const titlePrefix = task.title.slice(0, 20);
  const roomName = `任务 #${task.id}: ${titlePrefix}`;
  const row = insertSession({
    workspaceId: task.workspaceId,
    title: roomName,
    kind: 'task_execution',
  });
  return row.id;
}
