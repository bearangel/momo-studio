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
//   （steer 事件生产落库由 v2.6.0 Task 2 接线，本模块先行消费）
//   thinking / todo_update / status_change / final / message_roll /
//   segment_boundary / 未知 kind → 跳过（不进 LLM 上下文 / 前向兼容）
import type { LLMMessage, LLMToolCall } from './llm-provider';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import {
  getMessageByStreamSessionId,
  listMessagesByStreamSessionId,
  type MessageRow,
} from '../storage/messages/repo';
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

/** args 形态防御：非普通对象（损坏行）按空参数处理，不中断重建 */
function toPlainArgs(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
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
    // 流行定位失败 = 从未执行（assigned 等）→ 纯重派降级
    const baseRow = getMessageByStreamSessionId(streamSessionId);
    if (!baseRow) return emptyDegenerate();

    const messages: LLMMessage[] = [];
    const steers: string[] = [];
    let toolCallsUsed = 0;

    const userBody = findTurnUserBody(baseRow);
    if (userBody !== null) {
      messages.push({ role: 'user', content: userBody });
    }

    const events = collectStreamEvents(streamSessionId);

    // 轮状态
    let textBuffer = '';
    let pendingCalls: PendingCall[] = [];
    let roundHasCalls = false;

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

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      // eventType 实为 TEXT 列（可含未来类型 / T2 的 'steer' / 未知 kind），
      // repo 联合类型是欠近似——放宽到 string 再分发
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
        case 'steer': {
          const body = ev.payload.body;
          if (typeof body !== 'string') break;
          // 其后是否仍有输出（drain 判定，见函数头注释）
          const drained = events.slice(i + 1).some(isOutputEvent);
          if (drained) {
            closeRound();
            messages.push({ role: 'user', content: `[用户中途补充] ${body}` });
          } else {
            steers.push(body);
          }
          break;
        }
        default:
          // thinking / todo_update / status_change / final / message_roll /
          // segment_boundary / dispatch_start|result（历史遗留）/ 未知 kind：跳过
          break;
      }
    }
    // 流末 flush：残留文本收尾 + 未配对 call 合成中断 result
    closeRound();

    const degenerate = !messages.some((m) => m.role !== 'user');
    return { messages, toolCallsUsed, steers, degenerate };
  } catch (err) {
    // 降级阶梯（spec §5.3）：重建任何抛错 → catch 降级 degenerate（安全方向）
    logger.warn('rebuildTurn 重建失败，降级为全新回合', {
      streamSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyDegenerate();
  }
}
