// electron/src/main/agent/crud.ts
//
// Agent 定义与 workspace 分配的持久化层。
//
// v1.3 重构（migration v12）：definition 不再含 type/parent/model 字段（移到 assignment 或
// model_providers 引用）；assignment 加 role/parent_instance_id/has_api_key_override。
// agent_definitions 用 INSERT OR REPLACE 实现 upsert（以 id 为主键）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { setSecret } from '../storage/keychain';
import { logger } from '../logger';
import { isAgentRunning, stopAgent } from './runtime-manager';
import type { AgentDefinition, AgentAssignment, AgentRole, ToolRef } from './types';

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
}

/** agent_assignments 行的弱类型映射（v1.3 schema） */
interface AgentAssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
  created_at: string;
  role: string;
  parent_instance_id: string | null;
  has_api_key_override: number;
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
  };
}

/** 将 DB 行转换为强类型 AgentAssignment */
function rowToAssignment(row: AgentAssignmentRow): AgentAssignment {
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    botMatrixUserId: row.bot_matrix_user_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    role: row.role as AgentRole,
    parentInstanceId: row.parent_instance_id,
    hasApiKeyOverride: row.has_api_key_override === 1,
  };
}

/** 新增或覆盖写入一条 agent 定义（以 id 为唯一键） */
export function saveAgentDefinition(def: AgentDefinition): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_definitions
      (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
       source, description, icon_emoji, workspace_id, model_provider_id, model_name)
     VALUES
      (@id, @name, @slug, @version, @runtime, @system_prompt, @default_tools, @default_mcps, @default_skills,
       @source, @description, @icon_emoji, @workspace_id, @model_provider_id, @model_name)`,
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
 * 把某个 agent 定义分配到指定 workspace，绑定一个 bot matrix 账号，返回新建的 assignment。
 *
 * v1.3：role + parentInstanceId 在 assignment 级。本函数 v1.3 兼容版仅写默认 role='standalone'；
 * 带 role/parent 的版本由 addToWorkspace helper（ipc.handlers.ts）调用，
 * 或 T4 引入的扩展签名 assignAgentToWorkspaceWithRole。
 */
export function assignAgentToWorkspace(
  workspaceId: string,
  agentDefinitionId: string,
  botMatrixUserId: string,
): AgentAssignment {
  const instanceId = randomUUID();
  const db = getDb();
  // role/parent_instance_id/has_api_key_override 走 schema 默认值
  db.prepare(
    `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(instanceId, workspaceId, agentDefinitionId, botMatrixUserId);

  const row = db
    .prepare('SELECT * FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as AgentAssignmentRow;
  logger.info('Agent 已分配到 workspace', {
    workspaceId,
    agentDefinitionId,
    botMatrixUserId,
  });
  return rowToAssignment(row);
}

/** 列出某 workspace 下所有 agent 分配记录 */
export function listAssignments(workspaceId: string): AgentAssignment[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM agent_assignments WHERE workspace_id = ?')
    .all(workspaceId) as AgentAssignmentRow[];
  return rows.map(rowToAssignment);
}

/** keychain 引用 key：agent.<instanceId>.llm_api_key（旧版兼容；v1.3 起优先用 api_key_override） */
export function llmApiKeyRef(instanceId: string): string {
  return `agent.${instanceId}.llm_api_key`;
}

/**
 * 更新 agent 定义字段（v1.3 schema：不含 type/parent/model_provider/model_base_url）。
 * workspaceId 显式传 null 表示转 global；传字符串表示绑定该 workspace；undefined 不改。
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
}): AgentDefinition {
  const existing = getAgentDefinition(input.id);
  if (!existing) throw new Error(`Agent 定义不存在: ${input.id}`);
  const db = getDb();
  db.prepare(
    `UPDATE agent_definitions SET
       name = ?, description = ?, system_prompt = ?, icon_emoji = ?,
       workspace_id = ?, model_provider_id = ?, model_name = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    input.systemPrompt ?? existing.systemPrompt,
    input.iconEmoji ?? existing.iconEmoji,
    input.workspaceId !== undefined ? input.workspaceId : existing.workspaceId,
    input.modelProviderId !== undefined ? input.modelProviderId : existing.modelProviderId,
    input.modelName ?? existing.modelName,
    input.id,
  );
  return getAgentDefinition(input.id)!;
}

/** 列出某定义的全部 assignment instanceId（调用方再按 isAgentRunning 过滤） */
export function listRunningInstanceIdsByDefinition(definitionId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT instance_id FROM agent_assignments WHERE agent_definition_id = ?')
    .all(definitionId) as { instance_id: string }[];
  return rows.map((r) => r.instance_id);
}

/** 更新实例的 LLM apiKey（旧版：写入 keychain agent.<instanceId>.llm_api_key） */
export async function updateAgentApiKey(instanceId: string, newKey: string): Promise<void> {
  await setSecret(llmApiKeyRef(instanceId), newKey);
}

/** 停止某定义的全部运行中实例（编辑 def 后调用，让用户手动重启应用新配置） */
export function stopRunningInstancesByDefinition(definitionId: string): string[] {
  const stopped: string[] = [];
  for (const instanceId of listRunningInstanceIdsByDefinition(definitionId)) {
    if (isAgentRunning(instanceId)) {
      stopAgent(instanceId);
      stopped.push(instanceId);
    }
  }
  return stopped;
}
