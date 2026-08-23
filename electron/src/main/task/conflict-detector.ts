// electron/src/main/task/conflict-detector.ts
//
// 冲突触发检测器（I3 修复）。
//
// 在用户消息进入消息流时检测：当前房间是否为某 in_progress 任务的 execution_room，
// 且用户消息 mention 了另一个不同的任务。若满足条件则返回冲突信息，由调用方推送给 renderer。
//
// 与 conflict-resolver.ts 的分工：
//   - 本模块负责"检测"（是否有冲突）——纯函数，依赖注入
//   - conflict-resolver.ts 负责"解决"（用什么策略处理）——纯函数
//   - 调用方（im/ipc.handlers.ts）串联两者：检测 → 推送 → renderer 弹窗 → 用户选策略 → resolveConflict
import type { TaskRow } from '../storage/tasks/repo';

/** #T-后接数字，前面须是行首或空白（与 renderer mention-parser 同源正则） */
const TASK_MENTION_REGEX = /(?:^|\s)#(T-\d+)(?=\s|$)/g;

export interface ConflictDeps {
  /** 按执行会话查 in_progress 任务（Task 2 起 tasks.execution_session_id） */
  findInProgressTaskByRoom: (sessionId: string) => TaskRow | null;
  getTask: (id: string) => TaskRow | null;
}

export interface ConflictDetectionResult {
  newTaskId: string;
  currentTaskId: string;
  currentRoomId: string;
}

/**
 * 解析消息正文中的全部 #T-xxx task mention refId。
 * @returns refId 数组（如 ['T-001', 'T-003']），去重保序
 */
export function parseTaskMentions(body: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(TASK_MENTION_REGEX)) {
    const refId = m[1];
    if (refId && !seen.has(refId)) {
      seen.add(refId);
      refs.push(refId);
    }
  }
  return refs;
}

/**
 * 检测消息是否触发任务冲突。
 *
 * 条件（全部满足才返回非 null）：
 *   1. 当前会话是某 in_progress 任务的 execution_session
 *   2. 消息正文含至少一个可解析的 #T-xxx mention（getTask 能查到）
 *   3. mentioned task != 当前 in_progress task
 *
 * 多个 mention 时取第一个满足条件 2+3 的。
 */
export function detectConflict(
  sessionId: string,
  body: string,
  deps: ConflictDeps,
): ConflictDetectionResult | null {
  const currentTask = deps.findInProgressTaskByRoom(sessionId);
  if (!currentTask) return null;

  for (const refId of parseTaskMentions(body)) {
    if (refId === currentTask.id) continue;
    const mentioned = deps.getTask(refId);
    if (mentioned) {
      return {
        newTaskId: mentioned.id,
        currentTaskId: currentTask.id,
        currentRoomId: sessionId,
      };
    }
  }
  return null;
}
