// electron/src/main/workspace/types.ts
//
// Workspace 实体 — 对应一个工作空间 + Git 仓库（v23：matrix_space_id 列已删除）。
// 字段定义与 workspaces 表一一对应（camelCase ↔ snake_case）。

/** Workspace 实体 — 对应一个工作空间 + Git 仓库 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  /** workspace 内"团队会话" ID（用户 + 所有 agent bot 交流的会话），004 迁移引入；v23 更名 */
  teamSessionId: string;
  gitInitialized: boolean;
  createdAt: string;
  ownerId: string;
  iconEmoji: string;
  /** 该 workspace 的"协调 agent"实例 ID（team 群非@消息的默认接待者）；null=未指定 */
  coordinatorInstanceId: string | null;
}

/** 创建 workspace 时的输入 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}
