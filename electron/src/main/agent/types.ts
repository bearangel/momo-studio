// electron/src/main/agent/types.ts
//
// Agent 定义相关类型 — Declarative agent 的 YAML manifest 解析产物。
// M1 仅支持 runtime: 'declarative'，type 涵盖 standalone/main/sub 三种形态。
// M2 新增：MCP server 引用（McpRef）、Skill 引用（SkillRef），以及 parentAgentId
// 用于主子 agent 关联。

/** Agent 模型引用 */
export interface ModelRef {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKeyRef?: string;
}

/** Agent 工具引用 */
export interface ToolRef {
  kind: 'builtin';
  ref: string;
}

/** MCP server 引用 */
export interface McpRef {
  kind: 'mcp';
  /** MCP server 名（对应 McpDefinition.name） */
  ref: string;
  /** 版本范围（semver），如 "^1.0.0"，默认 "latest" */
  versionRange?: string;
}

/** Skill 引用 */
export interface SkillRef {
  kind: 'skill';
  /** skill slug */
  ref: string;
  versionRange?: string;
}

/** Declarative agent 定义（M1 仅支持此类型） */
export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: 'standalone' | 'main' | 'sub';
  runtime: 'declarative';
  systemPrompt: string;
  model: ModelRef;
  defaultTools: ToolRef[];
  source: 'builtin' | 'custom' | 'marketplace';
  description: string;
  iconEmoji: string;

  // === M2 新增 ===
  /** 父 agent ID（仅 type='sub' 时有值） */
  parentAgentId?: string;
  /** MCP server 引用列表 */
  defaultMcps: McpRef[];
  /** Skill 引用列表 */
  defaultSkills: SkillRef[];
}

/** Agent 在 workspace 中的实例化 */
export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;
}
