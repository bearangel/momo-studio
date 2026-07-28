// electron/src/main/agent/types.ts
//
// Agent 定义相关类型 — Declarative agent 的 YAML manifest 解析产物。
// M1 仅支持 runtime: 'declarative'，type 涵盖 standalone/main/sub 三种形态。

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
  source: 'builtin' | 'custom';
  description: string;
  iconEmoji: string;
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
