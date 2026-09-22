// electron/src/main/agent/preset.ts
//
// 预设 agent 按需启用（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置）。
//
// 背景：registerBuiltinAgents（启动全量落库）自 v1.1 起不再被启动调用，builtin
// 内联 catalog 项 installable=false——预设 agent 的 def 从未进入 agent_definitions，
// 既无法配置 LLM 也无法加入会话。本模块是「按需启用」替代：
//   - enablePresetDef：解析 resources/agents/<slug>.yaml → 确定性 id builtin-<slug>
//     幂等落库（source='builtin'）→ 模型字段以入参覆盖 → 填充该条 builtinSuggestions
//   - enablePresetWithJoin：叠加「加入工作空间（幂等）+ 设默认」编排；
//     runtime 启动留在 IPC handler（与 agent:addMember 同模式——子进程 spawn
//     属外部边界，DB 语义在此层可测）
import {
  readBuiltinManifestBySlug,
  setBuiltinSuggestion,
} from './builtin';
import {
  saveAgentDefinition,
  addMember,
  generateAgentUserId,
  listMembers,
  assertThinkingConfigShape,
  getAgentDefinition,
  updateAgentDefinition,
} from './crud';
import { getProvider } from './provider-crud';
import { getWorkspace, setDefaultAgent } from '../workspace/crud';
import { isValidSlug } from '../marketplace/types';
import type { AgentDefinition, WorkspaceAgentMember } from './types';
import type { ThinkingConfig } from '../llm/provider-presets';

/** def 层入参（IPC EnablePresetInput 的子集） */
export interface EnablePresetDefInput {
  /** 预设 agent slug（须过 marketplace isValidSlug 白名单，防路径穿越） */
  slug: string;
  modelProviderId: string;
  modelName: string;
  /** agent 级思维覆盖；null=清除（继承模型级） */
  thinkingJson?: ThinkingConfig | null;
}

/** 完整入参（IPC 层直传形状） */
export interface EnablePresetWithJoinInput extends EnablePresetDefInput {
  /** 传入则加入该 workspace（幂等） */
  joinWorkspaceId?: string;
  /** 仅 joinWorkspaceId 存在时生效 */
  setAsDefault?: boolean;
}

export interface EnablePresetOutcome {
  def: AgentDefinition;
  member: WorkspaceAgentMember | null;
  /** 本次是否新加入（true 时 IPC handler 需启动 runtime） */
  joinedNow: boolean;
}

/** 启用预设 agent（def 层）。全部校验先于写库完成（源头拒绝，不留半启用态）。 */
export function enablePresetDef(input: EnablePresetDefInput): AgentDefinition {
  if (!isValidSlug(input.slug)) {
    throw new Error(`预设 slug 非法: ${input.slug}`);
  }
  const providerId = input.modelProviderId.trim();
  const modelName = input.modelName.trim();
  if (!providerId) throw new Error('modelProviderId 不能为空');
  if (!modelName) throw new Error('modelName 不能为空');
  if (!getProvider(providerId)) {
    throw new Error(`供应商不存在: ${providerId}（可能已被删除，请刷新供应商列表）`);
  }
  if (input.thinkingJson != null) assertThinkingConfigShape(input.thinkingJson);

  const { def: parsed, suggestion } = readBuiltinManifestBySlug(input.slug);
  // catalog 文件名与 YAML metadata.slug 漂移防御：解析后强制对齐，理论不可达
  // （catalog 索引按 slug 检索），但留契约守卫避免静默死循环——若未来允许
  // catalog 按路径直接载入而非 slug 索引，此处即可挡住错误启用。
  if (parsed.slug !== input.slug) {
    throw new Error(`预设 manifest slug 与请求不符: ${input.slug} vs ${parsed.slug}`);
  }
  const def: AgentDefinition = {
    ...parsed,
    id: `builtin-${parsed.slug}`,
    source: 'builtin',
    workspaceId: null,
    modelProviderId: providerId,
    modelName,
    thinkingJson: input.thinkingJson ?? null,
  };
  // 幂等写库分叉：已存在时走 UPDATE——saveAgentDefinition 的 INSERT OR REPLACE
  // 在 SQLite 里是 DELETE+INSERT，会触发 workspace_agent_members 的
  // ON DELETE CASCADE 连带清掉既有成员行；且成员被 workspaces.default_agent_instance_id
  // 引用时 REPLACE 直接 FOREIGN KEY 中止。UPDATE 路径无 DELETE，成员关系与
  // default 引用原样保留（重复启用幂等的正确语义）。
  const existingDef = getAgentDefinition(def.id);
  if (existingDef) {
    const updated = updateAgentDefinition({
      id: def.id,
      name: def.name,
      description: def.description,
      systemPrompt: def.systemPrompt,
      iconEmoji: def.iconEmoji,
      modelProviderId: providerId,
      modelName: def.modelName,
      defaultTools: def.defaultTools,
      defaultMcps: def.defaultMcps,
      defaultSkills: def.defaultSkills,
      thinkingJson: def.thinkingJson,
    });
    setBuiltinSuggestion(def.id, suggestion);
    return updated;
  }
  saveAgentDefinition(def);
  setBuiltinSuggestion(def.id, suggestion);
  return def;
}

/**
 * 启用 + 可选加入编排（DB 层；不启动 runtime）。
 * - joinWorkspaceId 缺省：仅落库，member=null
 * - 已加入（同 ws 同 def）：幂等返回既有 member，joinedNow=false
 * - setAsDefault 仅加入场景生效；失败上抛（def/member 已落库不回滚，重试安全）
 */
export async function enablePresetWithJoin(
  input: EnablePresetWithJoinInput,
): Promise<EnablePresetOutcome> {
  const def = enablePresetDef(input);
  if (!input.joinWorkspaceId) return { def, member: null, joinedNow: false };

  const workspace = getWorkspace(input.joinWorkspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${input.joinWorkspaceId}`);

  const existing = listMembers(input.joinWorkspaceId).find(
    (m) => m.agentDefinitionId === def.id,
  );
  if (existing) return { def, member: existing, joinedNow: false };

  const member = await addMember(input.joinWorkspaceId, def.id, generateAgentUserId(def.slug));
  if (input.setAsDefault) {
    setDefaultAgent(input.joinWorkspaceId, member.instanceId);
  }
  return { def, member, joinedNow: true };
}
