// electron/src/main/agent/tool-audit.ts
//
// 工具调用审计日志的子进程端发送器。runtime-entry 运行在独立子进程中，
// 无法直接访问主进程的 SQLite 连接，故通过 IPC（process.send）把审计
// 数据以 `audit:toolCall` 事件转发到主进程。
//
// 当前 task-driven 路径（v2 P1）暂无主进程侧消费者——v1 runtime-spawner
// 的审计桥接已被 v2 重构移除；该事件的 DB 落库在 P2 阶段恢复，可参考
// 已删除的 v1 handleAuditToolCall 实现（git log 找 v2.0.0-p1 重构之前的
// runtime-spawner.ts）。
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
