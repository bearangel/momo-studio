// electron/src/main/agent/types.ts
//
// Agent 定义相关类型 — Declarative agent 的 YAML manifest 解析产物。
//
// v1.3 重构（migration v12）：把角色和父子关系从 definition 剥离到 assignment，
// definition 改为 workspace-scoped，模型配置改为引用 model_providers 表。

/** Agent 角色（在 assignment 级而非 definition 级） */
export type AgentRole = 'standalone' | 'main' | 'sub';

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

/** Declarative agent 定义（仅含身份/能力/模型配置，不含角色与父子关系） */
export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: 'declarative';
  systemPrompt: string;
  defaultTools: ToolRef[];
  source: 'builtin' | 'custom' | 'marketplace';
  description: string;
  iconEmoji: string;

  /** MCP server 引用列表 */
  defaultMcps: McpRef[];
  /** Skill 引用列表 */
  defaultSkills: SkillRef[];

  // === v1.3 新增（migration v12） ===
  /** NULL=全局共享；非 NULL=该 workspace 私有（builtin 与显式 global custom 为 NULL） */
  workspaceId: string | null;
  /** NULL=builtin 未配置；custom 必填。引用 model_providers.id */
  modelProviderId: string | null;
  /** 模型名（如 gpt-4o, claude-3-opus） */
  modelName: string;

  // === v1.7 新增 ===
  /**
   * 创建时间 ISO 字符串（DB 列 created_at，行入库时由 datetime('now') 默认填充）。
   * builtin 内联 YAML 加载时为 undefined（无 DB 记录）。v1.7 resource/custom.ts
   * 用作 ResourceItem.custom.installedAt。
   */
  createdAt?: string;
}

/** Agent 在 workspace 中的实例化（角色与父子关系存这里，不存 definition） */
export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;

  // === v1.3 新增（migration v12） ===
  /** 角色：standalone（独立）/ main（可调度子）/ sub（挂在某 main 下） */
  role: AgentRole;
  /** 父 assignment 的 instanceId（仅 role='sub' 时有值；同 workspace 内） */
  parentInstanceId: string | null;
  /** 有无 API key override（实际 key 在 keychain agent.<instanceId>.api_key_override） */
  hasApiKeyOverride: boolean;
}

/** Builtin YAML 的角色/platform 建议（不进 DB，仅 UI 默认值） */
export interface BuiltinSuggestion {
  role: AgentRole;
  /** 建议的父 def ID（仅 role='sub' 时有意义；UI 据此预填 parent 下拉） */
  suggestedParentDefId?: string;
  /** builtin YAML 的 platform 信息；UI 据此在 provider 下拉预选匹配项 */
  suggestedPlatform?: 'openai' | 'anthropic';
}

/** key = defId，value = builtin 建议 Map */
export type BuiltinSuggestionMap = Record<string, BuiltinSuggestion>;
