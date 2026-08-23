// electron/src/main/agent/message-target-resolver.ts
//
// task-driven 模式下 m.room.message 的目标 agent 解析——纯函数模块。
//
// C1 修复核心：sync-manager 收到 m.room.message 后，调用本模块的 resolveMessageTarget
// 计算应响应的 assignmentId，再传给 RouterService.routeMatrixEvent 的第 4 参数
// (directTargetAssignmentId)。RouterService 据此调用 routeUserMessage → AgentRunner.executeTask。
//
// 从 runtime-entry.handleEvent 提取的原因（与 decide-response.ts 同理）：
//   1. 纯函数便于单元测试——不依赖 Matrix client / DB / 子进程
//   2. 路由逻辑集中，sync-manager（主进程）与 runtime-entry（子进程）可共享同一套语义
//   3. sync-manager 在主进程有 Matrix client + DB 直连，无需走 IPC 查询 room info
//
// 与 decideResponse 的关系：
//   decideResponse 是单 agent 视角的判定（这个 agent 该不该响应）。
//   resolveMessageTarget 是 room 视角的仲裁（遍历所有 candidate bot，返回第一个该响应的）。
//   两者共享同一套场景 1.1 / 1.2 / 1.3 语义。

import { decideResponse } from './decide-response';

/**
 * 候选 bot——room 中有 task-driven assignment 的成员。
 * 由调用方（sync-manager）从 Matrix room members + DB 查询组装。
 */
export interface BotCandidate {
  /** bot 的 Matrix userId（@bot-xxx:home） */
  botUserId: string;
  /** assignment 的 instance_id（RouterService.runners 的 key） */
  assignmentId: string;
  /** 所属 workspace ID */
  workspaceId: string;
  /** 是否是所属 workspace 的协调 agent（PM） */
  isCoordinator: boolean;
}

/**
 * workspace 级路由上下文。由调用方从 workspaces 表查询。
 * 所有 candidate 应共享同一 workspace（实际场景中一个 room 只属于一个 workspace）。
 */
export interface WorkspaceRoutingInfo {
  /** workspace owner 的 Matrix userId */
  ownerId: string;
  /** workspace 团队群 room ID */
  teamSessionId: string;
  /** workspace 是否已配置协调 agent（coordinator_instance_id 非空） */
  hasCoordinator: boolean;
}

/** resolveMessageTarget 的入参 */
export interface ResolveMessageTargetParams {
  /** 消息发送者 Matrix userId */
  sender: string;
  /** room ID */
  roomId: string;
  /** m.room.message event content（含 body / m.mentions 等） */
  content: Record<string, unknown>;
  /** 是否是单聊（仅 owner + 1 agent，2 成员） */
  isDirectChat: boolean;
  /** room 中的所有候选 bot */
  candidates: BotCandidate[];
}

/**
 * 解析 m.room.message 的目标 agent。
 *
 * 遍历 candidates，对每个 bot 调用 decideResponse 判定，返回第一个 'respond' 的 assignmentId。
 * 三个场景互斥（详见 decide-response.ts）：
 *   1.3 单聊：isDirectChat=true → 第一个 candidate 响应（单聊只有 1 个 bot）
 *   1.1 @我：m.mentions 包含本 bot → 该 bot 响应
 *   1.1 PM 自动接待：team room + 有 coordinator + 我是 coordinator + owner 发 + 无 @ → PM 响应
 *   1.2 其余 → 不响应
 *
 * @returns 目标 assignmentId；无 agent 应响应时返回 null
 */
export function resolveMessageTarget(
  params: ResolveMessageTargetParams,
  workspace: WorkspaceRoutingInfo,
): string | null {
  if (params.candidates.length === 0) return null;

  const mentions = params.content['m.mentions'] as { user_ids?: string[] } | undefined;
  const mentionSet = new Set(mentions?.user_ids ?? []);
  const hasAnyMention = mentionSet.size > 0;
  const isTeamRoom = params.roomId === workspace.teamSessionId;
  const isOwnerMessage = params.sender === workspace.ownerId;

  for (const candidate of params.candidates) {
    const mentioned = mentionSet.has(candidate.botUserId);
    const decision = decideResponse({
      mentioned,
      hasAnyMention,
      isTeamRoom,
      isCoordinator: candidate.isCoordinator,
      isOwnerMessage,
      isDirectChat: params.isDirectChat,
      hasCoordinator: workspace.hasCoordinator,
    });
    if (decision === 'respond') {
      return candidate.assignmentId;
    }
  }
  return null;
}
