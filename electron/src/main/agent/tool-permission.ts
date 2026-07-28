// electron/src/main/agent/tool-permission.ts
//
// 工具权限白名单检查（纯函数，便于单测）。
// 从 runtime-entry.ts 的 doExecuteTool 抽出，因为 runtime-entry 在 import 时即运行
// main()（启动 Matrix client），无法在单测中直接导入。把判定逻辑独立成纯函数后，
// 既能在 doExecuteTool 中复用，也能在单测中覆盖各种 allow/deny 组合。

/** 权限检查所需的配置子集（避免依赖完整 RuntimeConfig） */
export interface ToolPermissionConfig {
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * 校验工具是否被允许调用。规则：
 *   1. deniedTools 命中 → 拒绝（优先级最高，即使同时在 allowed 中也拒绝）
 *   2. allowedTools 非空且工具不在其中 → 拒绝（白名单模式）
 *   3. allowedTools 为空 → 全部放行（非白名单模式，仅 denied 生效）
 *
 * @throws 工具被拒绝时抛错（消息含工具名和原因），由调用方转成 tool result 回传 LLM
 */
export function assertToolAllowed(name: string, config: ToolPermissionConfig): void {
  if (config.deniedTools.includes(name)) {
    throw new Error(`工具 ${name} 被禁止使用`);
  }
  if (config.allowedTools.length > 0 && !config.allowedTools.includes(name)) {
    throw new Error(`工具 ${name} 不在允许列表中`);
  }
}
