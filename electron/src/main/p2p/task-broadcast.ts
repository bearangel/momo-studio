// electron/src/main/p2p/task-broadcast.ts
//
// 任务快照出站广播（P4 Task 2）——本地任务写路径成功后触发全量快照广播。
//
// 设计要点：
//   - 触发策略：事件触发全量广播（同 protocols.ts TaskSnapshot 注释）——
//     task IPC 写通道（create/transition/cancel/start）与 scheduler 自动升级
//     成功后 fire-and-forget 调用，调用方无需 await、无需感知 P2P 状态
//   - 依赖装配：sync 实例 + 节点身份由 initP2p 注入、stopP2p 清空——镜像
//     index.ts 的模块级 sync 单例模式；未装配（P2P 未启用）时静默 no-op
//     （同 broadcastLocalMessage），本地写路径完全不受 P2P 启停影响
//   - 字段裁剪：TaskRow 全量 25 字段 → 快照 7 字段子集（看板镜像所需，
//     与 protocols.ts TaskSnapshot.tasks 的 Pick 定义一一对应）
//   - 容错：广播失败仅记 warn 日志不抛——快照广播是尽力而为，下一处写路径
//     事件会触发新快照自然补偿
import { logger } from '../logger';
import { listTasks, type TaskRow } from '../storage/tasks/repo';
import type { P2pSync } from './sync';
import type { TaskSnapshot } from './protocols';

/** 装配依赖——initP2p 成功后注入（sync 用 Pick 收窄到本模块实际用到的能力） */
export interface TaskBroadcastDeps {
  /** 广播通道（P2pSync 实例；结构类型便于测试注入最小桩） */
  sync: Pick<P2pSync, 'broadcastTaskSnapshot'>;
  /** 当前节点身份——快照 nodeId / nodeName 来源 */
  nodeId: string;
  nodeName: string;
}

/** 模块级单例（initP2p 装配，stopP2p 清空） */
let deps: TaskBroadcastDeps | null = null;

/** initP2p 装配调用：注入 P2pSync 实例 + 当前节点身份 */
export function setTaskBroadcastDeps(next: TaskBroadcastDeps): void {
  deps = next;
}

/** stopP2p 清空调用：回到"P2P 未启用"状态（广播静默 no-op） */
export function clearTaskBroadcastDeps(): void {
  deps = null;
}

/** TaskRow → 快照条目：裁剪到 TaskSnapshot.tasks 的 7 字段子集 */
function toSnapshotItem(row: TaskRow): TaskSnapshot['tasks'][number] {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 出站应用层：广播本地任务全量快照。
 *
 * listTasks({}) 全量扫描 → 裁剪字段 → sync.broadcastTaskSnapshot。
 * deps 未装配（P2P 未启用）时静默返回；失败仅记日志不抛（同
 * broadcastLocalMessage 容错模式）。调用方一律 fire-and-forget：
 * `void broadcastLocalTaskSnapshot()`。
 */
export async function broadcastLocalTaskSnapshot(): Promise<void> {
  if (!deps) return;
  try {
    const rows = listTasks({});
    const snapshot: TaskSnapshot = {
      nodeId: deps.nodeId,
      nodeName: deps.nodeName,
      tasks: rows.map(toSnapshotItem),
      takenAt: Date.now(),
    };
    await deps.sync.broadcastTaskSnapshot(snapshot);
  } catch (err) {
    logger.warn('P2P 任务快照广播失败', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
