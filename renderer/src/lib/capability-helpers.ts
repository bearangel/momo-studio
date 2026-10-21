// renderer/src/lib/capability-helpers.ts
//
// 三层能力模型的共享纯函数库（v1.6 Task 11 自成员能力弹窗抽取）。
// 供 MemberEditDialog、DefinitionEditor 等组件复用，
// 避免在多个组件里重复 def→caps 扁平化、default 合并、delta 计算/比较逻辑。
//
// 三层能力模型：
//   Layer 1 = agent 定义默认能力（def.defaultTools/Mcps/Skills）
//   Layer 2 = workspace 级能力分配（allocation 表）
//   Layer 3 = per-assignment override（deltas）
//
// 合并规则（保序去重并集）：
//   default = Layer1 ∪ Layer2
//   value   = (default + deltas.addedX) - deltas.removedX  ← 从已存 deltas 反推
//   保存时：addedX = value - default；removedX = default - value
import type { AgentDefinition, AssignmentDeltas, WorkspaceAllocation } from '../ipc/types';

/**
 * 能力集合：三类能力的当前勾选值（绝对集合，与 mode 无关）。
 * CapabilityTabs 组件以此作为 value/defaultValue 的类型。
 */
export interface Capabilities {
  tools: string[];
  mcps: string[];
  skills: string[];
}

/** 全空 deltas 常量，表示「无任何 override」 */
export const EMPTY_DELTAS: AssignmentDeltas = {
  addedTools: [],
  removedTools: [],
  addedMcps: [],
  removedMcps: [],
  addedSkills: [],
  removedSkills: [],
  addedPluginTools: [],
  removedPluginTools: [],
};

/** 把 def 的 Ref 形态能力（含 kind 字段）扁平化为 CapabilityTabs 期望的 string[] */
export function defToCapabilities(def: AgentDefinition): Capabilities {
  return {
    tools: def.defaultTools.map((t) => t.ref),
    mcps: (def.defaultMcps ?? []).map((m) => m.ref),
    skills: (def.defaultSkills ?? []).map((s) => s.ref),
  };
}

/** 合并 def 默认能力 + workspace allocation（保序去重并集） */
export function mergeDefault(defCaps: Capabilities, alloc: WorkspaceAllocation): Capabilities {
  const union = (a: string[], b: string[]): string[] => {
    const seen = new Set(a);
    const out = [...a];
    for (const x of b) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  };
  return {
    tools: union(defCaps.tools, alloc.tools),
    mcps: union(defCaps.mcps, alloc.mcps),
    skills: union(defCaps.skills, alloc.skills),
  };
}

/** 反推 value = (default + added) - removed */
export function applyDeltas(defaults: Capabilities, deltas: AssignmentDeltas): Capabilities {
  const apply = (base: string[], added: string[], removed: string[]): string[] => {
    const set = new Set(base);
    for (const a of added) set.add(a);
    for (const r of removed) set.delete(r);
    return Array.from(set);
  };
  return {
    tools: apply(defaults.tools, deltas.addedTools, deltas.removedTools),
    mcps: apply(defaults.mcps, deltas.addedMcps, deltas.removedMcps),
    skills: apply(defaults.skills, deltas.addedSkills, deltas.removedSkills),
  };
}

/** 计算 deltas：added = value - default；removed = default - value */
export function computeDeltas(value: Capabilities, defaults: Capabilities): AssignmentDeltas {
  const diff = (from: string[], minus: string[]): string[] =>
    from.filter((x) => !minus.includes(x));
  return {
    addedTools: diff(value.tools, defaults.tools),
    removedTools: diff(defaults.tools, value.tools),
    addedMcps: diff(value.mcps, defaults.mcps),
    removedMcps: diff(defaults.mcps, value.mcps),
    addedSkills: diff(value.skills, defaults.skills),
    removedSkills: diff(defaults.skills, value.skills),
    // plugin 覆盖不走 Capabilities diff 模型（成员级独立状态，MemberEditDialog 持有）
    addedPluginTools: [],
    removedPluginTools: [],
  };
}

/** 比较两组 deltas 是否完全相等（顺序无关） */
export function deltasEqual(a: AssignmentDeltas, b: AssignmentDeltas): boolean {
  const sameSet = (x: string[], y: string[]): boolean =>
    x.length === y.length && x.every((v) => y.includes(v));
  return (
    sameSet(a.addedTools, b.addedTools) &&
    sameSet(a.removedTools, b.removedTools) &&
    sameSet(a.addedMcps, b.addedMcps) &&
    sameSet(a.removedMcps, b.removedMcps) &&
    sameSet(a.addedSkills, b.addedSkills) &&
    sameSet(a.removedSkills, b.removedSkills) &&
    sameSet(a.addedPluginTools ?? [], b.addedPluginTools ?? []) &&
    sameSet(a.removedPluginTools ?? [], b.removedPluginTools ?? [])
  );
}

/** deltas 全空（六个数组都为空）→ 无需写入 Layer 3 */
export function isEmptyDeltas(deltas: AssignmentDeltas): boolean {
  return (
    deltas.addedTools.length === 0 &&
    deltas.removedTools.length === 0 &&
    deltas.addedMcps.length === 0 &&
    deltas.removedMcps.length === 0 &&
    deltas.addedSkills.length === 0 &&
    deltas.removedSkills.length === 0
  );
}


/** 成员级插件工具授权换算（spec 2026-10-21 §6——翻转旧 denied 模型）：
 *  生效 = (ws 授权 ∪ added) − (removed ∪ def 禁)。勾 = 写 added 授权行（并清该名
 *  removed）；取消 = 写 removed 行（并清 added——ws 级授权的成员级取消）。
 *  changed 可为精确名或 `plugin:<id>/*` 组模式串（electron toolRefMatches 命中）。 */
export function computePluginToolGrants(
  _defDenied: string[],
  deltas: Pick<AssignmentDeltas, 'addedPluginTools' | 'removedPluginTools'>,
  changed: string,
  on: boolean,
): { addedPluginTools: string[]; removedPluginTools: string[] } {
  const added = new Set(deltas.addedPluginTools ?? []);
  const removed = new Set(deltas.removedPluginTools ?? []);
  if (on) {
    removed.delete(changed);
    added.add(changed);
  } else {
    added.delete(changed);
    removed.add(changed);
  }
  return { addedPluginTools: [...added], removedPluginTools: [...removed] };
}

/** 模式串命中：精确名或 `plugin:<id>/*` 组前缀（与 electron toolRefMatches 同款） */
function matchesToolPattern(fullName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === fullName) return true;
    if (p.endsWith('/*') && fullName.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** 成员级插件工具生效授权集（渲染初值，spec §6 公式）：
 *  工具全名域 = (wsGranted ∪ added) 授予 − (removed ∪ def 禁)，模式串展开语义
 *  与 electron spawn 侧 toolRefMatches 完全对齐 */
export function effectivePluginGranted(
  defDenied: string[],
  deltas: Pick<AssignmentDeltas, 'addedPluginTools' | 'removedPluginTools'>,
  wsGranted: string[],
  toolFullNames: string[],
): string[] {
  const grant = [...wsGranted, ...(deltas.addedPluginTools ?? [])];
  const deny = [...defDenied, ...(deltas.removedPluginTools ?? [])];
  return toolFullNames.filter((n) => matchesToolPattern(n, grant) && !matchesToolPattern(n, deny));
}
