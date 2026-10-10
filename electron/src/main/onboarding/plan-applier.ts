// electron/src/main/onboarding/plan-applier.ts
//
// 方案应用（spec 2026-10-10 §6.3）：重校验（renderer 勾改过的 plan 不可盲信）
// → 顺序应用 → 幂等（preset 启用链幂等 + custom 按 name 查重复用 + 成员先查后加）。
// 任一步失败中断上抛，已应用项保留（真实可用配置非垃圾），整包重试安全。
import { randomUUID } from 'node:crypto';
import { getWorkspace, setDefaultAgent } from '../workspace/crud';
import { getProvider } from '../agent/provider-crud';
import { updateAgentDefinition, createCustomDef, addMember, generateAgentUserId } from '../agent/crud';
import { getAgentDefinition, listMembers, listAgentDefinitions } from '../agent/agent-queries';
import { enablePresetDef } from '../agent/preset';
import { listBuiltinPresetAgents } from '../agent/builtin';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled } from '../skill/zip-uploader';
import { SAFE_MINIMUM_TOOLS, ALL_BUILTIN_TOOLS } from '../agent/tools/catalog';
import { sanitizePlan, type OnboardingPlan } from './plan-types';
import type { ToolRef, McpRef, SkillRef, AgentDefinition } from '../agent/types';

/** 应用结果（与 renderer OnboardingApplyResult 同形） */
export interface OnboardingApplyResult {
  applied: Array<{ name: string; kind: 'preset' | 'custom'; instanceId: string }>;
  warnings: string[];
  defaultAgentName: string;
}

function toMcpRefs(names: string[]): McpRef[] {
  return names.map((ref) => ({ kind: 'mcp' as const, ref }));
}

function toSkillRefs(slugs: string[]): SkillRef[] {
  return slugs.map((ref) => ({ kind: 'skill' as const, ref }));
}

/** 幂等加入成员：已有同 def 成员则复用（spec §6.3 幂等关键点，preset.ts 同模式） */
async function joinWorkspace(
  workspaceId: string,
  def: AgentDefinition,
): Promise<{ instanceId: string; name: string }> {
  const existing = listMembers(workspaceId).find((m) => m.agentDefinitionId === def.id);
  if (existing) return { instanceId: existing.instanceId, name: existing.agentName };
  const member = await addMember(workspaceId, def.id, generateAgentUserId(def.slug));
  return { instanceId: member.instanceId, name: def.name };
}

/**
 * 应用配置方案（onboarding:applyPlan 数据面）。
 * custom agent 模型统一用入参 provider/model（spec §6.1：不暴露模型选择面）。
 */
export async function applyOnboardingPlan(input: {
  plan: OnboardingPlan;
  workspaceId: string;
  providerId: string;
  modelId: string;
}): Promise<OnboardingApplyResult> {
  const workspace = getWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${input.workspaceId}`);
  if (!getProvider(input.providerId)) throw new Error(`供应商不存在: ${input.providerId}`);

  // 应用侧重校验 + 双保险过滤（spec §6.2 / §7）
  const { plan, warnings } = sanitizePlan(input.plan, {
    presetSlugs: listBuiltinPresetAgents().map((p) => p.slug),
    mcpNames: listRegistered().map((m) => m.name),
    skillSlugs: listInstalled().map((s) => s.slug),
  });
  if (!plan) throw new Error(`方案无可应用的 agent：${warnings.join('；')}`);

  const applied: OnboardingApplyResult['applied'] = [];
  const members: Array<{ instanceId: string; name: string }> = [];

  for (const agent of plan.agents) {
    if (agent.kind === 'preset') {
      // 启用（幂等：已存在走 UPDATE，不触发成员 CASCADE——preset.ts 先例）
      let def = enablePresetDef({
        slug: agent.slug,
        modelProviderId: input.providerId,
        modelName: input.modelId,
      });
      // MCP/skill 同步：YAML 声明 ∪ 方案追加（sanitize 已过滤到注册集）
      const yamlMcps = new Set(def.defaultMcps.map((m) => m.ref));
      const yamlSkills = new Set(def.defaultSkills.map((s) => s.ref));
      const extraMcps = agent.mcps.filter((m) => !yamlMcps.has(m));
      const extraSkills = agent.skills.filter((s) => !yamlSkills.has(s));
      if (extraMcps.length > 0 || extraSkills.length > 0) {
        def = updateAgentDefinition({
          id: def.id,
          defaultMcps: [...def.defaultMcps, ...toMcpRefs(extraMcps)],
          defaultSkills: [...def.defaultSkills, ...toSkillRefs(extraSkills)],
        });
      }
      const member = await joinWorkspace(input.workspaceId, def);
      members.push(member);
      applied.push({ name: member.name, kind: 'preset', instanceId: member.instanceId });
    } else {
      // custom：按 name 查重复用（整包重试幂等，Review Focus 2）
      const existing = listAgentDefinitions().find(
        (d) => d.source === 'custom' && d.name === agent.name,
      );
      let defId: string;
      let name: string;
      if (existing) {
        defId = existing.id;
        name = existing.name;
      } else {
        // 工具档映射（spec §6.3）：standard → 安全最小集 / all → 全部内置工具
        const tools: ToolRef[] = (agent.toolPreset === 'all' ? ALL_BUILTIN_TOOLS : SAFE_MINIMUM_TOOLS).map(
          (ref) => ({ kind: 'builtin' as const, ref }),
        );
        const created = createCustomDef(null, {
          name: agent.name.trim(),
          slug: `onboarding-${randomUUID().slice(0, 8)}`,
          description: `引导创建: ${agent.name.trim()}`,
          systemPrompt: agent.systemPrompt.trim(),
          iconEmoji: agent.iconEmoji || '🤖',
          modelProviderId: input.providerId,
          modelName: input.modelId,
          defaultTools: tools,
          defaultMcps: toMcpRefs(agent.mcps),
          defaultSkills: toSkillRefs(agent.skills),
        });
        defId = created.id;
        name = created.name;
      }
      const def = getAgentDefinition(defId)!;
      const member = await joinWorkspace(input.workspaceId, def);
      members.push(member);
      applied.push({ name, kind: 'custom', instanceId: member.instanceId });
    }
  }

  const defaultIdx = Math.min(Math.max(plan.defaultAgentIndex, 0), members.length - 1);
  setDefaultAgent(input.workspaceId, members[defaultIdx]!.instanceId);

  return { applied, warnings, defaultAgentName: members[defaultIdx]!.name };
}
