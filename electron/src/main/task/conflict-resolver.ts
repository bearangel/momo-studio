// electron/src/main/task/conflict-resolver.ts
//
// 冲突处理器（B 子系统 B9）：当用户在 execution_room 内 @agent 启动新任务 #T-new，
// 但当前会话已有任务在跑时，由本模块决定如何处理冲突。
//
// 设计要点：
//   - resolveConflict 是**纯函数**：不读 DB、不写 DB、不调 Matrix。
//     所有副作用（startTask / transitionTaskStatus / 新建 room）由 IPC handler 层
//     根据 resolution.action 执行。这样便于单元测试，也避免在 resolver 内做 IO
//     导致重复测试 Matrix 客户端 mock。
//   - 策略从 room_settings.conflict_strategy 读取（每会话配置，由调用方注入 ctx.strategy）。
//     默认 'ask'（弹 ConflictDialog 让用户选）。
//   - fork 分支返回**占位 newExecutionSessionId**（!fork-<timestamp>:home）——
//     IPC handler 拿到后会调用 startTask(newTask, { createNewRoom: true }) 实际创建
//     新会话并把 newExecutionSessionId 替换为真实 room id（详见 ipc.handlers.ts）。
//
// 5 策略语义：
//   ask    → 返回 ask，UI 弹窗让用户选（默认值）
//   queue  → newTask 保持 assigned，等当前任务完成后调度器自动 pickup（D 阶段 pickup 机制）
//   preempt→ 暂停当前任务（→ paused）+ 立即 startTask(newTask, { executionSessionId: currentRoomId })
//   fork   → startTask(newTask, { createNewRoom: true })，新任务在新会话执行，当前任务不受影响
//   reject → 拒绝新任务（用户需改换会话或在别处启动）

/** 冲突处理策略：room_settings.conflict_strategy 与 agent_definitions.default_conflict_strategy 同语义 */
export type ConflictStrategy = 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';

/** 冲突上下文：调用方（IPC handler / runtime-entry）从 room_settings 读取策略后注入 */
export interface ConflictContext {
  /** 想启动的新任务 id */
  newTaskId: string;
  /** 当前正在执行的任务 id */
  currentTaskId: string;
  /** 当前会话 id */
  currentRoomId: string;
  /** 冲突处理策略（从 room_settings 读取，未配置时调用方应传 'ask'） */
  strategy: ConflictStrategy;
}

/**
 * 冲突处理结果（5 分支联合类型）。
 *
 * queue / preempt / fork / reject 是直接可执行的命令，IPC handler 拿到后立即执行副作用。
 * ask 表示「交给用户在 UI 决定」——runtime-entry 不会直接拿到 ask（runtime-entry 调用前
 * 调用方会检查 strategy，ask 时直接通知 renderer 弹 ConflictDialog；用户选完后再调
 * task:resolveConflict with 非 ask 策略）。
 */
export type ConflictResolution =
  | { action: 'queue'; newTaskId: string }
  | { action: 'preempt'; newTaskId: string; pausedTaskId: string }
  | { action: 'fork'; newTaskId: string; newExecutionSessionId: string }
  | { action: 'reject'; reason: string }
  | { action: 'ask' };

/**
 * 纯函数：根据 strategy 决定如何处理冲突。
 *
 * 调用方约定：
 *   - runtime-entry 检测到冲突 → 读 room_settings.conflict_strategy → strategy='ask' 时
 *     通知 renderer 弹 ConflictDialog；非 ask 时直接调 task:resolveConflict 执行
 *   - task:resolveConflict handler 内再次调用本函数得到 resolution，按 action 执行副作用
 *
 * @returns ConflictResolution——纯数据，无副作用
 */
export function resolveConflict(ctx: ConflictContext): ConflictResolution {
  switch (ctx.strategy) {
    case 'queue':
      // newTask 保持 status='assigned'，等当前任务完成后由调度器（D 阶段 pickup）自动启动。
      // 这里不立即执行 startTask——startTask 会 transition 到 in_progress 与"等待"语义冲突。
      return { action: 'queue', newTaskId: ctx.newTaskId };

    case 'preempt':
      // IPC handler 负责：transitionTaskStatus(currentTaskId, 'paused') +
      // startTask(newTaskId, { executionSessionId: currentRoomId })
      return {
        action: 'preempt',
        newTaskId: ctx.newTaskId,
        pausedTaskId: ctx.currentTaskId,
      };

    case 'fork':
      // 占位 newExecutionSessionId——IPC handler 拿到后调 startTask(newTaskId, { createNewRoom: true })
      // 创建真实新会话，startTask 返回的 executionSessionId 才是最终值。
      // 这里返回占位 ID 仅用于让 resolution 结构完整（测试可断言字段存在），不直接使用。
      return {
        action: 'fork',
        newTaskId: ctx.newTaskId,
        newExecutionSessionId: `!fork-${Date.now()}:home`,
      };

    case 'reject':
      // 拒绝：用户需改换会话或调整策略。reason 给 UI 展示。
      return {
        action: 'reject',
        reason: '当前会话策略为拒绝新任务，请在别处执行或调整会话冲突策略',
      };

    case 'ask':
    default:
      // ask：交给 UI 弹 ConflictDialog。default 兜底防御性编程（无效 strategy 视为 ask）。
      return { action: 'ask' };
  }
}
