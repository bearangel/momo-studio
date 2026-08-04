// electron/src/main/agent/tools/shared/permission.ts
// 工具权限配置类型。Task 3 会在此文件加入 assertToolAllowed + 通配符匹配。

export interface ToolPermissionConfig {
  allowedTools: string[];
  deniedTools: string[];
}
