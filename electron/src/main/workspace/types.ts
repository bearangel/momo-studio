// electron/src/main/workspace/types.ts
//
// Workspace 实体 — 对应一个工作空间 + Matrix Space + Git 仓库。
// 字段定义与 002 迁移的 `workspaces` 表一一对应（camelCase ↔ snake_case）。

/** Workspace 实体 — 对应一个工作空间 + Matrix Space + Git 仓库 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  matrixSpaceId: string;
  gitInitialized: boolean;
  createdAt: string;
  ownerId: string;
  iconEmoji: string;
}

/** 创建 workspace 时的输入 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}
