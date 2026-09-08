// electron/src/main/agent/session-lane.ts
//
// 会话执行车道（v2.3 spec §4）——同一会话同一时刻至多一条顶层活跃流。
//
// 设计要点：
//   - 内存态 Map<sessionId, LaneEntry>：routeUserChat 派发顶层流时注册，
//     AgentRunner 流收尾时清除（按 streamSessionId 匹配，防迟到收尾误清）
//   - 占道判定双层：内存活跃流 ∪ 该会话 in_progress 任务行（DB 兜底——
//     重启后内存为空，孤儿 in_progress 行继续占道防插队，spec §4.2）
//   - 精确中止（K7-3 修复）：按 taskId 反查流 id 走 abortStreamBySessionId，
//     不再按 executionSessionId 广播——同会话 dispatch 子流不被误杀
//   - 独立模块不 import runtime-registry / agent-runner（避免环）：
//     registry 与 runner 都 import 本模块
import { listTasks } from '../storage/tasks/repo';
import { abortStreamBySessionId } from './stream-relay';
import { logger } from '../logger';

/** 车道条目：会话 → 活跃顶层流 */
export interface LaneEntry {
  /** kickoff 来源任务 id；用户手输派发的流为 null */
  taskId: string | null;
  streamSessionId: string;
  assignmentId: string;
}

const lane = new Map<string, LaneEntry>();

/**
 * 注册（upsert）车道条目。
 * kickoff=true 时无条件覆盖——executor 已保证放行前车道空闲，覆盖仅发生在
 * 「手输流恰好先注册」的极窄竞态窗口，退化并行 + warn（spec §7）。
 */
export function registerLane(
  sessionId: string,
  entry: LaneEntry,
  opts?: { kickoff?: boolean },
): void {
  const prev = lane.get(sessionId);
  if (prev && opts?.kickoff && prev.streamSessionId !== entry.streamSessionId) {
    logger.warn('kickoff 到达时车道被占（手输流竞态窗口），覆盖注册退化为并行', {
      sessionId,
      prevStreamSessionId: prev.streamSessionId,
    });
  }
  lane.set(sessionId, entry);
}

/** 清除车道——仅当当前条目的 streamSessionId 匹配（防迟到收尾清掉新注册） */
export function clearLaneIfMatch(sessionId: string, streamSessionId: string): void {
  const cur = lane.get(sessionId);
  if (cur && cur.streamSessionId === streamSessionId) {
    lane.delete(sessionId);
  }
}

/** 查询车道条目（steer 分流目标判定用） */
export function getLane(sessionId: string): LaneEntry | null {
  return lane.get(sessionId) ?? null;
}

/** 占道判定：内存活跃流 ∪ DB in_progress 兜底（spec §4.2） */
export function isLaneOccupied(sessionId: string): boolean {
  if (lane.has(sessionId)) return true;
  return listTasks({ executionSessionId: sessionId, status: 'in_progress', limit: 1 }).length > 0;
}

/**
 * K7-3 精确中止（spec §6）：按 taskId 反查车道流并 abort。
 * 返回是否命中（未命中时调用方回退按 executionSessionId 广播）。
 * dispatch 子流不经 routeDispatch 注册车道——天然不受影响。
 */
export function abortTaskStreamByLane(taskId: string): boolean {
  for (const entry of lane.values()) {
    if (entry.taskId === taskId) {
      return abortStreamBySessionId(entry.streamSessionId);
    }
  }
  return false;
}

/** 测试用：清空车道 */
export function __clearLaneForTest(): void {
  lane.clear();
}
