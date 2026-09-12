// electron/src/main/agent/sub-history-reconstructor.ts
//
// 子会话重建器（v2.8.0 Orchestration 元语 · spec §3.3）。
//
// 职责：把一条 dispatch 链（task_id = 链 ID）在执行会话内已落库的
// messages + message_events 重建为 LLM 可续聊的 messages 前缀，供
// dispatch_followup（T5）作 historyPrefix 派发给子 agent——
//   messages = [system, ...重建前缀, user(追问正文)]
//
// 事件聚合语义与 turn-reconstructor 同构（import 共享其
// createAssistantRoundAggregator，不复制代码）：text_delta 拼接 /
// tool_call+tool_result 配对 / 孤儿 call 合成 [执行中断] result /
// 未知事件类型跳过（前向兼容）。
//
// 链行写入契约（本模块是消费侧；生产者 = T5 dispatch_followup 写路径）：
//   链内全部消息行（子 agent 流行 + followup user 行）都带
//   (task_id = 链 ID, session_id = executionSessionId) 双键。
//   当前生产链 start chunk 不落 task_id（stream-relay 无该字段），
//   T5 接线时负责按本契约写行 / 打标。
//
// 首轮指令不回溯：dispatch 首轮 body 不落消息行且内部事件桥 transient
// ——重建链恒以 assistant 开头（协议合法，LLM 从上下文自推断），
// 不造合成 user 消息。
//
// 纯读取（零写入）、同步。任何异常（含空链）catch 降级 degraded
// （messages=[] + rounds=0，不抛——调用方以提示注入兜底，不阻断）。
import type { LLMMessage } from './llm-provider';
import { createAssistantRoundAggregator } from './turn-reconstructor';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { listEventsByMessage } from '../storage/messages/events-repo';

/** 重建结果（spec §3.3） */
export interface RebuiltSubHistory {
  /** 链内全部轮次的对话消息（不含 system——system 由 runChatLoop 组装）；首条恒为 assistant */
  messages: LLMMessage[];
  /** 追问轮次统计（= 链内 user 角色消息数；链 = 首轮 dispatch + N 次 followup，首轮无 user 不计） */
  rounds: number;
  /** 任何重建异常 / 空链 → true + messages=[] */
  degraded: boolean;
}

/** 链消息行（本模块消费的最小列集） */
interface ChainRow {
  id: string;
  sender: string;
  body: string;
}

/**
 * 查链消息行（repo 无此查询，本模块内写 SQL）。
 *
 * 过滤条件：task_id = 链 ID AND session_id = 执行会话（会话边界——同
 * task_id 误入他链会话的伪造行 / 同会话他链任务的行都不进重建）；
 * segment_of IS NULL 排除 `#seg{n}` 分段快照行（body 快照非对话内容，
 * 与 turn-reconstructor 的 collectStreamEvents 过滤同口径）。
 * 行间序 = created_at ASC + rowid ASC（repo 全表查询惯例，同毫秒插入
 * 按 rowid 稳定定序）。
 */
function queryChainRows(taskId: string, executionSessionId: string): ChainRow[] {
  return getDb()
    .prepare(
      `SELECT id, sender, body FROM messages
       WHERE task_id = ? AND session_id = ? AND segment_of IS NULL
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId, executionSessionId) as ChainRow[];
}

/**
 * 重建子会话链历史（同步；纯读取）。
 *
 * 行角色分流：sender='owner'（session-service.sendUserMessage 的用户行
 * 约定）= followup 追问——收口上一轮 assistant 输出后按位插入 user 消息；
 * 其余（子 agent 流行，sender=agentUserId 约定）= 事件喂入共享聚合状态机。
 * 连续 agent 行（如 `#roll{n}` 续行）自然并入同一轮，跨行拼接语义同构
 * turn-reconstructor 的流族事件全序。
 */
export function rebuildSubConversation(
  taskId: string,
  executionSessionId: string,
): RebuiltSubHistory {
  try {
    const rows = queryChainRows(taskId, executionSessionId);
    // 空链（从未执行 / 行已被清理）→ 降级：historyPrefix 空 + 提示注入由调用方决定
    if (rows.length === 0) {
      return { messages: [], rounds: 0, degraded: true };
    }

    const agg = createAssistantRoundAggregator();
    let rounds = 0;
    for (const row of rows) {
      if (row.sender === 'owner') {
        agg.closeRound();
        agg.appendMessage({ role: 'user', content: row.body });
        rounds++;
      } else {
        for (const ev of listEventsByMessage(row.id)) {
          agg.push(ev);
        }
      }
    }
    agg.flush();

    return { messages: agg.messages, rounds, degraded: false };
  } catch (err) {
    // 降级（spec §3.3）：重建任何抛错 → catch 兜底不抛（degraded 方向安全）
    logger.warn('rebuildSubConversation 重建失败，降级为空历史', {
      taskId,
      executionSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], rounds: 0, degraded: true };
  }
}
