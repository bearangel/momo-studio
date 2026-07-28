// electron/src/main/audit/query.ts
//
// 审计日志查询 —— 从 tool_calls 表（migration v6 创建，由 runtime-manager 插桩写入）
// 分页读取某 workspace 的工具调用记录，供 UI 展示。
//
// 查询按 timestamp 倒序（最新优先），命中 (workspace_id, timestamp) 复合索引。
// success 列在 DB 里是 INTEGER(0/1)，这里转成 boolean 给上层用。

import { getDb } from '../storage/db';

/** 单条工具调用审计记录，与 renderer 端 ToolCallRecord 类型对齐 */
export interface ToolCallRecord {
  id: string;
  workspaceId: string;
  agentBotUserId: string;
  /** 任务 ID（当前插桩恒为 null，预留字段） */
  taskId: string | null;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
  /** ISO 时间戳字符串（SQLite datetime('now') 产出） */
  timestamp: string;
}

interface ToolCallRow {
  id: string;
  workspace_id: string;
  agent_bot_user_id: string;
  task_id: string | null;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  success: number;
  duration_ms: number;
  timestamp: string;
}

function rowToRecord(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentBotUserId: row.agent_bot_user_id,
    taskId: row.task_id,
    toolName: row.tool_name,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    success: row.success === 1,
    durationMs: row.duration_ms,
    timestamp: row.timestamp,
  };
}

export interface ToolCallQueryOpts {
  /** 返回条数上限，默认 100 */
  limit?: number;
  /** 偏移量（配合 limit 做分页），默认 0 */
  offset?: number;
  /** 按 agent bot user id 精确筛选（可选） */
  agentBotUserId?: string;
  /** 按工具名精确筛选（可选） */
  toolName?: string;
}

/**
 * 分页查询某 workspace 的工具调用审计记录。
 *
 * limit/offset 经 SQLite 原生分页；agent/tool 筛选用 AND 拼到 WHERE，
 * 避免在 JS 侧过滤大量数据。返回值已按 timestamp 倒序。
 */
export function getToolCalls(workspaceId: string, opts: ToolCallQueryOpts = {}): ToolCallRecord[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const db = getDb();

  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts.agentBotUserId) {
    where.push('agent_bot_user_id = ?');
    params.push(opts.agentBotUserId);
  }
  if (opts.toolName) {
    where.push('tool_name = ?');
    params.push(opts.toolName);
  }

  const rows = db
    .prepare(
      `SELECT id, workspace_id, agent_bot_user_id, task_id, tool_name,
              input_summary, output_summary, success, duration_ms, timestamp
       FROM tool_calls
       WHERE ${where.join(' AND ')}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ToolCallRow[];

  return rows.map(rowToRecord);
}
