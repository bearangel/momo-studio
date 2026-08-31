// electron/src/main/agent/crud.ts
//
// Agent 定义与 workspace 分配的持久化层。
//
// v1.3 重构（migration v12）：definition 不再含 type/parent/model 字段（移到 assignment 或
// model_providers 引用）；assignment 加 role/parent_instance_id/has_api_key_override。
// agent_definitions 用 INSERT OR REPLACE 实现 upsert（以 id 为主键）。

import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { setSecret, deleteSecret } from '../storage/keychain';
import { logger } from '../logger';
import { isAgentRunning } from './runtime-status';
import { stopAgentRuntime } from './runtime-registry';
import { SAFE_MINIMUM_TOOLS } from './tools/catalog';
import { getGlobalSettings } from '../settings/crud';
import { getProvider } from './provider-crud';
import type { AgentDefinition, WorkspaceAgentMember, ToolRef, McpRef, SkillRef } from './types';

/** 规范化 slug：小写、连续非字母数字折叠为单短横线、去首尾短横线 */
function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 6 字符随机后缀（base64url 字母表），保证同名 agent 重复分配不撞身份 */
function randomSuffix(): string {
  return randomBytes(4).toString('base64url').slice(0, 6);
}

/**
 * v2（Task 10）：生成本地 agent 身份 `agent-<slug>-<6位随机后缀>`。
 * 取代在 Matrix homeserver 上注册 bot 账号——agent_user_id 仅是本地展示/引用键，
 * 不再对应任何远端账号，也因此无需 keychain 凭据。
 */
export function generateAgentUserId(slug: string): string {
  const normalized = slugify(slug) || 'agent';
  return `agent-${normalized}-${randomSuffix()}`;
}

/**
 * v1.6 Task 9：createCustomDef 入参。
 * defaultTools/Mcps/Skills 可选；缺省时分别为 SAFE_MINIMUM_TOOLS / [] / []。
 */
export interface CreateCustomDefInput {
  name: string;
  slug: string;
  /** 可选；缺省 = 空串 */
  description?: string;
  systemPrompt: string;
  /** 可选；缺省 = '🤖' */
  iconEmoji?: string;
  modelProviderId: string;
  modelName: string;
  /** v1.6：默认工具，缺省 = SAFE_MINIMUM_TOOLS（kind='builtin'） */
  defaultTools?: ToolRef[];
  /** v1.6：默认 MCP，缺省 = [] */
  defaultMcps?: McpRef[];
  /** v1.6：默认 Skill，缺省 = [] */
  defaultSkills?: SkillRef[];
}

/**
 * v1.6 Task 9：创建自定义 agent 定义。
 * 不再 inline 在 ipc.handlers 里，便于单测 + 复用。
 * workspaceId 传 null=global，传字符串=该 workspace 私有。
 *
 * P3 Task 2：会话模型 fallback 消费——若 modelProviderId 缺省（空串），
 * 尝试从 getGlobalSettings().defaultChatModel 兜底（前提：引用的 provider 行仍存在）；
 * 兜底不可用 → 抛「未配置 modelProviderId」错误。仅影响新建路径，存量 def 不动。
 */
export function createCustomDef(workspaceId: string | null, input: CreateCustomDefInput): AgentDefinition {
  // P3 Task 2：会话模型 fallback——仅当 modelProviderId 缺省时消费全局默认；modelName 一并由 default 提供
  let effectiveProviderId = input.modelProviderId?.trim() ?? '';
  let effectiveModelName = input.modelName?.trim() ?? '';
  if (!effectiveProviderId) {
    const defaultRef = getGlobalSettings().defaultChatModel;
    if (defaultRef && getProvider(defaultRef.providerId)) {
      effectiveProviderId = defaultRef.providerId;
      effectiveModelName = defaultRef.modelId;
      logger.info('createCustomDef 消费 defaultChatModel 兜底', {
        slug: input.slug,
        providerId: effectiveProviderId,
        modelId: effectiveModelName,
      });
    } else {
      // ghost provider：defaultChatModel 已设但 provider 行已删——可诊断信号，需 warn 便于排查
      if (defaultRef) {
        logger.warn('defaultChatModel 引用的 provider 不存在，跳过兜底', {
          providerId: defaultRef.providerId,
        });
      }
      throw new Error(
        '未配置 modelProviderId：请在表单选择供应商，或在「设置 → 默认模型」中设置 defaultChatModel',
      );
    }
  }

  const def: AgentDefinition = {
    id: randomUUID(),
    name: input.name,
    slug: input.slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: input.systemPrompt,
    // 缺省 = SAFE_MINIMUM_TOOLS（kind='builtin'），避免新 agent 在用户未审查情况下拿到 bash 等高危权限
    defaultTools: input.defaultTools ?? SAFE_MINIMUM_TOOLS.map((ref) => ({ kind: 'builtin' as const, ref })),
    defaultMcps: input.defaultMcps ?? [],
    defaultSkills: input.defaultSkills ?? [],
    source: 'custom',
    description: input.description ?? '',
    iconEmoji: input.iconEmoji ?? '🤖',
    workspaceId,
    modelProviderId: effectiveProviderId,
    modelName: effectiveModelName,
  };
  saveAgentDefinition(def);
  logger.info('自定义 Agent 定义已创建', { slug: def.slug, workspaceId });
  return def;
}

/** agent_definitions 行的弱类型映射（v1.3 schema） */
interface AgentDefRow {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: string;
  system_prompt: string;
  default_tools: string;
  default_mcps: string;
  default_skills: string;
  source: string;
  description: string;
  icon_emoji: string;
  created_at: string;
  workspace_id: string | null;
  model_provider_id: string | null;
  model_name: string;
  task_driven: number;
}

/** workspace_agent_members 行的弱类型映射（v25 schema：无 role/parent/enabled） */
interface WorkspaceMemberRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_user_id: string;
  api_key_override: number;
  last_running: number;
  created_at: string;
}

/** 将 DB 行（snake_case + JSON 字符串）转换为强类型 AgentDefinition */
function rowToDef(row: AgentDefRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    version: row.version,
    runtime: row.runtime as AgentDefinition['runtime'],
    systemPrompt: row.system_prompt,
    defaultTools: JSON.parse(row.default_tools) as ToolRef[],
    source: row.source as AgentDefinition['source'],
    description: row.description,
    iconEmoji: row.icon_emoji,
    defaultMcps: JSON.parse(row.default_mcps) as AgentDefinition['defaultMcps'],
    defaultSkills: JSON.parse(row.default_skills) as AgentDefinition['defaultSkills'],
    workspaceId: row.workspace_id,
    modelProviderId: row.model_provider_id,
    modelName: row.model_name,
    createdAt: row.created_at,
    taskDriven: row.task_driven === 1,
  };
}

/** 将 DB 行转换为强类型 WorkspaceAgentMember */
function rowToMember(row: WorkspaceMemberRow): WorkspaceAgentMember {
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    agentUserId: row.agent_user_id,
    hasApiKeyOverride: row.api_key_override === 1,
    lastRunning: row.last_running === 1,
    createdAt: row.created_at,
  };
}

/** 新增或覆盖写入一条 agent 定义（以 id 为唯一键） */
export function saveAgentDefinition(def: AgentDefinition): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_definitions
      (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
       source, description, icon_emoji, workspace_id, model_provider_id, model_name, task_driven)
     VALUES
      (@id, @name, @slug, @version, @runtime, @system_prompt, @default_tools, @default_mcps, @default_skills,
       @source, @description, @icon_emoji, @workspace_id, @model_provider_id, @model_name, @task_driven)`,
  ).run({
    id: def.id,
    name: def.name,
    slug: def.slug,
    version: def.version,
    runtime: def.runtime,
    system_prompt: def.systemPrompt,
    default_tools: JSON.stringify(def.defaultTools),
    default_mcps: JSON.stringify(def.defaultMcps ?? []),
    default_skills: JSON.stringify(def.defaultSkills ?? []),
    source: def.source,
    description: def.description,
    icon_emoji: def.iconEmoji,
    workspace_id: def.workspaceId,
    model_provider_id: def.modelProviderId,
    model_name: def.modelName,
    task_driven: 1, // Task 13 起 v1 长存进程双轨已删，恒为 task-driven
  });
}

/**
 * 列出 agent 定义。workspaceId 提供时只返回 global + 该 workspace scoped + 全部 builtin。
 * workspaceId 缺省时返回全部。
 */
export function listAgentDefinitions(workspaceId?: string): AgentDefinition[] {
  const db = getDb();
  const rows = workspaceId
    ? db
        .prepare(
          `SELECT * FROM agent_definitions
           WHERE workspace_id IS NULL OR workspace_id = ?
           ORDER BY source ASC, created_at DESC`,
        )
        .all(workspaceId) as AgentDefRow[]
    : db
        .prepare('SELECT * FROM agent_definitions ORDER BY source ASC, created_at DESC')
        .all() as AgentDefRow[];
  return rows.map(rowToDef);
}

/** 按 id 取单条 agent 定义，不存在返回 null */
export function getAgentDefinition(id: string): AgentDefinition | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agent_definitions WHERE id = ?')
    .get(id) as AgentDefRow | undefined;
  return row ? rowToDef(row) : null;
}

/**
 * removeMember 结果（spec §4.1）：
 *  - `{ ok: true }`：已删除（或本就不存在——幂等）
 *  - `{ ok: false, blockedTeams }`：命中 leader 守卫，blockedTeams 为该成员担任
 *    leader 的团队名列表（供 UI 提示「先换 leader 或解散团队」）
 */
export type RemoveMemberResult = { ok: true } | { ok: false; blockedTeams: string[] };

/**
 * 把某个 agent 定义加入指定 workspace（v25 成员制，spec §4.1）。
 * 同 ws 同 def 唯一（idx_wam_unique）——重复添加 throw（先检友好报错，
 * UNIQUE 索引兜底并发窗口）。
 * apiKeyOverride 非空时同步写 keychain + DB 标志（复用 updateAssignmentApiKey）。
 *
 * 注：brief 接口原文为同步签名，但 keychain setSecret 仅异步实现（keytar），
 * 故为 async——见 task-3-report 偏离记录。
 */
export async function addMember(
  workspaceId: string,
  agentDefinitionId: string,
  agentUserId: string,
  apiKeyOverride?: string,
): Promise<WorkspaceAgentMember> {
  const db = getDb();
  const dup = db
    .prepare(
      'SELECT instance_id FROM workspace_agent_members WHERE workspace_id = ? AND agent_definition_id = ?',
    )
    .get(workspaceId, agentDefinitionId);
  if (dup) {
    throw new Error(`该 agent 定义已加入 workspace ${workspaceId}，不可重复添加`);
  }

  const instanceId = randomUUID();
  db.prepare(
    `INSERT INTO workspace_agent_members
      (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(instanceId, workspaceId, agentDefinitionId, agentUserId);

  if (apiKeyOverride) {
    await updateAssignmentApiKey(instanceId, apiKeyOverride);
  }

  const row = db
    .prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?')
    .get(instanceId) as WorkspaceMemberRow;
  logger.info('Agent 已加入 workspace', {
    workspaceId, agentDefinitionId, agentUserId,
  });
  return rowToMember(row);
}

/**
 * 移除 workspace 成员（spec §4.1 leader 守卫）：
 *  1. 是任一团队的 leader → 拒绝，返回 blockedTeams（团队名列表），零破坏
 *  2. 非 leader → 单事务：置空引用它的 default_agent_instance_id
 *     （该 FK 无 ON DELETE 动作，不先置空则 DELETE 直接 FK 中止）
 *     + 删成员行（session_members / team_members 由 FK ON DELETE CASCADE 级联清理，
 *     已建会话快照的消息不受影响）
 * 幂等：不存在的 instanceId 返回 ok。
 */
export function removeMember(instanceId: string): RemoveMemberResult {
  const db = getDb();

  // leader 守卫（brief 指定 SQL）：teams.leader_instance_id 有 ON DELETE CASCADE，
  // 不拦截的话删成员会连带解散整个团队——必须显式拒绝
  const blockedTeams = db
    .prepare('SELECT t.name FROM teams t WHERE t.leader_instance_id = ?')
    .all(instanceId) as { name: string }[];
  if (blockedTeams.length > 0) {
    logger.warn('移除成员被拒：该 agent 是团队 leader', {
      instanceId,
      blockedTeams: blockedTeams.map((t) => t.name),
    });
    return { ok: false, blockedTeams: blockedTeams.map((t) => t.name) };
  }

  db.transaction(() => {
    db.prepare(
      'UPDATE workspaces SET default_agent_instance_id = NULL WHERE default_agent_instance_id = ?',
    ).run(instanceId);
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run(instanceId);
  })();
  return { ok: true };
}

/**
 * 设置/清除成员的 API key override。
 *  - 非空 apiKey：写入 keychain 'agent.<instanceId>.api_key_override' + DB 标志=1
 *  - null：删除 keychain + DB 标志=0（回退到供应商默认 key）
 */
export async function updateAssignmentApiKey(
  instanceId: string,
  apiKey: string | null,
): Promise<void> {
  const key = `agent.${instanceId}.api_key_override`;
  const db = getDb();
  if (apiKey === null) {
    await deleteSecret(key);
    db.prepare('UPDATE workspace_agent_members SET api_key_override = 0 WHERE instance_id = ?')
      .run(instanceId);
  } else {
    await setSecret(key, apiKey);
    db.prepare('UPDATE workspace_agent_members SET api_key_override = 1 WHERE instance_id = ?')
      .run(instanceId);
  }
}

/**
 * 删除自定义 agent 定义。builtin 不可删。
 * 级联：停止全部引用此 def 的运行中实例 →
 * 清除 API key override（keychain）→ 删成员行（FK 级联清 session_members/team_members）→ 删 def 行。
 */
export async function deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }> {
  const def = getAgentDefinition(defId);
  if (!def) throw new Error(`未找到 agent 定义: ${defId}`);
  if (def.source === 'builtin') throw new Error('builtin agent 不可删除');

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM workspace_agent_members WHERE agent_definition_id = ?')
    .all(defId) as WorkspaceMemberRow[];

  const stopped: string[] = [];
  for (const row of rows) {
    if (isAgentRunning(row.instance_id)) {
      await stopAgentRuntime(row.instance_id);
      stopped.push(row.instance_id);
    }
    // 清除 API key override
    if (row.api_key_override === 1) {
      await deleteSecret(`agent.${row.instance_id}.api_key_override`);
    }
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run(row.instance_id);
  }

  db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(defId);
  logger.info('agent 定义已删除', { defId, stoppedCount: stopped.length });
  return { stoppedInstanceIds: stopped };
}

/** 列出某 workspace 下所有 agent 成员 */
export function listMembers(workspaceId: string): WorkspaceAgentMember[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM workspace_agent_members WHERE workspace_id = ?')
    .all(workspaceId) as WorkspaceMemberRow[];
  return rows.map(rowToMember);
}

/** keychain 引用 key：agent.<instanceId>.llm_api_key（旧版兼容；v1.3 起优先用 api_key_override） */
export function llmApiKeyRef(instanceId: string): string {
  return `agent.${instanceId}.llm_api_key`;
}

/**
 * 更新 agent 定义字段（v1.3 schema：不含 type/parent/model_provider/model_base_url）。
 * workspaceId 显式传 null 表示转 global；传字符串表示绑定该 workspace；undefined 不改。
 *
 * v1.6：新增可选 defaultTools/defaultMcps/defaultSkills 入参，含则更新，不含保留原值（向后兼容）。
 */
export function updateAgentDefinition(input: {
  id: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  iconEmoji?: string;
  /** NULL=global，string=该 workspace 私有；undefined=不改 */
  workspaceId?: string | null;
  modelProviderId?: string;
  modelName?: string;
  /** v1.6：默认工具；undefined=不改，传值（含空数组）= 覆盖 */
  defaultTools?: ToolRef[];
  /** v1.6：默认 MCP；undefined=不改，传值（含空数组）= 覆盖 */
  defaultMcps?: McpRef[];
  /** v1.6：默认 Skill；undefined=不改，传值（含空数组）= 覆盖 */
  defaultSkills?: SkillRef[];
}): AgentDefinition {
  const existing = getAgentDefinition(input.id);
  if (!existing) throw new Error(`Agent 定义不存在: ${input.id}`);
  const db = getDb();
  db.prepare(
    `UPDATE agent_definitions SET
       name = ?, description = ?, system_prompt = ?, icon_emoji = ?,
       workspace_id = ?, model_provider_id = ?, model_name = ?,
       default_tools = ?, default_mcps = ?, default_skills = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    input.systemPrompt ?? existing.systemPrompt,
    input.iconEmoji ?? existing.iconEmoji,
    input.workspaceId !== undefined ? input.workspaceId : existing.workspaceId,
    input.modelProviderId !== undefined ? input.modelProviderId : existing.modelProviderId,
    input.modelName ?? existing.modelName,
    input.defaultTools !== undefined ? JSON.stringify(input.defaultTools) : JSON.stringify(existing.defaultTools),
    input.defaultMcps !== undefined ? JSON.stringify(input.defaultMcps) : JSON.stringify(existing.defaultMcps),
    input.defaultSkills !== undefined ? JSON.stringify(input.defaultSkills) : JSON.stringify(existing.defaultSkills),
    input.id,
  );
  return getAgentDefinition(input.id)!;
}

/** 列出某定义的全部成员 instanceId（调用方再按 isAgentRunning 过滤） */
export function listRunningInstanceIdsByDefinition(definitionId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT instance_id FROM workspace_agent_members WHERE agent_definition_id = ?')
    .all(definitionId) as { instance_id: string }[];
  return rows.map((r) => r.instance_id);
}

/** 更新实例的 LLM apiKey（旧版：写入 keychain agent.<instanceId>.llm_api_key） */
export async function updateAgentApiKey(instanceId: string, newKey: string): Promise<void> {
  await setSecret(llmApiKeyRef(instanceId), newKey);
}

/** 停止某定义的全部运行中实例（编辑 def 后调用，让用户手动重启应用新配置） */
export async function stopRunningInstancesByDefinition(definitionId: string): Promise<string[]> {
  const stopped: string[] = [];
  for (const instanceId of listRunningInstanceIdsByDefinition(definitionId)) {
    if (isAgentRunning(instanceId)) {
      await stopAgentRuntime(instanceId);
      stopped.push(instanceId);
    }
  }
  return stopped;
}
