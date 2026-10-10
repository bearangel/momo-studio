// electron/src/main/onboarding/plan-types.ts
//
// OnboardingPlan 的 electron 侧类型 + shape guard + sanitize（spec 2026-10-10 §6）。
// 类型与 renderer/src/ipc/types.d.ts 同形独立定义（repo 跨进程惯例：仅结构对齐）。
// sanitize 是生成侧与应用侧共用的双保险过滤（spec §7）：引用只认白名单，
// 剔除一律出 warning 不静默。
export interface PlanPresetAgent {
  kind: 'preset';
  slug: string;
  reason: string;
  mcps: string[];
  skills: string[];
}

export interface PlanCustomAgent {
  kind: 'custom';
  name: string;
  iconEmoji: string;
  systemPrompt: string;
  toolPreset: 'standard' | 'all';
  reason: string;
  mcps: string[];
  skills: string[];
}

export type PlanAgent = PlanPresetAgent | PlanCustomAgent;

export interface OnboardingPlan {
  agents: PlanAgent[];
  defaultAgentIndex: number;
}

/** 方案 agent 数上限（spec §6.1 硬性规则） */
export const MAX_PLAN_AGENTS = 5;

/** sanitize 白名单上下文：预制 slug / 已注册 MCP 名 / 已安装 skill slug */
export interface PlanSanitizeContext {
  presetSlugs: string[];
  mcpNames: string[];
  skillSlugs: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

function isPresetAgent(v: Record<string, unknown>): boolean {
  return (
    typeof v.slug === 'string' &&
    typeof v.reason === 'string' &&
    isStringArray(v.mcps) &&
    isStringArray(v.skills)
  );
}

function isCustomAgent(v: Record<string, unknown>): boolean {
  return (
    typeof v.name === 'string' &&
    typeof v.iconEmoji === 'string' &&
    typeof v.systemPrompt === 'string' &&
    (v.toolPreset === 'standard' || v.toolPreset === 'all') &&
    typeof v.reason === 'string' &&
    isStringArray(v.mcps) &&
    isStringArray(v.skills)
  );
}

/** OnboardingPlan shape guard（LLM 输出 / renderer 勾改回传共用） */
export function isOnboardingPlan(v: unknown): v is OnboardingPlan {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.agents) || o.agents.length === 0) return false;
  if (typeof o.defaultAgentIndex !== 'number') return false;
  return o.agents.every((a) => {
    if (typeof a !== 'object' || a === null) return false;
    const agent = a as Record<string, unknown>;
    if (agent.kind === 'preset') return isPresetAgent(agent);
    if (agent.kind === 'custom') return isCustomAgent(agent);
    return false;
  });
}

/**
 * 白名单过滤 + 上限截断 + 越界钳制（spec §6.1 生成侧 / §6.2 应用前共用）。
 * 返回 plan=null 表示无可应用项（调用方据此报错）。
 */
export function sanitizePlan(
  raw: unknown,
  ctx: PlanSanitizeContext,
): { plan: OnboardingPlan | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!isOnboardingPlan(raw)) {
    return { plan: null, warnings: ['配置方案格式无效'] };
  }
  const mcpSet = new Set(ctx.mcpNames);
  const skillSet = new Set(ctx.skillSlugs);
  const slugSet = new Set(ctx.presetSlugs);

  const agents: PlanAgent[] = [];
  for (const a of raw.agents) {
    if (agents.length >= MAX_PLAN_AGENTS) break;
    if (a.kind === 'preset' && !slugSet.has(a.slug)) {
      warnings.push(`预制 agent「${a.slug}」不在预置清单，已剔除`);
      continue;
    }
    if (a.kind === 'custom' && (a.name.trim() === '' || a.systemPrompt.trim() === '')) {
      warnings.push(`自定义 agent「${a.name || '(未命名)'}」名称或提示词为空，已剔除`);
      continue;
    }
    const agentLabel = a.kind === 'preset' ? a.slug : a.name;
    const mcps = a.mcps.filter((m) => {
      if (mcpSet.has(m)) return true;
      warnings.push(`MCP「${m}」未注册，已从「${agentLabel}」剔除`);
      return false;
    });
    const skills = a.skills.filter((s) => {
      if (skillSet.has(s)) return true;
      warnings.push(`Skill「${s}」未安装，已从「${agentLabel}」剔除`);
      return false;
    });
    agents.push({ ...a, mcps, skills });
  }
  if (raw.agents.length > MAX_PLAN_AGENTS) {
    warnings.push(`方案 agent 数超过 ${MAX_PLAN_AGENTS}，已截断到前 ${MAX_PLAN_AGENTS} 个`);
  }
  if (agents.length === 0) {
    return { plan: null, warnings: [...warnings, '过滤后无可应用的 agent'] };
  }
  let defaultAgentIndex = raw.defaultAgentIndex;
  if (defaultAgentIndex < 0 || defaultAgentIndex >= agents.length) {
    warnings.push(`defaultAgentIndex=${defaultAgentIndex} 越界，已钳制到 0`);
    defaultAgentIndex = 0;
  }
  return { plan: { agents, defaultAgentIndex }, warnings };
}
