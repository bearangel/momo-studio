// electron/src/main/agent/crud.ts
//
// Agent 定义与 workspace 分配的持久化层。
//
// v1.3 重构（migration v12）：definition 不再含 type/parent/model 字段（移到 assignment 或
// model_providers 引用）；assignment 加 role/parent_instance_id/has_api_key_override。
// agent_definitions 用 INSERT OR REPLACE 实现 upsert（以 id 为主键）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { setSecret, deleteSecret } from '../storage/keychain';
import { logger } from '../logger';
import { isAgentRunning, stopAgent } from './runtime-manager';
import { SAFE_MINIMUM_TOOLS } from './tools/catalog';
import type { AgentDefinition, AgentAssignment, AgentRole, ToolRef, McpRef, SkillRef } from './types';

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
 */
export function createCustomDef(workspaceId: string | null, input: CreateCustomDefInput): AgentDefinition {
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
    modelProviderId: input.modelProviderId,
    modelName: input.modelName,
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
 * 把某个 agent 定义分配到指定 workspace，绑定 bot 账号，写 role + parent_instance_id。
 *
 * v1.3：角色和父子关系在 assignment 级。校验：
 *  - role='sub' 必须传 parentInstanceId（同 ws 的 main assignment）
 *  - role!='sub' 不能传 parentInstanceId（强制 NULL）
 */
export function assignAgentToWorkspace(
  workspaceId: string,
  agentDefinitionId: string,
  botMatrixUserId: string,
  role: AgentRole,
  parentInstanceId: string | null = null,
): AgentAssignment {
  // 校验：role='sub' 必须有 parent
  if (role === 'sub' && !parentInstanceId) {
    throw new Error("role='sub' 必须指定 parentInstanceId");
  }
  // 校验：role!='sub' 时 parent 必须为 null
  if (role !== 'sub' && parentInstanceId !== null) {
    throw new Error(`role='${role}' 不可有 parentInstanceId`);
  }

  const instanceId = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_assignments
      (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, role, parent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, workspaceId, agentDefinitionId, botMatrixUserId, role, parentInstanceId);

  const row = db
    .prepare('SELECT * FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as AgentAssignmentRow;
  logger.info('Agent 已分配到 workspace', {
    workspaceId, agentDefinitionId, botMatrixUserId, role,
  });
  return rowToAssignment(row);
}

/** 修改现有 assignment 的角色/父。校验循环引用；UPDATE 不停止 runtime（IPC 层负责）。
 *  role!='sub' 时强制 parentInstanceId=NULL（即使传值也清空）。
 */
export function updateAssignmentRole(
  instanceId: string,
  role: AgentRole,
  parentInstanceId: string | null = null,
): void {
  if (role === 'sub' && !parentInstanceId) {
    throw new Error("role='sub' 必须指定 parentInstanceId");
  }
  // role!='sub' 时强制 parent=NULL（无视传入值）
  const effectiveParent = role === 'sub' ? parentInstanceId : null;

  // 校验循环引用：parent 链中不能包含自己
  if (effectiveParent) {
    const visited = new Set<string>();
    let cur: string | null = effectiveParent;
    while (cur) {
      if (cur === instanceId) {
        throw new Error('循环引用：parent 链中包含自己');
      }
      if (visited.has(cur)) break; // 防御性，避免极端情况下死循环
      visited.add(cur);
      const row = getDb()
        .prepare('SELECT parent_instance_id FROM agent_assignments WHERE instance_id = ?')
        .get(cur) as { parent_instance_id: string | null } | undefined;
      cur = row?.parent_instance_id ?? null;
    }
  }

  getDb()
    .prepare('UPDATE agent_assignments SET role = ?, parent_instance_id = ? WHERE instance_id = ?')
    .run(role, effectiveParent, instanceId);
}

/**
 * 设置/清除 assignment 的 API key override。
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
    db.prepare('UPDATE agent_assignments SET has_api_key_override = 0 WHERE instance_id = ?')
      .run(instanceId);
  } else {
    await setSecret(key, apiKey);
    db.prepare('UPDATE agent_assignments SET has_api_key_override = 1 WHERE instance_id = ?')
      .run(instanceId);
  }
}

/** 列出某 workspace 内、parent_instance_id 等于指定值的所有 assignment（查 subs） */
export function listSubAssignments(
  workspaceId: string,
  parentInstanceId: string,
): AgentAssignment[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM agent_assignments
       WHERE workspace_id = ? AND parent_instance_id = ?
       ORDER BY created_at ASC`,
    )
    .all(workspaceId, parentInstanceId) as AgentAssignmentRow[];
  return rows.map(rowToAssignment);
}

/**
 * 删除自定义 agent 定义。builtin 不可删。
 * 级联：停止全部引用此 def 的运行中实例 → 让 bot 离开房间（IPC 层负责）→
 * 清除 API key override（keychain）→ 删 assignment → 删 def 行。
 */
export async function deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }> {
  const def = getAgentDefinition(defId);
  if (!def) throw new Error(`未找到 agent 定义: ${defId}`);
  if (def.source === 'builtin') throw new Error('builtin agent 不可删除');

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM agent_assignments WHERE agent_definition_id = ?')
    .all(defId) as AgentAssignmentRow[];

  const stopped: string[] = [];
  for (const row of rows) {
    if (isAgentRunning(row.instance_id)) {
      stopAgent(row.instance_id);
      stopped.push(row.instance_id);
    }
    // 清除 API key override
    if (row.has_api_key_override === 1) {
      await deleteSecret(`agent.${row.instance_id}.api_key_override`);
    }
    db.prepare('DELETE FROM agent_assignments WHERE instance_id = ?').run(row.instance_id);
  }

  db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(defId);
  logger.info('agent 定义已删除', { defId, stoppedCount: stopped.length });
  return { stoppedInstanceIds: stopped };
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
