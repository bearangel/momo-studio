// electron/src/main/task/human-answer-inject.ts
//
// 人工答复系统消息注入 + 会话唤醒（任务生命周期 v2 Task 11，spec §6 HITL 答复链）。
//
// 仿 router-service.deliverChainResult 既有三步机制（不另行发明链路）：
//   1) insertMessage(sender='system', event_type='human_answer')——系统生成行
//      （spec §5.2：非 owner/agent 身份），agent 上下文重建时经 sender-role 映射
//      进入 user 轮，答复内容随会话历史进入推理
//   2) pushSessionMessage 实时推送 renderer（spec §6.4：与流消息同一实时可见契约）
//   3) router.routeUserChat(systemKickoff=true) 唤醒新回合——kickoff 无条件派发
//      （不走 steer 分流）；streamSessionId 与消息行共享 = 回合标识（deliverChainResult 同构）
// 唤醒目标：会话 leader 接待语义（与 sendUserMessage / pickRoutingTarget 同源；
// 执行会话 assignee 建会时已标 is_leader=1，见 starter.createNewTaskRoom）。
// 纯载荷类型与正文构造在 human-answer-shared.ts（Task 14 拆分：本模块的重运行时
// 依赖不得经 lifecycle-runs 进入 starter→tools 链的模块环）；此处 re-export 保住
// 既有导入面（T13 tool-gate / T16 IPC 从本模块取 HumanAnswerInput 不受影响）。
import { randomUUID } from 'node:crypto';
import { getRouterService } from '../agent/router-bootstrap';
import { pushSessionMessage } from '../agent/stream-relay';
import { insertMessage } from '../storage/messages/repo';
import { getSessionMembersInfo } from '../im/session-ops';
import { logger } from '../logger';
import { humanAnswerBody } from './human-answer-shared';

export type { HumanAnswerInput } from './human-answer-shared';
export { humanAnswerBody } from './human-answer-shared';

/** 会话唤醒目标：leader 接待（与 pickRoutingTarget 同语义；无 leader → null 跳过唤醒） */
function resolveWakeTarget(sessionId: string): string | null {
  return getSessionMembersInfo(sessionId).find((m) => m.isLeader)?.instanceId ?? null;
}

/**
 * 写一条系统消息并唤醒会话 agent（deliverChainResult 同构三步）。
 * metaJson 可选（落 messages.context_json，调用方按需携带结构化元信息）。
 * RouterService 未启动 / 会话无 leader 目标时只落库 + 推送，唤醒跳过（warn 不抛）。
 */
export function sendSystemKickoffMessage(sessionId: string, body: string, metaJson?: string): void {
  const streamSessionId = randomUUID();
  const row = insertMessage({
    sessionId,
    sender: 'system',
    eventType: 'human_answer',
    body,
    streamSessionId,
    ...(metaJson !== undefined ? { contextJson: metaJson } : {}),
  });
  pushSessionMessage(row);

  const router = getRouterService();
  const target = resolveWakeTarget(sessionId);
  if (!router || !target) {
    logger.warn('【人工答复】唤醒跳过（RouterService 未启动或会话无接待目标）', { sessionId });
    return;
  }
  void router
    .routeUserChat({ sessionId, assignmentId: target, body, streamSessionId, systemKickoff: true })
    .catch((err: unknown) => {
      logger.warn('【人工答复】唤醒派发失败', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
