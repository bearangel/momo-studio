// electron/src/main/agent/types.ts
//
// Agent 定义相关类型 — Declarative agent 的 YAML manifest 解析产物。
//
// v25 重构（spec 2026-08-31 §3）：去编排——角色/父子关系从 schema 消失，
// `agent_assignments` → `workspace_agent_members`（成员制，无 role/parent/enabled）。

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

  // === v2 task-driven runtime 切换（migration v22） ===
  /**
   * 是否使用 task-driven runtime（v2 架构）。
   * - true / undefined（缺省）= task-driven：runtime 由 WarmPool + AgentRunner 管理
   * - false = v1 长存进程模式（Task 13 起已删除，列值恒 1，保留做历史数据兼容）
   *
   * DB 列 task_driven（INTEGER NOT NULL DEFAULT 1），rowToDef 映射为 boolean。
   * undefined 表示 builtin YAML 未写 DB 的场景（按 task-driven 处理）。
   */
  taskDriven?: boolean;
}

/**
 * Agent 在 workspace 中的成员关系（v25：取代 v1.3 的 AgentAssignment——
 * 去编排，无 role/parentInstanceId/enabled；同 ws 同 def 唯一）。
 */
export interface WorkspaceAgentMember {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentUserId: string;
  /** 有无 API key override（实际 key 在 keychain agent.<instanceId>.api_key_override） */
  hasApiKeyOverride: boolean;
  /**
   * 用户最近运行意图——"agent 在线"的唯一权威源。
   *  - true  = 用户启动过（在线）
   *  - false = 用户主动停止或从未启动（离线）
   */
  lastRunning: boolean;
  createdAt: string;
}

/** 团队（ws 级，spec §3.2；leader 必须同时在 members 内，建团/换 leader 同事务保证） */
export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  iconEmoji: string;
  leaderInstanceId: string;
  members: WorkspaceAgentMember[];
  createdAt: string;
}

/** Builtin YAML 的 platform 建议（不进 DB，仅 UI 默认值；v25 起无角色建议） */
export interface BuiltinSuggestion {
  /** 建议的父 def ID（仅历史编排用；v25 去编排后仅作 UI 过渡展示） */
  suggestedParentDefId?: string;
  /** builtin YAML 的 platform 信息；UI 据此在 provider 下拉预选匹配项 */
  suggestedPlatform?: 'openai' | 'anthropic';
}

/** key = defId，value = builtin 建议 Map */
export type BuiltinSuggestionMap = Record<string, BuiltinSuggestion>;
