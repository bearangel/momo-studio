// electron/src/main/agent/crud.ts
//
// Agent 定义与 workspace 分配的持久化层。
// agent_definitions 用 INSERT OR REPLACE 实现 upsert（以 id 为主键，重新导入同 id 的 manifest 会覆盖旧版本）；
// agent_assignments 每次分配生成新的 instance_id，便于同一 workspace 中同一 agent 定义挂多个 bot 账号。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { setSecret } from '../storage/keychain';
import { logger } from '../logger';
import { isAgentRunning, stopAgent } from './runtime-manager';
import type { AgentDefinition, AgentAssignment, ToolRef } from './types';

/** agent_definitions 行的弱类型映射，仅用于 DB 读写边界 */
interface AgentDefRow {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: string;
  runtime: string;
  system_prompt: string;
  model_provider: string;
  model_name: string;
  model_base_url: string | null;
  default_tools: string;
  source: string;
  description: string;
  icon_emoji: string;
  parent_agent_id: string | null;
  default_mcps: string;
  default_skills: string;
}

/** agent_assignments 行的弱类型映射 */
interface AgentAssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
  created_at: string;
}

/** 将 DB 行（snake_case + JSON 字符串）转换为强类型 AgentDefinition */
function rowToDef(row: AgentDefRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    version: row.version,
    type: row.type as AgentDefinition['type'],
    runtime: row.runtime as AgentDefinition['runtime'],
    systemPrompt: row.system_prompt,
    model: {
      provider: row.model_provider as AgentDefinition['model']['provider'],
      model: row.model_name,
      baseUrl: row.model_base_url ?? undefined,
    },
    defaultTools: JSON.parse(row.default_tools) as ToolRef[],
    source: row.source as AgentDefinition['source'],
    description: row.description,
    iconEmoji: row.icon_emoji,
    parentAgentId: row.parent_agent_id ?? undefined,
    defaultMcps: JSON.parse(row.default_mcps) as AgentDefinition['defaultMcps'],
    defaultSkills: JSON.parse(row.default_skills) as AgentDefinition['defaultSkills'],
  };
}

/** 将 DB 行转换为强类型 AgentAssignment（enabled 由 0/1 映射为 boolean） */
function rowToAssignment(row: AgentAssignmentRow): AgentAssignment {
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    botMatrixUserId: row.bot_matrix_user_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/** 新增或覆盖写入一条 agent 定义（以 id 为唯一键） */
export function saveAgentDefinition(def: AgentDefinition): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_definitions
     (id, name, slug, version, type, runtime, system_prompt, model_provider, model_name, model_base_url, default_tools, source, description, icon_emoji, parent_agent_id, default_mcps, default_skills)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    def.id,
    def.name,
    def.slug,
    def.version,
    def.type,
    def.runtime,
    def.systemPrompt,
    def.model.provider,
    def.model.model,
    def.model.baseUrl ?? null,
    JSON.stringify(def.defaultTools),
    def.source,
    def.description,
    def.iconEmoji,
    def.parentAgentId ?? null,
    JSON.stringify(def.defaultMcps),
    JSON.stringify(def.defaultSkills),
  );
}

/** 列出全部 agent 定义，按创建时间倒序（最新导入的排前面） */
export function listAgentDefinitions(): AgentDefinition[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM agent_definitions ORDER BY created_at DESC')
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

/** 把某个 agent 定义分配到指定 workspace，绑定一个 bot matrix 账号，返回新建的 assignment */
export function assignAgentToWorkspace(
  workspaceId: string,
  agentDefinitionId: string,
  botMatrixUserId: string,
): AgentAssignment {
  const instanceId = randomUUID();
  const db = getDb();
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

/** keychain 引用 key：agent.<instanceId>.llm_api_key（与 ipc.handlers 一致） */
export function llmApiKeyRef(instanceId: string): string {
  return `agent.${instanceId}.llm_api_key`;
}

/**
 * 更新 agent 定义（定义层字段，不含 apiKey）。详见 v1.1 设计 3.1。
 * slug 只读（身份标识），不在此函数可改字段内。
 * v1.2 扩展：支持 type（standalone/main/sub）与 parentAgentId 字段，
 * 子类型（sub）必须挂父 agent；standalone/main 改写时自动清空 parentAgentId。
 */
export function updateAgentDefinition(input: {
  id: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  modelProvider?: string;
  modelName?: string;
  modelBaseUrl?: string;
  iconEmoji?: string;
  type?: 'standalone' | 'main' | 'sub';
  parentAgentId?: string;
}): AgentDefinition {
  const existing = getAgentDefinition(input.id);
  if (!existing) throw new Error(`Agent 定义不存在: ${input.id}`);
  const db = getDb();
  // model 三字段合并更新
  const newProvider = input.modelProvider ?? existing.model.provider;
  const newModel = input.modelName ?? existing.model.model;
  const newBaseUrl = input.modelBaseUrl !== undefined ? input.modelBaseUrl : (existing.model.baseUrl ?? null);
  // type 与 parentAgentId 合并更新：
  // 不传 type 则保留原值；传 standalone/main 时清空 parentAgentId；
  // 传 sub 时若显式给 parentAgentId 则覆盖，否则保留原值。
  const newType = input.type ?? existing.type;
  const newParentAgentId = newType === 'sub'
    ? (input.parentAgentId !== undefined ? input.parentAgentId : existing.parentAgentId)
    : undefined;
  db.prepare(
    `UPDATE agent_definitions SET
       name = ?, description = ?, system_prompt = ?,
       model_provider = ?, model_name = ?, model_base_url = ?,
       icon_emoji = ?, type = ?, parent_agent_id = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    input.systemPrompt ?? existing.systemPrompt,
    newProvider,
    newModel,
    newBaseUrl,
    input.iconEmoji ?? existing.iconEmoji,
    newType,
    newParentAgentId ?? null,
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

/** 更新实例的 LLM apiKey（写入 keychain 槽 agent.<instanceId>.llm_api_key） */
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
