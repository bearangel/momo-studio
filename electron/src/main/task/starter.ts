// electron/src/main/task/starter.ts
//
// 任务执行启动 + execution_room 决策树（B 子系统 B8）。
//
// 5 种启动机制的统一入口，决策 execution_room 后把任务推进 in_progress。
//
// 决策优先级（按 brief 关键设计点）：
//   1. 调用方显式传 executionSessionId → 用预设
//   2. createNewRoom=true → 强制创建新任务会话
//   3. task.targetTeamId 存在 → 团队执行会话（spec §5.3：成员=团队快照 + leader 标记）
//   4. task.targetSessionId 存在 → 锁定委派会话
//   5. task.sourceSessionId 存在 → 锁定 source_session（任务诞生的会话）
//   6. 都没 → 创建新会话（命名：任务 #T-XXX: 标题前 20 字）
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
import { insertSession, addSessionMember, getSession } from '../storage/sessions/repo';
import { teamExists, expandTeamMembers, getTeamLeaderInstanceId } from '../agent/team';
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

  // 新启动：允许 assigned / pending；draft 仅在有委派目标时放行
  // （K2：有目标的 draft 走 draft→assigned→in_progress 快捷路径——UI 手动
  // 启动草稿任务的唯一通道；无目标 draft 拒绝：手动放行只会建出无 agent
  // 的空会话，kickoff 无人接待，与 executor validateTarget 同语义）
  const draftEligible = task.status === 'draft' && hasDelegationTarget(task);
  if (task.status !== 'assigned' && task.status !== 'pending' && !draftEligible) {
    throw new Error(
      task.status === 'draft'
        ? `task ${taskId} 未指派委派目标，不能启动（请先编辑指派 agent / 团队 / 会话）`
        : `task ${taskId} status=${task.status}，不能启动（必须为 assigned 或 pending）`,
    );
  }

  // 决策 execution_room + 三步写入，包在同一事务（Task 12 原子化）：
  // 预设 → createNewRoom → targetTeamId → source_session → 新建会话
  const result = getDb().transaction((o: StartTaskOpts): StartTaskResult => {
    let executionSessionId: string;
    let createdNewRoom = false;
    if (o.executionSessionId) {
      executionSessionId = o.executionSessionId;
    } else if (o.createNewRoom) {
      executionSessionId = createNewTaskRoom(task);
      createdNewRoom = true;
    } else if (task.targetTeamId) {
      // v29 团队分支（spec §5.3）：事务内建执行会话 + 团队快照成员 +
      // leader is_leader 标记（kickoff 无 mention → 接待路由给 leader）
      if (!teamExists(task.targetTeamId)) {
        throw new Error(`目标团队不存在: ${task.targetTeamId}`);
      }
      executionSessionId = createTeamTaskRoom(task);
      createdNewRoom = true;
    } else if (task.targetSessionId) {
      // v29 会话目标：锁定委派会话（与 executor 显式传参路径同结果；
      // 缺此分支时手动启动会错误地新建会话，kickoff 落不到委派会话）
      if (!getSession(task.targetSessionId)) {
        throw new Error(`目标会话不存在: ${task.targetSessionId}`);
      }
      executionSessionId = task.targetSessionId;
    } else if (task.sourceSessionId) {
      executionSessionId = task.sourceSessionId;
    } else {
      executionSessionId = createNewTaskRoom(task);
      createdNewRoom = true;
    }

    // assignee 补进执行会话成员表（新建与复用路径统一）：kickoff 的 mention
    // 路由 / 接待判定都依赖 session_members——复用会话（显式 executionSessionId /
    // sourceSessionId）漏补会让 assignee 在执行会话里永远不可达。
    // addSessionMember 是 INSERT OR IGNORE：已在新房路径插过 / 会话已有该成员时幂等
    if (task.assigneeAgentId) {
      addSessionMember(executionSessionId, task.assigneeAgentId);
    }

    // K2：draft 快捷路径——先提升 assigned（状态机合法）再统一走
    // in_progress 转换；两步同事务，中途失败不留半启动状态
    if (task.status === 'draft') {
      transitionTaskStatus(taskId, 'assigned');
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

/** 委派目标三列任一非空——K1 落态决策 / K2 draft 启动资格 / 委派信息闭环 warning 判定的统一谓词
 *  （四处同义判定收敛为单点，语义漂移即 bug——终审 N1/M6） */
export function hasDelegationTarget(target: {
  assigneeAgentId?: string | null;
  targetTeamId?: string | null;
  targetSessionId?: string | null;
}): boolean {
  return target.assigneeAgentId != null || target.targetTeamId != null || target.targetSessionId != null;
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
  // assignee 是新建执行会话的唯一成员 → 标 leader（接待路由目标）：非 @ 消息
  // 只由 is_leader 成员接待，漏标会让用户在执行会话发言无人回应（静默落库）。
  // 后置统一补成员是 INSERT OR IGNORE，不会覆盖此处的 leader 标记。
  if (task.assigneeAgentId) {
    addSessionMember(row.id, task.assigneeAgentId, true);
  }
  return row.id;
}

/** 建团队执行会话：成员=团队快照展开，leader 加 is_leader=1（接待路由依据） */
function createTeamTaskRoom(task: TaskRow): string {
  const titlePrefix = task.title.slice(0, 20);
  const row = insertSession({
    workspaceId: task.workspaceId,
    title: `任务 #${task.id}: ${titlePrefix}`,
    kind: 'task_execution',
  });
  const leaderId = getTeamLeaderInstanceId(task.targetTeamId!);
  for (const m of expandTeamMembers(task.targetTeamId!)) {
    addSessionMember(row.id, m.instanceId, m.instanceId === leaderId);
  }
  return row.id;
}
