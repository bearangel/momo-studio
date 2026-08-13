// electron/src/main/agent/decide-response.ts
//
// 三种会话场景路由（B 子系统 v2 更新）：
//   场景 1.3：单聊无需 @（room 仅 user + 1 agent，自动响应——优先级最高）
//   场景 1.1：被 @ 直接响应；群组有 PM agent + 我是协调 + owner 发 + 无任何 @ → 自动接待
//   场景 1.2：群组无 PM agent + 未 @ → 不响应
//
// 从 runtime-entry.ts 提取为独立模块的原因：
//   1. 单元测试更容易——无需 import 整个 runtime-entry（带 Matrix/LLM/子进程副作用）
//   2. 路由逻辑集中，便于 v2 任务模型（B 子系统）扩展
//   3. 场景判断参数从 5 个扩展到 7 个（新增 isDirectChat + hasCoordinator）
//
// 优先级（短路顺序）：
//   1. isDirectChat → respond（单聊永远响应，即使有其他 @）
//   2. mentioned → respond（被 @ 直接响应）
//   3. 群组有协调 + 我是协调 + owner 发 + 无任何 @ → respond（PM 自动接待）
//   4. 其余 → skip

/** 协调 agent 触发判定结果：响应或跳过 */
export type ResponseDecision = 'respond' | 'skip';

/**
 * decideResponse 的输入参数。
 * 由调用方（runtime-entry.handleEvent）通过 Matrix SDK + IPC 查询组装。
 */
export interface DecideResponseOpts {
  /** 本 bot 被显式 @ （m.mentions.user_ids 含本 bot） */
  mentioned: boolean;
  /** 消息中存在任何 @（包括 @ 别人）——用于判断"owner 无指名消息" */
  hasAnyMention: boolean;
  /** 当前 room 是否是本 workspace 的团队群（team room） */
  isTeamRoom: boolean;
  /** 本 agent 实例是否是所属 workspace 的协调 agent（PM） */
  isCoordinator: boolean;
  /** 消息发送者是否是 workspace owner（防外部渗透） */
  isOwnerMessage: boolean;
  /**
   * 当前 room 是否是单聊（仅 user + 1 agent，2 个成员）。
   * v2 新增——场景 1.3 的判定依据。
   */
  isDirectChat: boolean;
  /**
   * 所属 workspace 是否已配置协调 agent（workspaces.coordinator_instance_id 非空）。
   * v2 新增——区分场景 1.1（有 PM 自动接待）与场景 1.2（无 PM 不响应）。
   */
  hasCoordinator: boolean;
}

/**
 * 决定本 agent 是否响应某条消息。三路互斥，不重复响应。
 *
 * 场景 1.3（单聊）：room 仅 user + 1 agent → 永远响应（即使无 @）。
 *   优先级最高——单聊场景下 @ 是噪声，用户发言即应答。
 *
 * 场景 1.1（被 @ / 群组自动接待）：
 *   - 被 @ 直接响应
 *   - 群组有 PM agent + 我是 PM + owner 发 + 无任何 @ → PM 自动接待
 *
 * 场景 1.2（群组无 PM）：未 @ → 不响应
 */
export function decideResponse(opts: DecideResponseOpts): ResponseDecision {
  // 场景 1.3：单聊无需 @ 自动响应（优先级最高）
  if (opts.isDirectChat) return 'respond';
  // 场景 1.1：被 @ 直接响应
  if (opts.mentioned) return 'respond';
  // 场景 1.1：群组有 PM + 我是 PM + owner 发 + 无任何 @ → 自动接待
  if (
    opts.hasCoordinator &&
    opts.isCoordinator &&
    opts.isTeamRoom &&
    opts.isOwnerMessage &&
    !opts.hasAnyMention
  ) {
    return 'respond';
  }
  // 场景 1.2 + 其他所有情况 → 跳过
  return 'skip';
}
