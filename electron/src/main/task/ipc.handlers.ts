// electron/src/main/task/ipc.handlers.ts
//
// task: 命名空间 IPC handler（B 子系统 B7）。
//
// 暴露通道：
//   - task:create      新建任务（creatorUserId 由 main process 注入常量 'owner'）
//   - task:list        多维过滤 + 排序查询
//   - task:get         按 id 查单条
//   - task:update      部分字段更新（绕过状态机；正常路径请用 task:transition）
//   - task:transition  状态机驱动的状态转换（可带 extraPatch 副作用字段）
//   - task:cancel      等价 transition(id, 'cancelled')
//   - task:start       启动任务（execution_room 决策树 + 转 in_progress + 锁定 execution_room）
//
// 设计要点：
//   - v2（Task 11）：无登录概念——creatorUserId 由 main process 注入结构常量 'owner'
//     （单用户本地应用；原从 Matrix 登录会话读取，不信任 renderer 传身份的原则不变）。
//   - task:list 直接转发 listTasks 的 opts 结构（workspaceId / status / assigneeAgentId 等）。
//   - P4 Task 2：四个写通道（create/transition/cancel/start）成功后 fire-and-forget
//     广播任务快照（P2P 未启用时内部静默 no-op）。import 叶子模块 task-broadcast
//     而非 p2p 门面——避免把 electron/传输层依赖拖进 scheduler 等纯逻辑模块的测试图。
//   - Task 5：同一批写通道成功后 notifyExecutor()——队列状态变化立即触发放行评估
//     （executor 内部 100ms 去抖合并；通知丢了有 30s 兜底扫描自愈）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  insertTask,
  listTasks,
  getTask,
  updateTask,
  transitionTaskStatus,
  type TaskRow,
  type TaskStatus,
} from '../storage/tasks/repo';
import { broadcastLocalTaskSnapshot } from '../p2p/task-broadcast';
import { notifyExecutor, buildKickoffBody } from './executor';
import { startTask, hasDelegationTarget, type StartTaskOpts } from './starter';
import { resolveConflict, type ConflictStrategy } from './conflict-resolver';
import { executeConflictResolution } from './conflict-executor';
import { abortTasksBySessionEverywhere } from '../agent/runtime-registry';
import { sendUserMessage, broadcastSessionListChanged } from '../im/session-service';

/** renderer task:create 入参（不含 creatorUserId，由 main 注入） */
interface CreateInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: number;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  assigneeAgentId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetTeamId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetSessionId?: string | null;
  /** v29：循环规则 */
  recurrenceRule?: string | null;
  scheduledAt?: number | null;
  deadlineAt?: number | null;
}

/** renderer task:list 入参，与 listTasks opts 对齐 */
interface ListOpts {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  assigneeAgentId?: string;
  executionSessionId?: string;
  sourceSessionId?: string;
  orderBy?: 'priority' | 'scheduled_at' | 'created_at' | 'created_at_desc';
  limit?: number;
}

/**
 * K7-4：任务转 paused / cancelled 时联动中断 agent 执行——只改 DB 是半套
 * 语义（agent 继续跑白烧 token）。先转状态后 abort：中断后的 task-end
 * 到达时行已终态/paused，幂等跳过（agent-runner K7-2 防覆盖），无竞态。
 */
function abortTaskExecutionIfAny(taskId: string): void {
  const row = getTask(taskId);
  if (!row?.executionSessionId) return;
  abortTasksBySessionEverywhere(row.executionSessionId);
}

export function registerTaskHandlers(): void {
  ipcMain.handle('task:create', async (_evt, input: CreateInput): Promise<TaskRow> => {
    // K1（P0 修复）：状态决策必须保证「已指派的任务会被自动调度」——
    // scheduler 只消费 pending、executor 只消费 assigned，落 draft 的指派
    // 任务两个调度器都不认（主机验收 P0）。决策表：
    //   有委派目标 + 无 scheduledAt → assigned（executor 立即评估放行）
    //   有委派目标 + 有 scheduledAt → pending（到点 scheduler 升 assigned，C1）
    //   无目标 + 有 scheduledAt    → pending（C1 定时管线语义保持；scheduler
    //                                因无目标不升级，用户可手动启动）
    //   无目标 + 无 scheduledAt    → draft（repo 单点默认，草稿暂存）
    const hasTarget = hasDelegationTarget(input);
    const status =
      input.scheduledAt != null ? 'pending' : hasTarget ? 'assigned' : undefined;
    const created = insertTask({
      workspaceId: input.workspaceId,
      title: input.title,
      creatorUserId: 'owner',
      status,
      description: input.description,
      priority: input.priority,
      sourceSessionId: input.sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      assigneeAgentId: input.assigneeAgentId,
      targetTeamId: input.targetTeamId,
      targetSessionId: input.targetSessionId,
      recurrenceRule: input.recurrenceRule,
      scheduledAt: input.scheduledAt,
      deadlineAt: input.deadlineAt,
    });
    void broadcastLocalTaskSnapshot();
    notifyExecutor();
    return created;
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
      // minor-11：剥离 status 字段——task:update 是部分字段补丁通道，绕开
      // state-machine 直接写 status 会让终端任务复活 / 非法迁移。状态变更
      // 强制走 task:transition / task:cancel（断言 + bump updated_at）。
      // renderer 误传时记 warn 帮助定位，status 字段静默丢弃
      let applied: Partial<TaskRow>;
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
        const { status: _stripped, ...rest } = patch;
        logger.warn('task:update 携带 status 字段已剥离——请用 task:transition / task:cancel', { id });
        applied = rest;
      } else {
        applied = patch;
      }
      updateTask(id, applied);
      // K3（P0 修复）：与 create/transition/cancel/start 四写通道对齐——
      // 编辑可能改 assignee/目标（排队任务的执行对象变化），
      // 成功后必须触发调度重评估 + P2P 快照广播
      void broadcastLocalTaskSnapshot();
      notifyExecutor();
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
      const row = transitionTaskStatus(id, to, extraPatch);
      if (to === 'paused' || to === 'cancelled') {
        abortTaskExecutionIfAny(id);
      }
      void broadcastLocalTaskSnapshot();
      notifyExecutor();
      return row;
    },
  );

  ipcMain.handle('task:cancel', async (_evt, id: string): Promise<void> => {
    transitionTaskStatus(id, 'cancelled');
    abortTaskExecutionIfAny(id);
    void broadcastLocalTaskSnapshot();
    notifyExecutor();
  });

  // K7-5：恢复暂停的任务——paused → in_progress + kickoff 重注入执行会话。
  // agent 接收 kickoff 后接续会话历史继续工作（执行上下文未丢）；agent 已
  // 停止时接待路由的 ensureRunner 自动拉起。无执行会话的边角（不应出现，
  // paused 行必经 in_progress 锁定）只转状态，不注入。
  ipcMain.handle('task:resume', async (_evt, id: string): Promise<TaskRow> => {
    const row = transitionTaskStatus(id, 'in_progress');
    if (row.executionSessionId) {
      await sendUserMessage({
        sessionId: row.executionSessionId,
        body: buildKickoffBody(row),
        mentionedInstanceIds: row.assigneeAgentId ? [row.assigneeAgentId] : undefined,
        systemKickoff: true,
      });
    }
    void broadcastLocalTaskSnapshot();
    notifyExecutor();
    return row;
  });

  ipcMain.handle(
    'task:start',
    async (
      _evt,
      id: string,
      opts?: StartTaskOpts,
    ): Promise<{ executionSessionId: string; createdNewRoom: boolean }> => {
      // K9：手动启动与 executor 自动放行等价——startTask 只建会话/转状态，
      // kickoff 消息注入才是驱动 agent 开始执行的指令（旧实现漏了这半步，
      // 手动启动后新会话空转无任何执行）。启动前快照区分「新启动」与
      // 「幂等返回」：仅新启动注入，重复点击不重复驱动
      const before = getTask(id);
      const result = await startTask(id, opts);
      // K10：新建执行会话 → 通知 renderer 刷新会话列表（停留 IM 视图可见）
      if (result.createdNewRoom) broadcastSessionListChanged();
      const newlyStarted =
        before != null && before.status !== 'in_progress' && result.task.executionSessionId != null;
      if (newlyStarted) {
        try {
          await sendUserMessage({
            sessionId: result.executionSessionId,
            body: buildKickoffBody(result.task),
            mentionedInstanceIds: result.task.assigneeAgentId
              ? [result.task.assigneeAgentId]
              : undefined,
            systemKickoff: true,
          });
        } catch (err) {
          // kickoff 失败 = 无执行驱动（半启动状态不可恢复）——与 executor
          // failQuietly 同语义转 failed，错误信息透出给 UI
          const reason = err instanceof Error ? err.message : String(err);
          try {
            transitionTaskStatus(id, 'failed', { completedAt: Date.now(), errorMessage: `kickoff 注入失败: ${reason}` });
          } catch {
            // 并发改态——终态以先到者为准
          }
          throw err;
        }
      }
      void broadcastLocalTaskSnapshot();
      notifyExecutor();
      return {
        executionSessionId: result.executionSessionId,
        createdNewRoom: result.createdNewRoom,
      };
    },
  );

  // B9：当用户在 execution_room 内 @agent 启动新任务、但当前会话已有 in_progress
  // 任务时，ConflictDialog（或自动策略）调此通道。触发条件检测在 B11 runtime-entry。
  ipcMain.handle(
    'task:resolveConflict',
    async (
      _evt,
      input: {
        newTaskId: string;
        currentTaskId: string;
        currentRoomId: string;
        strategy: ConflictStrategy;
      },
    ) => {
      const resolution = resolveConflict(input);
      return executeConflictResolution(resolution, {
        newTaskId: input.newTaskId,
        currentTaskId: input.currentTaskId,
        currentRoomId: input.currentRoomId,
      });
    },
  );

  logger.info('Task IPC handlers 已注册');
}
