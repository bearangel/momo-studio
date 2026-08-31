// electron/src/main/workspace/types.ts
//
// Workspace 实体 — 对应一个工作空间 + Git 仓库（v23：Matrix space 关联列已删除；
// v25：team_session_id/coordinator_instance_id 退役 → default_agent_instance_id）。
// 字段定义与 workspaces 表一一对应（camelCase ↔ snake_case）。

/** Workspace 实体 — 对应一个工作空间 + Git 仓库 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  gitInitialized: boolean;
  createdAt: string;
  ownerId: string;
  iconEmoji: string;
  /** 该 workspace 的"默认会话 agent"实例 ID（快速会话等默认接待者）；null=未指定 */
  defaultAgentInstanceId: string | null;
}

/** 创建 workspace 时的输入 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}
