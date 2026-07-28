// electron/src/main/workspace/allocation.ts
//
// Workspace 级能力分配 CRUD —— 管理哪些 MCP / Skill / Tool 是 workspace 级共享的。
//
// 这是三层能力叠加模型中的第二层（WorkspaceAllocation）：
//   Layer 1: AgentDefinition.default*   —— agent 定义自带的默认能力
//   Layer 2: WorkspaceAllocation        —— 本文件，workspace 内所有 agent 共享的能力
//   Layer 3: AgentAssignment.extra      —— （后续 task 引入）单次分配的额外能力
//
// 持久化在 workspace_allocations 表（migration v5 创建），主键三列组合
// (workspace_id, capability_type, capability_ref) 保证同一能力不会被重复加入。

import { getDb } from '../storage/db';
import { logger } from '../logger';

/** 能力类型：tool（内置工具）/ mcp（MCP server）/ skill（技能） */
export type CapabilityType = 'tool' | 'mcp' | 'skill';

/** 某 workspace 的全部能力分配（按类型分组） */
export interface WorkspaceAllocation {
  workspaceId: string;
  tools: string[];
  mcps: string[];
  skills: string[];
}

interface AllocationRow {
  capability_type: string;
  capability_ref: string;
}

/**
 * 读取某 workspace 的全部能力分配，按类型分桶返回。
 * 未分配任何能力时返回空数组（而非 null），方便上层直接展开。
 */
export function getAllocation(workspaceId: string): WorkspaceAllocation {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT capability_type, capability_ref FROM workspace_allocations WHERE workspace_id = ?',
    )
    .all(workspaceId) as AllocationRow[];

  const result: WorkspaceAllocation = { workspaceId, tools: [], mcps: [], skills: [] };
  for (const row of rows) {
    if (row.capability_type === 'tool') result.tools.push(row.capability_ref);
    else if (row.capability_type === 'mcp') result.mcps.push(row.capability_ref);
    else if (row.capability_type === 'skill') result.skills.push(row.capability_ref);
  }
  return result;
}

/**
 * 为某 workspace 增加一条能力分配。
 * 使用 INSERT OR IGNORE：重复添加同一能力是幂等的（主键冲突时静默跳过）。
 */
export function addAllocation(workspaceId: string, type: CapabilityType, ref: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES (?, ?, ?)',
  ).run(workspaceId, type, ref);
  logger.info('能力分配已添加', { workspaceId, type, ref });
}

/**
 * 移除某 workspace 的一条能力分配。
 * 不存在时 DELETE 不会报错，故无需额外守卫。
 */
export function removeAllocation(workspaceId: string, type: CapabilityType, ref: string): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM workspace_allocations WHERE workspace_id = ? AND capability_type = ? AND capability_ref = ?',
  ).run(workspaceId, type, ref);
}
