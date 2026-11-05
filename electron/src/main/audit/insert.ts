// electron/src/main/audit/insert.ts
//
// 工具调用审计写入（主进程侧落库）。子进程 tools/shared/audit.ts 经 child IPC
// 发 audit:toolCall 消息，由 runtime-spawner 的审计桥（P2 Task 8 恢复 v1 被删
// 桥接）调用本模块 INSERT——子进程无法直接访问主进程的 SQLite 连接。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';

export interface InsertToolCallInput {
  workspaceId: string;
  agentBotUserId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
  /** 关联任务 ID（2026-11-04 起由子进程归因链 currentTaskId ?? hostTaskId 贯穿；快速会话为 null） */
  taskId?: string | null;
  /** 插件系统 P2：溯源（插件工具 'plugin'，缺省 'builtin'） */
  source?: 'builtin' | 'plugin';
  /** 插件系统 P3（spec §5.4）：preToolUse 决策 JSON（null=无 hook 参与） */
  preToolUse?: string | null;
}

/**
 * 插入一条工具调用审计记录；id 随机生成，timestamp 由 SQLite datetime('now') 产出（UTC）。
 * 携带 taskId 时同步递增 tasks.tool_calls_used（单条 UPDATE；任务行不存在 →
 * 0 行 no-op 不阻断审计写入）。
 */
export function insertToolCall(input: InsertToolCallInput): void {
  const db = getDb();
  const taskId = input.taskId ?? null;
  db.prepare(
    `INSERT INTO tool_calls
       (id, workspace_id, agent_bot_user_id, task_id, tool_name,
        input_summary, output_summary, success, duration_ms, source, pre_tool_use, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    randomUUID(),
    input.workspaceId,
    input.agentBotUserId,
    taskId,
    input.toolName,
    input.inputSummary,
    input.outputSummary,
    input.success ? 1 : 0,
    input.durationMs,
    input.source ?? 'builtin',
    input.preToolUse ?? null,
  );
  if (taskId !== null) {
    db.prepare('UPDATE tasks SET tool_calls_used = tool_calls_used + 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      taskId,
    );
  }
}
