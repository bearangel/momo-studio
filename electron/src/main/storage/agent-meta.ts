// electron/src/main/storage/agent-meta.ts
//
// v1.5.6 持久化分层：大 thinking/tool_calls/todos 存 SQLite，Matrix event 只存
// body + agent_meta_id。renderer 读消息时若发现 meta_id 字段，调 IPC 拉完整元数据。
// 解决 PDU 64KB 限制（fitEventContent 4-5 级截断丢失 thinking/tool_calls/dispatches）。

import { randomUUID } from 'node:crypto';
import { getDb } from './db';

/** 持久化的 agent 元数据（对应 agent_meta 表一行） */
export interface AgentMeta {
  metaId: string;
  thinking: string | null;
  toolCalls: string | null;
  todos: string | null;
}

/**
 * 写入 agent 元数据。返回 meta_id（UUID），供 Matrix event 引用。
 * 三个字段都是 JSON 字符串（在调用方序列化）。
 */
export function writeAgentMeta(input: {
  thinking?: string;
  toolCalls?: string;
  todos?: string;
}): string {
  const db = getDb();
  const metaId = randomUUID();
  db.prepare(
    `INSERT INTO agent_meta (meta_id, thinking, tool_calls, todos) VALUES (?, ?, ?, ?)`,
  ).run(
    metaId,
    input.thinking ?? null,
    input.toolCalls ?? null,
    input.todos ?? null,
  );
  return metaId;
}

/** 读取 agent 元数据。不存在返回 null（renderer fallback 到 Matrix event 字段） */
export function readAgentMeta(metaId: string): AgentMeta | null {
  const db = getDb();
  const row = db
    .prepare('SELECT meta_id, thinking, tool_calls, todos FROM agent_meta WHERE meta_id = ?')
    .get(metaId) as { meta_id: string; thinking: string | null; tool_calls: string | null; todos: string | null } | undefined;
  if (!row) return null;
  return {
    metaId: row.meta_id,
    thinking: row.thinking,
    toolCalls: row.tool_calls,
    todos: row.todos,
  };
}

/**
 * 判定是否需要分层持久化。
 * 阈值 5KB：超过此值的 thinking+tool_calls+todos 才存 SQLite；否则继续放 Matrix event
 * （兼容旧消息渲染路径，简单消息不多一次 IPC 调用）。
 */
const META_SPLIT_THRESHOLD_BYTES = 5_000;

export function shouldSplitMeta(
  thinking: string,
  toolCallsJson: string,
  todosJson: string,
): boolean {
  return (
    Buffer.byteLength(thinking, 'utf-8') +
    Buffer.byteLength(toolCallsJson, 'utf-8') +
    Buffer.byteLength(todosJson, 'utf-8') >
    META_SPLIT_THRESHOLD_BYTES
  );
}
