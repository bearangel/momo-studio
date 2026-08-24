// electron/src/main/agent/capability-merger.ts
//
// 三层能力叠加合并 —— 把 agent 定义默认能力 + workspace 级共享能力 +
// per-assignment delta 合并为最终可用清单。
//
// 三层模型：
//   Layer 1: AgentDefinition.default*   —— agent 定义自带的默认能力（base）
//   Layer 2: WorkspaceAllocation        —— workspace 内所有 agent 共享的能力（增量）
//   Layer 3: AssignmentDeltas           —— per-assignment 加/减 delta（v1.6 新增）
//
// 合并规则：
//   Step 1：Layer 1 ∪ Layer 2（并集去重，向后兼容 v1.5）
//   Step 2：仅当传入 deltas 时：result = (Step 1 ∪ added) - removed
//   冲突：同 ref 同时 added + removed 时 removed 胜出（保守语义）——
//         先 union added、再 subtract removed 的顺序天然保证这一点。
//
// 不传 deltas（或传 undefined）时严格走 v1.5 路径，不调用 union/subtract helper，
// 保证现有调用方零改动、行为零回归。

import type { AgentDefinition, ToolRef, McpRef, SkillRef } from './types';
import { getAllocation, type WorkspaceAllocation } from '../workspace/allocation';
import { getAssignmentDeltas, type AssignmentDeltas } from './assignment-capabilities';

// 重新导出类型——能力读取消费方（spawn-helpers 等）只需从 capability-merger
// 单一入口导入，避免在多个 CRUD 模块间跳读类型。
export type { WorkspaceAllocation } from '../workspace/allocation';
export type { AssignmentDeltas } from './assignment-capabilities';

/** 合并后的最终可用能力清单（ref 字符串列表，已去重） */
export interface MergedCapabilities {
  tools: string[];
  mcps: string[];
  skills: string[];
}

/**
 * 并集去重，保留首次出现的顺序。
 * 用 Set 去重后展开；JS Set 按插入顺序遍历，故结果顺序稳定可预期。
 */
export function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * 集合差：从 a 中移除所有出现在 b 里的元素。b 中不存在于 a 的元素是 no-op。
 */
export function subtract(set: string[], removed: string[]): string[] {
  const rset = new Set(removed);
  return set.filter((x) => !rset.has(x));
}

/**
 * 三层能力叠加：default(def) ∪ workspace(allocation) [∪ added - removed]。
 *
 * - 不传 deltas（v1.5 行为）：仅合并 Layer 1 + Layer 2，向后兼容。
 * - 传 deltas：先 Layer 1 ∪ Layer 2，再 ∪ added，再 - removed。
 *   同 ref 同时 added + removed 时 removed 胜出（由 union→subtract 顺序保证）。
 */
export function mergeCapabilities(
  def: AgentDefinition,
  allocation: WorkspaceAllocation,
  deltas?: AssignmentDeltas,
): MergedCapabilities {
  const defTools = def.defaultTools.map((t: ToolRef) => t.ref);
  const defMcps = def.defaultMcps.map((m: McpRef) => m.ref);
  const defSkills = def.defaultSkills.map((s: SkillRef) => s.ref);

  // Step 1：Layer 1 ∪ Layer 2（与 v1.5 完全一致的路径）
  let tools = [...new Set([...defTools, ...allocation.tools])];
  let mcps = [...new Set([...defMcps, ...allocation.mcps])];
  let skills = [...new Set([...defSkills, ...allocation.skills])];

  // Step 2：叠加 Layer 3 deltas（仅当调用方传入时）
  // 注意：空 deltas（全空数组）进入此分支也是 no-op，等价于不传。
  if (deltas) {
    tools = subtract(union(tools, deltas.addedTools), deltas.removedTools);
    mcps = subtract(union(mcps, deltas.addedMcps), deltas.removedMcps);
    skills = subtract(union(skills, deltas.addedSkills), deltas.removedSkills);
  }

  return { tools, mcps, skills };
}

/**
 * Layer 2 读取门面：能力消费方（spawn-helpers 等）的唯一入口。
 * 内部委托给 workspace/allocation.getAllocation；spawn 路径不再直接
 * import 原 CRUD 模块。
 */
export function readAllocationLayer(workspaceId: string): WorkspaceAllocation {
  return getAllocation(workspaceId);
}

/**
 * Layer 3 读取门面：能力消费方（spawn-helpers 等）的唯一入口。
 * 内部委托给 agent/assignment-capabilities.getAssignmentDeltas。
 */
export function readAssignmentDeltas(instanceId: string): AssignmentDeltas {
  return getAssignmentDeltas(instanceId);
}
