// electron/src/main/agent/assignment-capabilities.ts
//
// Per-assignment 能力 delta 持久化（Layer 3）。
// 数据表 agent_assignment_capabilities（migration v16 创建）。
// 合并算法在 capability-merger.ts 实现；本文件只管 CRUD。
//
// 字段命名严格按 task brief：addedTools/removedTools/addedMcps/... ——
// 后续 Task 3 的 mergeCapabilities 会消费本接口。

import { getDb } from '../storage/db';

/** 某 assignment 的能力 delta（按 add/remove 双向） */
export interface AssignmentDeltas {
  addedTools: string[];
  removedTools: string[];
  addedMcps: string[];
  removedMcps: string[];
  addedSkills: string[];
  removedSkills: string[];
}

interface DeltaRow {
  capability_type: string;
  mode: string;
  ref: string;
}

/** 读取某 assignment 的 deltas。无 delta 时返回全空对象。 */
export function getAssignmentDeltas(assignmentId: string): AssignmentDeltas {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT capability_type, mode, ref FROM agent_assignment_capabilities WHERE assignment_id = ?',
    )
    .all(assignmentId) as DeltaRow[];

  const result: AssignmentDeltas = {
    addedTools: [],
    removedTools: [],
    addedMcps: [],
    removedMcps: [],
    addedSkills: [],
    removedSkills: [],
  };

  // 按 capability_type × mode 路由到对应字段；未知类型静默跳过（前向兼容）
  const buckets: Record<string, { add: string[]; remove: string[] }> = {
    tool: { add: result.addedTools, remove: result.removedTools },
    mcp: { add: result.addedMcps, remove: result.removedMcps },
    skill: { add: result.addedSkills, remove: result.removedSkills },
  };

  for (const row of rows) {
    const bucket = buckets[row.capability_type];
    if (!bucket) continue;
    if (row.mode === 'add') bucket.add.push(row.ref);
    else if (row.mode === 'remove') bucket.remove.push(row.ref);
  }
  return result;
}

/**
 * 全量替换某 assignment 的 deltas。
 * 内部：DELETE WHERE assignment_id = ? → INSERT 新值（事务）。
 * 幂等：同 deltas 多次保存结果一致。
 */
export function setAssignmentDeltas(assignmentId: string, deltas: AssignmentDeltas): void {
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, ?, ?, ?)',
  );
  const del = db.prepare('DELETE FROM agent_assignment_capabilities WHERE assignment_id = ?');

  // 展开所有 delta 为行参数；顺序无关（全量替换）
  const ops: Array<[string, string, string, string]> = [
    ...deltas.addedTools.map((r): [string, string, string, string] => [assignmentId, 'tool', 'add', r]),
    ...deltas.removedTools.map((r): [string, string, string, string] => [assignmentId, 'tool', 'remove', r]),
    ...deltas.addedMcps.map((r): [string, string, string, string] => [assignmentId, 'mcp', 'add', r]),
    ...deltas.removedMcps.map((r): [string, string, string, string] => [assignmentId, 'mcp', 'remove', r]),
    ...deltas.addedSkills.map((r): [string, string, string, string] => [assignmentId, 'skill', 'add', r]),
    ...deltas.removedSkills.map((r): [string, string, string, string] => [assignmentId, 'skill', 'remove', r]),
  ];

  // 事务保证 DELETE + INSERT 原子：中途异常则回滚，避免丢数据
  const tx = db.transaction(() => {
    del.run(assignmentId);
    for (const op of ops) insert.run(...op);
  });
  tx();
}
