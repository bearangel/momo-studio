// electron/src/main/p2p/remote-cache.ts
//
// 远端任务镜像缓存（P4 Task 3）——入站 task-snapshot 的内存只读镜像。
//
// 设计要点：
//   - 只读铁律：入站任务绝不落 tasks 表（防本节点调度器误捡远端任务执行），
//     仅存进程内 Map 供看板展示；重启即清空，无持久化必要（对端 45s 重播兜底会补齐）
//   - 键控采信验签来源：Map 按 fromNodeId 键控（传输层签名验证过的来源），
//     snap.nodeId 是自报字段不采信；nodeName 取自快照（展示名仅作显示，无安全影响）
//   - 不重复校验形状：sync.handleIncoming 已过 isTaskSnapshot guard，
//     回调拿到的 snap 类型即保证（重复校验属冗余）
//   - staleness 双阈值：3 分钟 → stale=true（看板标「已离线?」，数据仍展示）；
//     5 分钟 → pruneStale 移除（getRemoteTasks 轮询点顺带清理，防 Map 无界增长）
import type { TaskSnapshot } from './protocols';

/** 远端节点任务镜像（getRemoteTasks 返回结构——preload/types.d.ts 的 RemoteNodeTasks 与此对齐） */
export interface RemoteNodeTasks {
  nodeId: string;
  nodeName: string;
  tasks: TaskSnapshot['tasks'];
  takenAt: number;
  stale: boolean;
}

/** stale 阈值：快照拍摄超此时长视为可能离线（仍展示，带标记） */
const STALE_AFTER_MS = 3 * 60_000;
/** prune 阈值：超此时长无更新的节点条目直接移除 */
const PRUNE_AFTER_MS = 5 * 60_000;

/** 模块级缓存——key = fromNodeId（验签来源），value = 最近一次快照 */
const cache = new Map<string, Omit<RemoteNodeTasks, 'stale'>>();

/**
 * 写入远端任务快照：同节点整条覆写（全量快照语义，旧任务不残留）。
 * by initP2p 的 onRemoteTaskSnapshot 回调调用（入站链路唯一写点）。
 */
export function writeTaskSnapshot(snap: TaskSnapshot, fromNodeId: string): void {
  cache.set(fromNodeId, {
    nodeId: fromNodeId,
    nodeName: snap.nodeName,
    tasks: snap.tasks,
    takenAt: snap.takenAt,
  });
}

/** 读取全部远端镜像——stale 按 now - takenAt > 3 分钟动态判定 */
export function getRemoteTasks(): RemoteNodeTasks[] {
  const now = Date.now();
  return Array.from(cache.values()).map((entry) => ({
    ...entry,
    stale: now - entry.takenAt > STALE_AFTER_MS,
  }));
}

/** 清理超 5 分钟无更新的节点条目——getRemoteTasks 轮询点顺带调用 */
export function pruneStale(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.takenAt > PRUNE_AFTER_MS) {
      cache.delete(key);
    }
  }
}

/** 清空缓存——测试隔离用（生产无调用点：重启自然清空 + prune 兜底） */
export function clearRemoteTaskCache(): void {
  cache.clear();
}
