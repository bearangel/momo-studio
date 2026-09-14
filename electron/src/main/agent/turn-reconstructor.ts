// electron/src/main/agent/turn-reconstructor.ts
//
// 回合重建器（v2.6.0 断点续跑 §5.3 核心纯函数）。
//
// 职责：中断流的 message_events → LLMMessage[] 重建段。重启恢复时由
// task/resume.ts 调用，把断点回合的已发生内容（文本 / 工具对 / steer）
// 还原成 runChatLoop 可接续的 messages 形状——已完成工具对 verbatim 保留
// 不重跑；孤儿 tool_call（有 call 无 result，含 dispatch）合成中断 result
// 补齐协议对，LLM 看到事实自行决策是否重试。
//
// 纯读取（零写入）、同步。任何异常整体降级 degenerate（安全方向——
// 重建失败等价全新回合，见 spec §5.3 降级阶梯）。
//
// v2.8.0：事件聚合状态机抽为可复用辅助（createAssistantRoundAggregator），
// 与子会话重建器（sub-history-reconstructor）共享聚合语义，不复制代码。
//
// 重建形状对齐 runChatLoop 自身的 messages 组装（协议保真）：
//   - 一轮 LLM 输出 = 单条 assistant 消息（content=本轮累积文本，
//     toolCalls=本轮全部调用，runtime-entry:841）
//   - 每个工具调用 = 紧随的一条 role='tool' 消息（content=结果字符串，
//     toolCallId=call id，按原 call 顺序）
//   - steer drain = { role:'user', content:'[用户中途补充] <body>' }（runtime-entry:706）
//
// 事件形态（照抄 stream-relay.routeChunkToBuffer 落库映射）：
//   text → text_delta{delta}；tool_call → tool_call_start{callId,toolName,args}
//   tool_result → tool_call_result{callId,result,success}；steer → steer{body}
//   （steer 事件生产落库由 v2.6.0 Task 2 接线——runtime-entry drain 循环
//    sendStreamChunk → stream-relay routeChunkToBuffer steer case → event_type='steer' 落库）
//   thinking / todo_update / status_change / final / message_roll /
//   segment_boundary / 未知 kind → 跳过（不进 LLM 上下文 / 前向兼容）
import type { LLMMessage, LLMToolCall } from './llm-provider';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import {
  getMessageByStreamSessionId,
  listMessagesByStreamSessionId,
  listRecentMessagesBySession,
  type MessageRow,
} from '../storage/messages/repo';
import { TOOL_RESULT_MAX_LEN, TRUNCATED_MARKER } from '../compaction/serialize';
import { listEventsByMessage, type MessageEventRow } from '../storage/messages/events-repo';

/** 孤儿 tool_call（中断时未回 result）的合成 tool result 文案 */
export const INTERRUPTED_TOOL_RESULT =
  '[执行中断：进程重启，该工具未完成或结果未知。请自行判断是否重试]';

/** 重建结果（spec §5.3） */
export interface RebuiltTurn {
  /** 本轮重建段（不含 system / 前轮 convCtx）；首条 = 原 user 消息 */
  messages: LLMMessage[];
  /** 已消耗工具预算（= 已发出 tool_call 事件数） */
  toolCallsUsed: number;
  /** 中断前未消费的中途补充（随恢复载荷重放进 pendingSteers） */
  steers: string[];
  /** true = 本轮尚无任何 assistant 输出（等价全新回合） */
  degenerate: boolean;
}

/** 全空降级形态（流行不存在 / 重建抛错的统一兜底；每次新对象防调用方改动污染） */
function emptyDegenerate(): RebuiltTurn {
  return { messages: [], toolCallsUsed: 0, steers: [], degenerate: true };
}

/** 本轮已开（可能已配对）的工具调用 */
interface PendingCall {
  call: LLMToolCall;
  /** 已配对的 result 内容；null = 未配对（流末合成中断文案） */
  result: string | null;
}

/**
 * 单 assistant 轮聚合状态机（可复用聚合辅助）。
 *
 * v2.8.0 从 rebuildTurn 内联状态抽出：rebuildTurn 自身与子会话重建器
 * （sub-history-reconstructor）共享同一事件聚合语义——text_delta 拼接 /
 * tool_call+tool_result 按 callId 配对 / 孤儿 call 流末合成
 * INTERRUPTED_TOOL_RESULT / 其余事件类型一律跳过（前向兼容）。
 *
 * 轮边界（closeRound 语义，对齐 runChatLoop 的 messages 组装序）：
 *   - text_delta 出现在本轮 tool 活动之后 = 新一轮开始（先收口再累积）
 *   - 调用方显式收口（steer drain / followup user 追问 / 链末 flush）
 *
 * appendMessage 供调用方在轮间插入非 assistant 产出的消息（回合起始
 * user / steer 补充 / followup 追问），保持链内时序。
 */
export interface AssistantRoundAggregator {
  /** 送入一个事件（text_delta / tool_call_start / tool_call_result；其余跳过） */
  push(ev: MessageEventRow): void;
  /** 收口当前轮：assistant(toolCalls) + 逐 call tool 消息；幂等（空轮无输出） */
  closeRound(): void;
  /** 追加非 assistant 产出的消息（user 起始 / steer 补充 / followup 追问） */
  appendMessage(m: LLMMessage): void;
  /** 流末收口（等价 closeRound） */
  flush(): void;
  /** 已聚合的全部消息（含 appendMessage 追加的，按链内时序） */
  readonly messages: LLMMessage[];
  /** 已发出 tool_call 事件数（预算消耗口径） */
  readonly toolCallsUsed: number;
}

/** args 形态防御：非普通对象（损坏行）按空参数处理，不中断重建 */
function toPlainArgs(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 创建一轮聚合状态机（闭包实现，状态私有） */
export function createAssistantRoundAggregator(): AssistantRoundAggregator {
  const messages: LLMMessage[] = [];
  let textBuffer = '';
  let pendingCalls: PendingCall[] = [];
  let roundHasCalls = false;
  let toolCallsUsed = 0;

  /** 收口当前轮：assistant(toolCalls) + 逐 call tool 消息（对齐 runChatLoop 组装序） */
  const closeRound = (): void => {
    if (roundHasCalls) {
      messages.push({
        role: 'assistant',
        content: textBuffer,
        toolCalls: pendingCalls.map((p) => p.call),
      });
      for (const p of pendingCalls) {
        messages.push({
          role: 'tool',
          content: p.result ?? INTERRUPTED_TOOL_RESULT,
          toolCallId: p.call.id,
        });
      }
    } else if (textBuffer !== '') {
      // 半截文本收尾为完整 assistant 消息（协议合法，spec §1 关键洞察）
      messages.push({ role: 'assistant', content: textBuffer });
    }
    textBuffer = '';
    pendingCalls = [];
    roundHasCalls = false;
  };

  return {
    push(ev: MessageEventRow): void {
      // eventType 实为 TEXT 列（可含未来类型 / 未知 kind），repo 联合类型是
      // 欠近似——放宽到 string 再分发
      switch (ev.eventType as string) {
        case 'text_delta': {
          // tool 活动后的 text = 新一轮开始，先收口上一轮
          if (roundHasCalls) closeRound();
          const delta = ev.payload.delta;
          if (typeof delta === 'string') textBuffer += delta;
          break;
        }
        case 'tool_call_start': {
          const callId = ev.payload.callId;
          const toolName = ev.payload.toolName;
          // 形态坏损（非字符串 id/name）无法构成协议对，跳过且不计预算
          if (typeof callId !== 'string' || typeof toolName !== 'string') break;
          pendingCalls.push({
            call: { id: callId, name: toolName, arguments: toPlainArgs(ev.payload.args) },
            result: null,
          });
          roundHasCalls = true;
          toolCallsUsed++;
          break;
        }
        case 'tool_call_result': {
          const callId = ev.payload.callId;
          const result = ev.payload.result;
          if (typeof callId !== 'string' || typeof result !== 'string') break;
          // 孤儿 result（无对应 start，生产不可能出现）无法构造协议对，跳过
          const pending = pendingCalls.find((p) => p.call.id === callId);
          if (pending) pending.result = result;
          break;
        }
        default:
          // thinking / todo_update / status_change / final / message_roll /
          // segment_boundary / steer / dispatch_start|result（历史遗留）/ 未知
          // kind：跳过（steer 由调用方按自身语义处理，不进 assistant 聚合）
          break;
      }
    },
    closeRound,
    appendMessage(m: LLMMessage): void {
      messages.push(m);
    },
    flush: closeRound,
    get messages(): LLMMessage[] {
      return messages;
    },
    get toolCallsUsed(): number {
      return toolCallsUsed;
    },
  };
}

/**
 * 取回合起始 user 消息正文。
 *
 * messages 表无「流 ↔ user 消息」直接外键——生产写入路径
 * （session-service.sendUserMessage）的 user 行特征：同 session_id、
 * sender='owner'、stream_session_id 为空。回合起始消息 = 流行（start chunk
 * INSERT 的 agent 行）创建时刻之前最近的一条 owner 行；created_at 用 <=
 * （同毫秒插入的 kickoff 与流行不丢）。steer 产生的 owner 行创建时刻必然
 * 晚于流行，天然被时间窗排除。
 */
function findTurnUserBody(baseRow: MessageRow): string | null {
  const row = getDb()
    .prepare(
      `SELECT body FROM messages
       WHERE session_id = ? AND sender = 'owner' AND created_at <= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(baseRow.sessionId, baseRow.createdAt) as { body: string } | undefined;
  return row?.body ?? null;
}

/**
 * 收集断点流的全部事件，按流全序排列。
 *
 * 关联行 = stream_session_id 精确命中（base 流行）或 `#` 后缀命中
 * （message_roll 换行产生的 `#roll{n}` 行——roll 后的事件落在新行）；
 * `#seg{n}` 分段行只是 body 快照（segment_of 非空），排除。
 * 行间序 = 行 created_at（repo 保证 ASC）；行内序 = seq（repo 保证 ASC，
 * 与插入顺序无关）。两者拼接即事件全序。
 */
function collectStreamEvents(streamSessionId: string): MessageEventRow[] {
  const rows = listMessagesByStreamSessionId(streamSessionId).filter((r) => !r.segmentOf);
  const events: MessageEventRow[] = [];
  for (const row of rows) {
    events.push(...listEventsByMessage(row.id));
  }
  return events;
}

/** 是否为 assistant 输出事件（steer drain 判定 / degenerate 判定的口径） */
function isOutputEvent(ev: MessageEventRow): boolean {
  return ev.eventType === 'text_delta' || ev.eventType === 'tool_call_start';
}

/** rebuildTurn / rebuildSessionContext 共享的流重建选项 */
interface StreamRebuildOptions {
  /** 头部是否 prepend 回合起始 user 消息（resume 用 true；会话重建的 walk 已渲染 owner 行，用 false） */
  includeUser: boolean;
  /**
   * 流末未 drain 的 steer 是否也渲染为 [用户中途补充] user 消息。
   * resume 用 false（收集进 steers[] 随载荷重放进 pendingSteers）；
   * 会话重建用 true（不存在 pendingSteers 消费者，行内渲染语义等价）。
   */
  undrainedSteersAsUser: boolean;
}

/** 共享核心返回形状（RebuiltTurn 超集） */
interface StreamRebuildResult {
  messages: LLMMessage[];
  toolCallsUsed: number;
  steers: string[];
  degenerate: boolean;
  /** 流末 DB 时刻 = 全部关联事件 createdAt 最大值（无事件回落流行 createdAt）——会话重建 steer 时间窗右端点 */
  endTs: number;
}

/**
 * 单流 events → LLMMessage 重建共享核心（rebuildTurn 与 rebuildSessionContext
 * 的同一语义实现：text_delta 拼接 / tool 对按 callId 配对 / 孤儿 call 合成
 * INTERRUPTED_TOOL_RESULT / steer 按 drain 语义分支）。
 */
function rebuildStreamMessages(
  streamSessionId: string,
  opts: StreamRebuildOptions,
): StreamRebuildResult {
  // 流行定位失败 = 从未执行（assigned 等）→ 纯重派降级
  const baseRow = getMessageByStreamSessionId(streamSessionId);
  if (!baseRow) {
    return { messages: [], toolCallsUsed: 0, steers: [], degenerate: true, endTs: 0 };
  }

  const agg = createAssistantRoundAggregator();
  const steers: string[] = [];
  let endTs = baseRow.createdAt;

  if (opts.includeUser) {
    const userBody = findTurnUserBody(baseRow);
    if (userBody !== null) {
      agg.appendMessage({ role: 'user', content: userBody });
    }
  }

  const events = collectStreamEvents(streamSessionId);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.createdAt > endTs) endTs = ev.createdAt;
    // eventType 实为 TEXT 列（可含未来类型 / T2 的 'steer' / 未知 kind），
    // repo 联合类型是欠近似——放宽到 string 再分发
    switch (ev.eventType as string) {
      case 'steer': {
        const body = ev.payload.body;
        if (typeof body !== 'string') break;
        // 其后是否仍有输出（drain 判定）；会话重建模式下未 drain 也渲染
        //（其后无任何输出，事件位渲染与流末渲染时序等价）
        const drained = events.slice(i + 1).some(isOutputEvent);
        if (drained || opts.undrainedSteersAsUser) {
          agg.closeRound();
          agg.appendMessage({ role: 'user', content: `[用户中途补充] ${body}` });
        } else {
          steers.push(body);
        }
        break;
      }
      default:
        // text / tool 事件进共享聚合状态机；其余（thinking / todo_update /
        // status_change / final / message_roll / segment_boundary / 未知 kind）跳过
        agg.push(ev);
    }
  }
  // 流末 flush：残留文本收尾 + 未配对 call 合成中断 result
  agg.flush();

  const messages = agg.messages;
  const degenerate = !messages.some((m) => m.role !== 'user');
  return { messages, toolCallsUsed: agg.toolCallsUsed, steers, degenerate, endTs };
}

/**
 * 重建断点回合（同步；纯读取）。
 *
 * 聚合状态机（plan Task 1 Step 2 绑定算法）：
 *   按 seq 序处理事件 → text_delta 累积为当前 assistant 文本缓冲 →
 *   tool_call_start 开 pending 对（同轮可多 call 并发）→ tool_call_result
 *   按 callId 配对 → 流末 flush：残留文本收尾为完整 assistant 消息 +
 *   未配对 call 合成 INTERRUPTED_TOOL_RESULT 的 tool 消息。
 *
 * 轮边界判定：任一 text_delta 出现在本轮 tool 活动之后 = 新一轮开始
 * （生产时序保证：轮内全部 text 先落，tool chunk 在流结束后按执行序落，
 * 故 tool 之后出现的 text 必属下一轮）。
 *
 * steer 消费语义：其后仍有输出事件 = 已 drain（按位重建
 * [用户中途补充] user 消息）；位于流末无后续输出 = 未 drain（进 steers[]
 * 随载荷重放——重放进 pendingSteers 后由下轮 drain 注入，语义等价）。
 */
export function rebuildTurn(streamSessionId: string): RebuiltTurn {
  try {
    const r = rebuildStreamMessages(streamSessionId, {
      includeUser: true,
      undrainedSteersAsUser: false,
    });
    return {
      messages: r.messages,
      toolCallsUsed: r.toolCallsUsed,
      steers: r.steers,
      degenerate: r.degenerate,
    };
  } catch (err) {
    // 降级阶梯（spec §5.3）：重建任何抛错 → catch 降级 degenerate（安全方向）
    logger.warn('rebuildTurn 重建失败，降级为全新回合', {
      streamSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyDegenerate();
  }
}

// ══ 会话连续性（spec 2026-09-14 §4）：主会话跨轮上下文 events 级重建 ══
//
// 与 rebuildTurn（单流断点续跑）/ rebuildSubConversation（子 agent 链续聊）同源的
// 第三条重建路径——主会话「下一轮」的 convCtx。此前该路径走 memory provider 的
// messages.body 启发式拼接（最早 20 行、无工具层、中断轮空正文），本函数对齐
// events 级保真：message_events 是事件溯源单一真相源，UI 与模型可见性拉平。

/** 会话重建选项 */
export interface SessionContextOptions {
  /** 窗口内「回合单位」数上限（owner 单位与流族单位同权计数），默认 20 */
  limitTurns?: number;
  /**
   * 丢弃时序最后的 owner 行（= 当前轮输入，runtime-entry 的 turnMessages 已含，
   * 不剔除则当前指令双拼）。顶层 chat / resume 路径恒传 true。
   */
  excludeTrailingOwnerRow?: boolean;
}

/** 会话重建结果 */
export interface RebuiltSessionContext {
  /** LLM 消息序列（含 tool 角色），可直接拼进 LLM 请求 */
  messages: LLMMessage[];
  /** 与 messages 平行的 DB createdAt（合成条取语义等价值）；供 compaction coveredUntil 精确化 */
  timestamps: number[];
}

/** 行拉取上限：两次 compaction 之间行数超此值的会话，窗口退化为最近 200 行内分组 */
const SESSION_ROW_FETCH_MARGIN = 200;
/** 默认窗口单位数 */
const DEFAULT_LIMIT_TURNS = 20;

/** 回合单位：owner 消息 | agent 流族（base + #roll，#seg 排除） */
type SessionUnit =
  | { kind: 'owner'; row: MessageRow }
  | { kind: 'family'; baseSsi: string; startTs: number; endTs: number; messages: LLMMessage[] };

/**
 * 重建会话跨轮 LLM 上下文（同步；纯读取）。
 *
 * 单位分组（spec §4.2）：ASC 行序遍历——owner 行为 user 单位；agent 流族首行触发
 * rebuildStreamMessages({includeUser:false}) 展开为 assistant/tool 消息族；#seg 快照行、
 * #roll 后续行、子 agent 流行（parent 非空且非 owner——子 agent 回复经父流 dispatch
 * 工具结果事件进入上下文）跳过。
 *
 * steer 行去重：owner 行落在某族时间窗 [族首行 created_at, 族末事件 created_at] 内
 * = steer 消息行（先落库、后由族内 steer 事件渲染 [用户中途补充]），walk 层跳过防
 * 双渲染；未 drain 的 steer（子进程死前未消费，无事件）只剩 owner 行，正常渲染。
 *
 * 降级：单族重建抛错跳过该族（warn）；整体抛错返回空上下文（fresh-session 形态，
 * 安全方向）。
 */
export function rebuildSessionContext(
  sessionId: string,
  opts?: SessionContextOptions,
): RebuiltSessionContext {
  try {
    // 直读 session_compactions（provider 既有先例：避免与 compaction/service 的静态循环依赖）
    const compaction = getDb()
      .prepare(
        'SELECT summary, covered_until AS coveredUntil FROM session_compactions WHERE session_id = ?',
      )
      .get(sessionId) as { summary: string; coveredUntil: number } | undefined;

    const rows = listRecentMessagesBySession(
      sessionId,
      SESSION_ROW_FETCH_MARGIN,
      compaction ? { afterTs: compaction.coveredUntil } : undefined,
    );

    // ① 骨架 + 族展开
    const units: SessionUnit[] = [];
    const seenFamilies = new Set<string>();
    for (const row of rows) {
      if (row.segmentOf !== null) continue; // #seg 快照行：事件在父行，快照无增量信息
      const isOwnerRow = row.sender === 'owner';
      // 子 agent 流行跳过（父流 dispatch 工具结果已携带其回复）；
      // owner 行带 parent（dispatch_followup 追问行）保留为 user 单位
      if (row.parentStreamSessionId !== null && !isOwnerRow) continue;
      if (isOwnerRow && !row.streamSessionId) {
        units.push({ kind: 'owner', row });
        continue;
      }
      const ssi = row.streamSessionId;
      if (!ssi) continue; // 防御：agent 行无流 id（契约外形态）
      const baseSsi = ssi.split('#')[0] ?? ssi;
      if (seenFamilies.has(baseSsi)) continue; // #roll 换行 / 族内重复行
      seenFamilies.add(baseSsi);
      // 单族降级：族重建抛错只跳过该族（warn），不牵连其余单位触发整体空上下文降级
      try {
        const rebuilt = rebuildStreamMessages(baseSsi, {
          includeUser: false,
          undrainedSteersAsUser: true,
        });
        units.push({
          kind: 'family',
          baseSsi,
          startTs: row.createdAt,
          endTs: rebuilt.endTs,
          messages: rebuilt.messages,
        });
      } catch (err) {
        logger.warn('rebuildSessionContext 单族重建失败，跳过该族', {
          baseSsi,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ② steer 行去重 + 空轮流剔除
    const families = units.filter(
      (u): u is Extract<SessionUnit, { kind: 'family' }> => u.kind === 'family',
    );
    let rendered = units.filter((u) => {
      if (u.kind === 'owner') {
        return !families.some(
          (f) => u.row.createdAt >= f.startTs && u.row.createdAt <= f.endTs,
        );
      }
      return u.messages.length > 0; // 零输出事件的族（含 aborted 空转）整体跳过
    });

    // ③ 剔除时序最后的 owner 单位（当前轮输入，turnMessages 已含）
    if (opts?.excludeTrailingOwnerRow) {
      for (let i = rendered.length - 1; i >= 0; i--) {
        if (rendered[i]!.kind === 'owner') {
          rendered = rendered.slice(0, i).concat(rendered.slice(i + 1));
          break;
        }
      }
    }

    // ④ 窗口裁剪：最后 limitTurns 个单位（下限 1 防 limitTurns=0 时 slice(-0) 全量退化）
    const limitTurns = Math.max(1, opts?.limitTurns ?? DEFAULT_LIMIT_TURNS);
    const windowed = rendered.slice(-limitTurns);

    // ⑤ 展平 + 平行时间戳（族单位消息统一取族首行时刻——回合粒度，
    // runCompaction 的 turnStart-1 兜底语义不受影响）
    const messages: LLMMessage[] = [];
    const timestamps: number[] = [];
    for (const u of windowed) {
      if (u.kind === 'owner') {
        messages.push({ role: 'user', content: u.row.body });
        timestamps.push(u.row.createdAt);
      } else {
        messages.push(...u.messages);
        for (let i = 0; i < u.messages.length; i++) timestamps.push(u.startTs);
      }
    }

    // ⑥ prune：最后一条 user 消息之前的旧轮 tool 结果截断（常量与 compaction 同源，
    // 防 双份漂移；与 provider pruneOldToolResults 同规则）
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const cutoff = lastUserIdx === -1 ? messages.length : lastUserIdx;
    for (let i = 0; i < cutoff; i++) {
      const m = messages[i]!;
      if (m.role === 'tool' && m.content.length > TOOL_RESULT_MAX_LEN) {
        m.content = `${m.content.slice(0, TOOL_RESULT_MAX_LEN)}\n${TRUNCATED_MARKER}`;
      }
    }

    // ⑦ compaction 摘要头注入（合成条不参与 ⑥ 的截断与锚点判定）
    if (compaction) {
      messages.unshift({
        role: 'user',
        content: `[此前对话压缩摘要]\n${compaction.summary}`,
      });
      timestamps.unshift(compaction.coveredUntil);
    }

    return { messages, timestamps };
  } catch (err) {
    logger.warn('rebuildSessionContext 重建失败，降级为空上下文（fresh-session 形态）', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], timestamps: [] };
  }
}
