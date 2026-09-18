// renderer/src/lib/session-todos.ts
//
// 会话 todo 聚合选择器（spec docs/specs/2026-09-18-session-hygiene-batch-design.md §2c）：
// 把分散在各 agent 消息流里的 todo 清单聚合成会话级总览。
//
// 纯 renderer 聚合（零 IPC）——事件本就全量到达 renderer：
//   - 消息序 = messages 数组序（session.store 按 createdAt 线性追加，天然全序）
//   - streams Map 按 messageId 索引（stream.store A 子系统契约）
//   - 单流当前清单 = StreamState.todos（stream-aggregator 对 todo_update
//     全量替换、末值胜出——此处直接消费聚合结果，不重复实现替换语义）
import type { ImMessage, TodoItem } from '../ipc/types';
import type { StreamState } from '../stores/stream.store';
import { resolveBotName } from './useBotNames';

/** 会话 todo 聚合条目：一个「有清单的流」= 一条 */
export interface SessionTodoEntry {
  /** 关联消息 id（= streams Map 的 key，可用于定位气泡 msg-<id>） */
  messageId: string;
  /** agent 展示名（与 MessageBubble/AgentStreamBubble 同款 botNameMap 解析） */
  agentName: string;
  /** 子 agent 判定：message.parentStreamSessionId 非空（dispatch 派生产物） */
  isSubAgent: boolean;
  /** 该流当前清单（末值胜出后的快照，条目对象直接引用聚合结果） */
  todos: TodoItem[];
}

/**
 * 按消息顺序提取每个「stream 状态里 todos.length > 0」的消息的当前清单。
 *
 * @param messages   会话消息（全量，含被 MessageList 过滤出顶层的子 agent 消息行）
 * @param streams    messageId → StreamState（stream.store 契约键位）
 * @param botNameMap agentUserId → 配置名（useBotNameMap() 产出；缺省空表，
 *                   resolveBotName 回退 shortName——纯函数不能调 hook，map 作数据入参）
 * @returns 聚合条目数组；空输入 / 无 todo 流 → 空数组
 */
export function collectSessionTodos(
  messages: ImMessage[],
  streams: Map<string, StreamState>,
  botNameMap: Map<string, string> = new Map(),
): SessionTodoEntry[] {
  const entries: SessionTodoEntry[] = [];
  for (const message of messages) {
    // 容错：streams 无该消息条目（用户消息零 events / 尚未 hydrate）直接跳过。
    // 用户消息不会产生 events，天然不会有 streams 条目——无需按 sender 特判
    const stream = streams.get(message.id);
    if (stream === undefined || stream.todos.length === 0) continue;
    entries.push({
      messageId: message.id,
      agentName: resolveBotName(message.sender, botNameMap),
      isSubAgent: message.parentStreamSessionId !== null,
      todos: stream.todos,
    });
  }
  return entries;
}
