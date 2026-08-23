// electron/src/main/agent/tool-audit.ts
//
// 工具调用审计日志的子进程端发送器。runtime-entry 运行在独立子进程中，
// 无法直接访问主进程的 SQLite 连接，故通过 IPC（process.send）把审计
// 数据以 `audit:toolCall` 事件转发到主进程。
//
// 审计事件由 runtime-spawner 的 messageHandler 消费（`audit:toolCall`
// 分支，见 `runtime-spawner.ts`）：补全 spawn 闭包中的 workspaceId /
// agentUserId 后调 `insertToolCall` 写入 `tool_calls` 表，并按每 200 次
// 写入触发一次 `enforceAuditQuota` 容量巡检。P2 Task 8 恢复该桥。
//
// 每条审计记录截断到 500 字符，避免超长工具输出（如 read_file 大文件）
// 导致 IPC 消息过大或 DB 膨胀。

/** 审计记录字段（子进程 → 主进程方向） */
export interface ToolCallAudit {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
}

/** 审计摘要最大长度（字符） */
const AUDIT_SUMMARY_MAX = 500;

/**
 * 通过 IPC 向主进程发送工具调用审计日志。
 * process.send 在非子进程环境下为 undefined，可选链调用确保 no-op。
 */
export function logToolCall(audit: ToolCallAudit): void {
  process.send?.({
    type: 'audit:toolCall',
    toolName: audit.toolName,
    inputSummary: audit.inputSummary.slice(0, AUDIT_SUMMARY_MAX),
    outputSummary: audit.outputSummary.slice(0, AUDIT_SUMMARY_MAX),
    success: audit.success,
    durationMs: audit.durationMs,
  });
}
