// electron/src/main/p2p/protocols.ts
//
// P2P 协议载荷定义（P4）——四类新 payload 的 body 结构 + 手写形状 guard。
//
// 设计要点：
//   - TaskSnapshot.tasks 是 TaskRow 的 Pick 子集——传输瘦身（全表 25 字段，看板镜像只需 7 个）
//   - guard 全部手写 typeof/Array.isArray 检查（沿用 sync.ts 既有 guard 风格，不引 schema 库）
//   - 入站数据先过 guard 再分发；畸形数据静默丢弃——对端可能是旧版本节点，不能因协议
//     不匹配崩掉本地消息循环
//   - 资源目录只含清单元数据；完整定义经 resource-request / resource-provide 按需拉取
import type { TaskRow } from '../storage/tasks/repo';

/**
 * 任务快照——本节点看板的全量镜像。
 * 出站策略：事件触发全量广播（信任节点少、数据量小，不做增量 diff）。
 */
export interface TaskSnapshot {
  /** 广播方节点 ID */
  nodeId: string;
  /** 广播方展示名 */
  nodeName: string;
  /** 任务行子集（TaskRow Pick——只镜像看板展示所需字段） */
  tasks: Array<
    Pick<
      TaskRow,
      'id' | 'title' | 'status' | 'assigneeAgentId' | 'priority' | 'createdAt' | 'updatedAt'
    >
  >;
  /** 快照拍摄时间（毫秒时间戳）——远端缓存据此判 stale */
  takenAt: number;
}

/** 资源目录条目——节点可分享的 agent/mcp 清单（不含完整定义） */
export interface ResourceCatalogEntry {
  nodeId: string;
  nodeName: string;
  items: Array<{
    type: 'agent' | 'mcp';
    slug: string;
    name: string;
    description: string;
    version?: string;
  }>;
  takenAt: number;
}

/** 资源请求——向指定节点索要完整资源定义 */
export interface ResourceRequest {
  /** 请求 ID（供给回执据此关联） */
  requestId: string;
  resourceType: 'agent' | 'mcp';
  slug: string;
}

/** 资源供给——资源请求的回执，definition 为完整资源定义（JSON 结构化数据） */
export interface ResourceProvide {
  requestId: string;
  definition: Record<string, unknown>;
}

// ---- 手写形状 guard（sync.handleIncoming 入站分发前统一校验） ----

/** unknown → Record 窄化（排除 null/数组） */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** TaskSnapshot.tasks 单元素校验 */
function isTaskSnapshotItem(x: unknown): boolean {
  if (!isRecord(x)) return false;
  return (
    typeof x.id === 'string' &&
    typeof x.title === 'string' &&
    typeof x.status === 'string' &&
    (x.assigneeAgentId === null || typeof x.assigneeAgentId === 'string') &&
    typeof x.priority === 'number' &&
    typeof x.createdAt === 'number' &&
    typeof x.updatedAt === 'number'
  );
}

export function isTaskSnapshot(x: unknown): x is TaskSnapshot {
  if (!isRecord(x)) return false;
  return (
    typeof x.nodeId === 'string' &&
    typeof x.nodeName === 'string' &&
    Array.isArray(x.tasks) &&
    x.tasks.every(isTaskSnapshotItem) &&
    typeof x.takenAt === 'number'
  );
}

/** ResourceCatalogEntry.items 单元素校验 */
function isCatalogItem(x: unknown): boolean {
  if (!isRecord(x)) return false;
  if (x.type !== 'agent' && x.type !== 'mcp') return false;
  return (
    typeof x.slug === 'string' &&
    typeof x.name === 'string' &&
    typeof x.description === 'string' &&
    (x.version === undefined || typeof x.version === 'string')
  );
}

export function isResourceCatalogEntry(x: unknown): x is ResourceCatalogEntry {
  if (!isRecord(x)) return false;
  return (
    typeof x.nodeId === 'string' &&
    typeof x.nodeName === 'string' &&
    Array.isArray(x.items) &&
    x.items.every(isCatalogItem) &&
    typeof x.takenAt === 'number'
  );
}

export function isResourceRequest(x: unknown): x is ResourceRequest {
  if (!isRecord(x)) return false;
  return (
    typeof x.requestId === 'string' &&
    (x.resourceType === 'agent' || x.resourceType === 'mcp') &&
    typeof x.slug === 'string'
  );
}

export function isResourceProvide(x: unknown): x is ResourceProvide {
  if (!isRecord(x)) return false;
  return typeof x.requestId === 'string' && isRecord(x.definition);
}
