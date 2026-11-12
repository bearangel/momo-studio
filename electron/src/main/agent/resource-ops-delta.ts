// electron/src/main/agent/resource-ops-delta.ts
// member 级能力增量计算的单一真相源（spec §6.4）。
// 铁律：本模块零运行时 import（类型除外）——parity 测试跨 workspace 引 renderer
// capability-helpers，任何 electron 依赖都会把渲染层测试环境拽进来。
// 语义对齐 renderer computeDeltas：新终态 = (现状 ∪ add) − remove；
// deltas = 终态相对基线的差（added = 终态−基线，removed = 基线−终态）。
import type { AssignmentDeltas } from './assignment-capabilities';

export interface CapabilityDeltaInput { skills?: string[]; mcps?: string[]; tools?: string[]; pluginTools?: string[] }
export interface CapabilityChangeRequest { add?: CapabilityDeltaInput; remove?: CapabilityDeltaInput }
export interface DeltaBaseline { tools: string[]; mcps: string[]; skills: string[]; baseGrantedPlugin: string[] }
export interface EffectiveState { tools: string[]; mcps: string[]; skills: string[]; grantedPlugin: string[] }

function union(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])]; }
function subtract(a: string[], b: string[]): string[] { const s = new Set(b); return a.filter((x) => !s.has(x)); }

/** 数组入参归一：非数组或含非字符串项 → undefined（调用方 fail-fast 已挡，这里防御归一） */
function refs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }

export function applyCapabilityDelta(base: DeltaBaseline, current: EffectiveState, req: CapabilityChangeRequest): AssignmentDeltas {
  // 终态 = (现状 ∪ add) − remove（union→subtract 顺序天然保证「同 ref add+remove → remove 胜」）
  const add = req.add ?? {};
  const rm = req.remove ?? {};
  const nextTools = subtract(union(current.tools, refs(add.tools)), refs(rm.tools));
  const nextMcps = subtract(union(current.mcps, refs(add.mcps)), refs(rm.mcps));
  const nextSkills = subtract(union(current.skills, refs(add.skills)), refs(rm.skills));
  const nextPlugin = subtract(union(current.grantedPlugin, refs(add.pluginTools)), refs(rm.pluginTools));
  return {
    addedTools: subtract(nextTools, base.tools),
    removedTools: subtract(base.tools, nextTools),
    addedMcps: subtract(nextMcps, base.mcps),
    removedMcps: subtract(base.mcps, nextMcps),
    addedSkills: subtract(nextSkills, base.skills),
    removedSkills: subtract(base.skills, nextSkills),
    addedPluginTools: subtract(nextPlugin, base.baseGrantedPlugin),
    removedPluginTools: subtract(base.baseGrantedPlugin, nextPlugin),
  };
}
