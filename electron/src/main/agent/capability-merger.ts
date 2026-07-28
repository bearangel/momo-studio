// electron/src/main/agent/capability-merger.ts
//
// 三层能力叠加合并 —— 把 agent 定义默认能力与 workspace 级共享能力合并为最终可用清单。
//
// 三层模型：
//   Layer 1: AgentDefinition.default*   —— agent 定义自带的默认能力（base）
//   Layer 2: WorkspaceAllocation        —— workspace 内所有 agent 共享的能力（增量）
//   Layer 3: AgentAssignment.extra      —— 单次分配额外能力（后续 task 引入，当前未实现）
//
// 合并规则：并集去重。Layer 2 是 Layer 1 的超集补充，相同 ref 只保留一份。
// 当前实现合并 Layer 1 + Layer 2；Layer 3 引入后在此函数追加一层 union。

import type { AgentDefinition, ToolRef, McpRef, SkillRef } from './types';
import type { WorkspaceAllocation } from '../workspace/allocation';

/** 合并后的最终可用能力清单（ref 字符串列表，已去重） */
export interface MergedCapabilities {
  tools: string[];
  mcps: string[];
  skills: string[];
}

/**
 * 三层能力叠加：default(def) ∪ workspace(allocation)，并集去重。
 * Layer 3（AgentAssignment.extra）当前 schema 尚未引入，预留扩展点。
 */
export function mergeCapabilities(
  def: AgentDefinition,
  allocation: WorkspaceAllocation,
): MergedCapabilities {
  const defTools = def.defaultTools.map((t: ToolRef) => t.ref);
  const defMcps = def.defaultMcps.map((m: McpRef) => m.ref);
  const defSkills = def.defaultSkills.map((s: SkillRef) => s.ref);

  return {
    tools: [...new Set([...defTools, ...allocation.tools])],
    mcps: [...new Set([...defMcps, ...allocation.mcps])],
    skills: [...new Set([...defSkills, ...allocation.skills])],
  };
}
