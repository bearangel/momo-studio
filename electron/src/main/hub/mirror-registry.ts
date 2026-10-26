// electron/src/main/hub/mirror-registry.ts
//
// M2.1 Task 6 / RM-M21-7：镜像登记表（workspace_mirror_registry，迁移 069）。
// 数据源单一：workspace.mirrored 组内广播（hub/index.ts 透传点累积登记——
// 此前该事件零消费，T3 曾以任务史推导已镜像空间被判 declined 假阳性）。
// 消费方四家同源：T3 节点卡已镜像徽标 / T4 查看选择器 / T7 调度器 mirroredBy /
// T8 新建弹窗守门。
//
// 失忆限制（有意为之，非缺陷遗漏）：M2 协议无事件重放、无查询式清单 RPC——
// 本表只累积本机在线期间收到的组内广播。晚入组 / 离线期间发生的镜像不可恢复
// （重启前已镜像节点若无新事件不自动回表），直至同组×同节点×同空间下一次
// 镜像事件到达。M3 票：hub 查询式清单 RPC（node.joined 时拉全量对账）。
//
// mirrored_at 取本机收事件时刻（协议 WorkspaceMirroredEvent 无 at 字段）。
import type { Database } from 'better-sqlite3';

/** 登记行（camelCase——IPC 查询面直出形状） */
export interface MirrorRegistryRow {
  id: number;
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  snapshotId: string;
  mirroredAt: number;
}

/** workspace.mirrored 事件的最小登记键（广播载荷的子集——异形载荷在事件桥先验形状） */
export interface MirrorRegistryEvent {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  snapshotId: string;
}

interface SqlRow {
  id: number;
  group_id: string;
  target_node_id: string;
  workspace_name: string;
  snapshot_id: string;
  mirrored_at: number;
}

function rowToCamel(r: SqlRow): MirrorRegistryRow {
  return {
    id: r.id,
    groupId: r.group_id,
    targetNodeId: r.target_node_id,
    workspaceName: r.workspace_name,
    snapshotId: r.snapshot_id,
    mirroredAt: r.mirrored_at,
  };
}

export interface MirrorRegistry {
  /** 累积登记：同组×同节点×同空间覆盖 snapshot_id/mirrored_at（最新版本语义），不增行 */
  record(evt: MirrorRegistryEvent): void;
  /** 查询面：workspaceName 可选过滤（T8 守门按空间 / T3 徽标按节点各自再过滤） */
  list(workspaceName?: string): MirrorRegistryRow[];
}

export function createMirrorRegistry(db: Database): MirrorRegistry {
  const recordStmt = db.prepare(
    `INSERT INTO workspace_mirror_registry (group_id, target_node_id, workspace_name, snapshot_id, mirrored_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id, target_node_id, workspace_name) DO UPDATE SET
       snapshot_id = excluded.snapshot_id,
       mirrored_at = excluded.mirrored_at`,
  );
  const listStmt = db.prepare(
    'SELECT * FROM workspace_mirror_registry ORDER BY mirrored_at DESC, id DESC',
  );
  const listByWsStmt = db.prepare(
    'SELECT * FROM workspace_mirror_registry WHERE workspace_name = ? ORDER BY mirrored_at DESC, id DESC',
  );
  return {
    record(evt) {
      recordStmt.run(evt.groupId, evt.targetNodeId, evt.workspaceName, evt.snapshotId, Date.now());
    },
    list(workspaceName) {
      const rows =
        workspaceName === undefined
          ? (listStmt.all() as SqlRow[])
          : (listByWsStmt.all(workspaceName) as SqlRow[]);
      return rows.map(rowToCamel);
    },
  };
}
