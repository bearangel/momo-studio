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
  /** 关联任务 ID（当前插桩恒为 null，预留字段） */
  taskId?: string | null;
}

/** 插入一条工具调用审计记录；id 随机生成，timestamp 由 SQLite datetime('now') 产出（UTC） */
export function insertToolCall(input: InsertToolCallInput): void {
  getDb()
    .prepare(
      `INSERT INTO tool_calls
         (id, workspace_id, agent_bot_user_id, task_id, tool_name,
          input_summary, output_summary, success, duration_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.agentBotUserId,
      input.taskId ?? null,
      input.toolName,
      input.inputSummary,
      input.outputSummary,
      input.success ? 1 : 0,
      input.durationMs,
    );
}
