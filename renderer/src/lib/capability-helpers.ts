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
import type { AgentDefinition, AssignmentDeltas, EffectiveCapabilities, WorkspaceAllocation } from '../ipc/types';

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

/** def 级生效能力降级形态（spec 2026-10-22 §6.1 消费契约）：
 *  agent:getEffectiveCapabilities 的 record 缺 key 是合法态——用 def 默认清单补位
 *  （deniedTools 取 def 级基线），供 AgentPickerCard 三弹窗降级展示。
 *  禁止用空桶 {tools:[],…} 冒充降级——那会把未知成员显示成零能力。 */
export function defToEffectiveCaps(def: AgentDefinition): EffectiveCapabilities {
  return {
    tools: def.defaultTools.map((t) => t.ref),
    mcps: (def.defaultMcps ?? []).map((m) => m.ref),
    skills: (def.defaultSkills ?? []).map((s) => s.ref),
    deniedTools: def.deniedTools ?? [],
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
 *  工具全名域 = (授权基线 ∪ added) 授予 − (removed ∪ def 禁)，模式串展开语义
 *  与 electron spawn 侧 toolRefMatches 完全对齐。
 *  授权基线（2026-11-04 def 声明纳入）= ws allocation 的 plugin: refs ∪
 *  def.defaultTools 的 plugin: refs——与 MCP/Skill「定义声明是合法授权通道」对齐 */
export function effectivePluginGranted(
  defDenied: string[],
  deltas: Pick<AssignmentDeltas, 'addedPluginTools' | 'removedPluginTools'>,
  granted: string[],
  toolFullNames: string[],
): string[] {
  const grant = [...granted, ...(deltas.addedPluginTools ?? [])];
  const deny = [...defDenied, ...(deltas.removedPluginTools ?? [])];
  return toolFullNames.filter((n) => matchesToolPattern(n, grant) && !matchesToolPattern(n, deny));
}

/** 定义级换算（deniedTools 整体清单维护；原 PluginToolsSection 导出，2026-11-04
 *  组件并入 ToolPickerPanel 后纯函数落 capability-helpers）：
 *  changed 形态两种——整组模式 `plugin:<id>/*` 或精确名 `plugin:<id>/<name>`。
 *  组模式存在时开单个工具 = 摘组模式 + 展开其余精确名（保持其余仍禁）。 */
export function computeDeniedTools(
  current: string[],
  pluginId: string,
  toolFullNames: string[],
  changed: string,
  on: boolean,
): string[] {
  const group = `plugin:${pluginId}/*`;
  if (!on) {
    if (changed === group) return [...new Set([...current, group])];
    const hadGroup = current.includes(group);
    const base = current.filter((p) => p !== group);
    const rest = hadGroup ? toolFullNames.filter((n) => n !== changed) : [];
    return [...new Set([...base, changed, ...rest])];
  }
  if (changed === group) {
    return current.filter((p) => p !== group && !p.startsWith(`plugin:${pluginId}/`));
  }
  // 组模式下开单个：摘组模式，其余仍禁的展开为精确名（语义连续不跳变）
  const hadGroup = current.includes(group);
  const base = current.filter((p) => p !== group && p !== changed);
  const rest = hadGroup ? toolFullNames.filter((n) => n !== changed) : [];
  return [...base, ...rest];
}

/** denied 模式串命中（精确名或组前缀）——DefinitionEditor 由 deniedTools 换算
 *  checked 用；AgentPickerCard 徽标展示用 */
export function deniedMatch(fullName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === fullName) return true;
    if (p.endsWith('/*') && fullName.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}
