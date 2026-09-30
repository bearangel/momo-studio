// electron/src/main/agent/agent-queries.ts
//
// Agent 域只读查询叶子模块（行映射 + 列表/单条读取）。
//
// 为什么从 crud.ts 下沉（2026-09-30 工具目录派生改造，Task 3）：
//   tools/catalog.ts 改为从注册中心派生后引入 crud → catalog → tools/index 边，
//   与既有的 task-tools/session-tools/team → crud 回边构成循环依赖——
//   catalog 模块体顶层求值时 tools/index 尚未完成初始化，凡 import 链先触
//   index/crud 的模块全部崩（unconditionalModules is not a function）。
//   下沉 tools 域需要的只读查询到本叶子（只依赖 storage/db、llm/provider-presets、
//   ./types），tools 域不再反向依赖 crud 的 CUD 服务面，环断开。
//   crud.ts 对这些符号做 re-export——21 个既有调用方（renderer store 经 IPC、
//   init-runtime、preset 等）零改动。
// 断环先例：removeMcpRefsFromAgents 的放置决策（见 crud.ts 对应注释）。

import { getDb } from '../storage/db';
import { parseThinkingConfig } from '../llm/provider-presets';
import type { AgentDefinition, WorkspaceAgentMember } from './types';

/** agent_definitions 行的弱类型映射（v1.3 schema） */
export interface AgentDefRow {
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
  model_provider_id: string | null;
  model_name: string;
  task_driven: number;
  thinking_json: string | null;
}

/** workspace_agent_members 行的弱类型映射（v25 schema：无 role/parent/enabled）。
 *  导出供 team.ts 复用——WorkspaceAgentMember 行映射单点维护，防双映射漂移。
 *  v2.2：name/icon_emoji 为 JOIN agent_definitions 的可选展示列（单表 SELECT 路径无此二列）。 */
export interface WorkspaceMemberRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_user_id: string;
  api_key_override: number;
  last_running: number;
  created_at: string;
  name?: string;
  icon_emoji?: string;
}

/** 将 DB 行（snake_case + JSON 字符串）转换为强类型 AgentDefinition */
export function rowToDef(row: AgentDefRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    version: row.version,
    runtime: row.runtime as AgentDefinition['runtime'],
    systemPrompt: row.system_prompt,
    defaultTools: JSON.parse(row.default_tools) as AgentDefinition['defaultTools'],
    source: row.source as AgentDefinition['source'],
    description: row.description,
    iconEmoji: row.icon_emoji,
    defaultMcps: JSON.parse(row.default_mcps) as AgentDefinition['defaultMcps'],
    defaultSkills: JSON.parse(row.default_skills) as AgentDefinition['defaultSkills'],
    // v25 定义全局化：workspace_id 列已 DROP（migration v25），映射恒 null。
    // 字段保留是为 renderer 契约（types.d.ts），T12 起 UI 侧清理后可移除。
    workspaceId: null,
    modelProviderId: row.model_provider_id,
    modelName: row.model_name,
    createdAt: row.created_at,
    taskDriven: row.task_driven === 1,
    // v31：坏值容错读回 null（继承模型级），单行坏数据不炸列表
    thinkingJson: (() => {
      if (row.thinking_json === null) return null;
      try {
        return parseThinkingConfig(JSON.parse(row.thinking_json) as unknown);
      } catch {
        return null;
      }
    })(),
  };
}

/** 将 DB 行转换为强类型 WorkspaceAgentMember（team.ts 复用，见 WorkspaceMemberRow 导出说明） */
export function rowToMember(row: WorkspaceMemberRow): WorkspaceAgentMember {
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    agentUserId: row.agent_user_id,
    agentName: row.name ?? row.agent_user_id,
    iconEmoji: row.icon_emoji ?? '',
    hasApiKeyOverride: row.api_key_override === 1,
    lastRunning: row.last_running === 1,
    createdAt: row.created_at,
  };
}

/**
 * 列出 agent 定义。v25 定义全局化后 workspace 过滤退役（列已 DROP）——
 * 无论 workspaceId 是否提供均返回全部定义；参数保留只为调用方签名兼容
 * （renderer T12 清理后可移除）。
 */
export function listAgentDefinitions(workspaceId?: string): AgentDefinition[] {
  void workspaceId; // 兼容参数，语义退役
  const db = getDb();
  const rows = db
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

/** 列出某 workspace 下所有 agent 成员（v2.2：JOIN definitions 带出 agentName/iconEmoji） */
export function listMembers(workspaceId: string): WorkspaceAgentMember[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT wam.*, d.name, d.icon_emoji FROM workspace_agent_members wam
       JOIN agent_definitions d ON d.id = wam.agent_definition_id
       WHERE wam.workspace_id = ?`,
    )
    .all(workspaceId) as WorkspaceMemberRow[];
  return rows.map(rowToMember);
}
