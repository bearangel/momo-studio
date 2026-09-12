// electron/src/main/agent/chain-writer.ts
//
// v2.8.0 Orchestration 元语（Task 5）：派发链消息行写入 helper。
//
// appendFollowupQuestionRow——dispatch_followup（T6）发起追问时，把追问正文
// 作为 user 消息行落库：
//   - (task_id = 链 ID, session_id = 执行会话) 双键打标——rebuildSubConversation
//     （T1）按双键聚合链内全部轮次（子 agent 流行 + followup user 行）；
//   - sender='owner'（session-service.sendUserMessage 的用户行约定，重建器据此
//     分辨 user 轮）+ parent_stream_session_id（PM 当前流 id——追问行据此嵌套
//     定位到 PM 本轮的工具调用区，非链内子 agent 流）；
//   - 列形态照 stream-relay 的 insertMessage 调用（status 缺省 'done'，
//     workspace_id 缺省 NULL）。

import { insertMessage } from '../storage/messages/repo';

/**
 * 落库一条 followup 追问 user 行（供 T6 dispatch_followup 消费）。
 *
 * @param taskId 链 ID（原 dispatch 的 task_id——多轮 followup 沿用不变）
 * @param sessionId 执行会话 ID（链所在会话，与子 agent 流行同 session）
 * @param parentStreamSessionId PM 当前流 id（追问行 parent_stream_session_id 的来源，供 renderer 嵌套定位）
 * @param question 追问正文
 */
export function appendFollowupQuestionRow(
  taskId: string,
  sessionId: string,
  parentStreamSessionId: string,
  question: string,
): void {
  insertMessage({
    sessionId,
    sender: 'owner',
    eventType: 'm.room.message',
    body: question,
    taskId,
    parentStreamSessionId,
  });
}
