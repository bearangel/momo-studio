// electron/src/main/hub/view-frames.ts
//
// wire v2 帧聚合（spec 2026-11-17 §4）：message_events 行 → ViewFrame 序列的
// 纯函数投影单点。worker 侧 view-server 消费；thinking 整族在此丢弃（D2 裁剪
// 决策——带宽不出 worker）、text_delta 游程按消息聚合、工具调用 start/result
// 配对成结构化帧、steer 事件投影为带 kind='steer' 标记的 user 帧。
// 纯函数无 DB / 无副作用——全部可测性在此文件。
import type { ViewFrame } from './protocol';
import { TOOL_RESULT_WIRE_BUDGET } from '../storage/messages/event-projection';

/** 单事件 content 封顶（对齐 view-server CONTENT_MAX——帧正文同界） */
const CONTENT_MAX = 256 * 1024;
/** argsExcerpt 预算（字符）——折叠态摘要足够 */
const ARGS_EXCERPT_MAX = 200;

/** 聚合输入行（sessionEvents 查询行的解包形态；payload=null 表示载荷损坏） */
export interface FrameEventRow {
  /** 事件 rowid（全序单调——帧末行 rowid 成为帧 seq） */
  seq: number;
  at: number;
  messageId: string;
  sender: string;
  eventType: string;
  payload: Record<string, unknown> | null;
}

function clamp(text: string): string {
  return text.length > CONTENT_MAX ? text.slice(0, CONTENT_MAX) : text;
}

function isTerminalEvent(eventType: string, payload: Record<string, unknown> | null): boolean {
  if (eventType === 'final') return payload?.status !== 'streaming';
  if (eventType === 'status_change') {
    const s = payload?.status;
    return s === 'done' || s === 'failed' || s === 'aborted';
  }
  return false;
}

/** 消息正文帧的累加器（text/user 共用：owner 消息 → kind='user'）。
 *  段键（2026-11-20 T-070 拍板）：同消息正文遇工具调用边界分段——frameId 段 0
 *  无后缀（无穿插场景兼容既有 id），段 n≥1 为 `${messageId}#${n}`；A 端呈现
 *  与执行端流式视图（文本段/工具交错）一致，不再整合成单块。 */
interface TextAgg {
  frameId: string;
  messageId: string;
  seg: number;
  firstRowid: number;
  lastRowid: number;
  at: number;
  owner: boolean;
  deltas: string[];
  /** final.body 到达后以其为准（单一真相源语义，沿 aggregateTextDeltas）——
   *  分段模式下仅段 0（无穿插）使用；多段消息全文校验见 aggregate 输出段 */
  finalized: string | null;
  terminal: boolean;
}

interface ToolAgg {
  frameId: string;
  firstRowid: number;
  lastRowid: number;
  at: number;
  name: string;
  argsExcerpt?: string;
  result?: string;
  success?: boolean;
  truncated?: boolean;
}

function argsToExcerpt(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.slice(0, ARGS_EXCERPT_MAX);
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    try {
      return JSON.stringify(raw).slice(0, ARGS_EXCERPT_MAX);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface TailAggregate {
  /** 帧序列（帧末行 rowid 升序） */
  frames: ViewFrame[];
  /** 未终态帧（streaming text / 在途 tool）frameId → 帧首 rowid——tick 重读下限依据 */
  openStarts: ReadonlyMap<string, number>;
}

/** 消息级终态标记：该消息全部段 terminal。不推段位（seq=段末事件行——final
 *  行不是正文段的定位事件，推位会打乱段/工具交错序，T-070 实测）。 */
function markMessageTerminal(
  texts: Map<string, TextAgg>,
  messageId: string,
): void {
  for (const agg of texts.values()) {
    if (agg.messageId === messageId) agg.terminal = true;
  }
}

/** 核心聚合（aggregateFrames / aggregateTail 共用）。 */
function aggregate(rows: FrameEventRow[]): TailAggregate {
  const texts = new Map<string, TextAgg>();
  const tools = new Map<string, ToolAgg>();
  /** 无 callId 工具的栈序配对（同消息内 start/result 依序匹配） */
  const unpairedStack: string[] = [];
  /** steer 帧（独立于消息帧：frameId = messageId:steer:rowid） */
  const steers: ViewFrame[] = [];
  /** 同消息活动段号（工具边界递增——正文分段聚合） */
  const curSeg = new Map<string, number>();
  /** final 全文（消息级单一真相源：分段一致性校验用） */
  const msgFinalBody = new Map<string, string>();

  const segKey = (messageId: string, seg: number): string =>
    seg === 0 ? messageId : `${messageId}#${seg}`;

  for (const r of rows) {
    const p = r.payload;
    switch (r.eventType) {
      // 裁剪面：thinking 整族丢弃（含旧 'thinking' 类型——legacy 投影同款宽容）
      case 'thinking_delta':
      case 'thinking':
        continue;
      case 'steer': {
        const body = p !== null && typeof p.body === 'string' ? p.body : null;
        if (body === null) continue;
        const frameId = `${r.messageId}:steer:${r.seq}`;
        steers.push({
          frameId, seq: r.seq, at: r.at, role: 'user', kind: 'steer', content: clamp(body),
        });
        continue;
      }
      case 'tool_call_start': {
        if (p === null) continue;
        const name = typeof p.toolName === 'string' ? p.toolName : 'unknown';
        const callId = typeof p.callId === 'string' && p.callId !== '' ? p.callId : null;
        const frameId = callId ?? `tool:${r.seq}`;
        if (tools.has(frameId)) continue; // 幂等：重复 start 忽略
        // 正文分段边界：同消息工具开始 → 后续 delta 开新段（段 0 无后缀兼容）
        curSeg.set(r.messageId, (curSeg.get(r.messageId) ?? 0) + 1);
        tools.set(frameId, {
          frameId, firstRowid: r.seq, lastRowid: r.seq, at: r.at,
          name, argsExcerpt: argsToExcerpt(p.args),
        });
        if (callId === null) unpairedStack.push(frameId);
        continue;
      }
      case 'tool_call_result': {
        if (p === null) continue;
        const callId = typeof p.callId === 'string' && p.callId !== '' ? p.callId : null;
        const target = callId !== null ? tools.get(callId) : undefined;
        const frameId = target?.frameId ?? (callId !== null ? callId : unpairedStack.shift());
        if (frameId === undefined) continue; // 孤 result：丢弃不炸
        const agg = tools.get(frameId);
        if (agg === undefined) continue;
        agg.lastRowid = r.seq;
        agg.at = r.at;
        const result = typeof p.result === 'string' ? p.result : null;
        if (result !== null) {
          if (result.length > TOOL_RESULT_WIRE_BUDGET) {
            agg.result = result.slice(0, TOOL_RESULT_WIRE_BUDGET);
            agg.truncated = true;
          } else {
            agg.result = result;
          }
        }
        if (typeof p.success === 'boolean') agg.success = p.success;
        continue;
      }
      case 'text_delta': {
        const delta = p !== null && typeof p.delta === 'string' ? p.delta : null;
        if (delta === null) continue;
        const seg = curSeg.get(r.messageId) ?? 0;
        const key = segKey(r.messageId, seg);
        const agg = texts.get(key) ?? {
          frameId: key, messageId: r.messageId, seg, firstRowid: r.seq, lastRowid: r.seq, at: r.at,
          owner: r.sender === 'owner', deltas: [], finalized: null, terminal: false,
        };
        agg.deltas.push(delta);
        agg.lastRowid = r.seq;
        agg.at = r.at;
        texts.set(key, agg);
        continue;
      }
      case 'final': {
        if (p === null) continue; // corrupt final：不定稿不建帧（误判终态=空气泡+假收敛）
        if (typeof p?.body === 'string') msgFinalBody.set(r.messageId, p.body);
        if (isTerminalEvent(r.eventType, p)) markMessageTerminal(texts, r.messageId);
        continue;
      }
      case 'status_change': {
        if (isTerminalEvent(r.eventType, p)) markMessageTerminal(texts, r.messageId);
        continue;
      }
      default: {
        // body 承载的直落行：owner=任务书原文（user 帧）；system=里程碑行
        // （【发起方指令】/【打回理由】等——legacy 投影可见，wire2 对齐不丢行）
        if (typeof p?.body === 'string' && (r.sender === 'owner' || r.sender === 'system')) {
          const agg = texts.get(r.messageId) ?? {
            frameId: r.messageId, messageId: r.messageId, seg: 0, firstRowid: r.seq, lastRowid: r.seq, at: r.at,
            owner: r.sender === 'owner', deltas: [], finalized: null, terminal: true,
          };
          agg.finalized = p.body;
          agg.lastRowid = Math.max(agg.lastRowid, r.seq);
          agg.at = r.at;
          texts.set(r.messageId, agg);
        }
        // 其余事件类型（todo_update/dispatch_start/segment_boundary/…）丢弃
        continue;
      }
    }
  }

  const frames: ViewFrame[] = [];
  const openStarts = new Map<string, number>();

  // 消息分组（段序输出）；final 全文校验：分段拼接 ≠ final.body（delta 丢失/损坏）
  // → 该消息退化为单帧全文（单一真相源兜底——段级没有权威数据）
  const byMessage = new Map<string, TextAgg[]>();
  for (const agg of texts.values()) {
    const list = byMessage.get(agg.messageId) ?? [];
    list.push(agg);
    byMessage.set(agg.messageId, list);
  }
  const emit = (agg: TextAgg, contentOverride?: string): void => {
    const content = contentOverride ?? agg.finalized ?? agg.deltas.join('');
    if (content === '') return; // 空正文不占帧（未终态=尚无内容；终态=tool-only 回合零气泡）
    const streaming = !agg.owner && !agg.terminal;
    const frame: ViewFrame = {
      frameId: agg.frameId, seq: agg.lastRowid, at: agg.at,
      role: agg.owner ? 'user' : 'assistant',
      kind: agg.owner ? 'user' : 'text',
      content: clamp(content),
    };
    if (streaming) {
      frame.streaming = true;
      openStarts.set(agg.frameId, agg.firstRowid);
    }
    frames.push(frame);
  };

  for (const [messageId, segs] of byMessage) {
    segs.sort((a, b) => a.seg - b.seg);
    const finalBody = msgFinalBody.get(messageId);
    if (finalBody !== undefined) {
      const joined = segs.map((x) => x.deltas.join('')).join('');
      if (joined !== finalBody) {
        // 退化：全文单帧挂段 0 位（final.body 权威——delta 丢失/乱序兜底；
        // 单段消息即旧「final 定稿」行为；段 1+ 半截帧由 wire 替换消解）
        emit({ ...segs[0]!, deltas: [finalBody], finalized: finalBody, terminal: true });
        continue;
      }
    }
    for (const agg of segs) emit(agg);
  }
  for (const agg of tools.values()) {
    const tool: NonNullable<ViewFrame['tool']> = { name: agg.name };
    if (agg.argsExcerpt !== undefined) tool.argsExcerpt = agg.argsExcerpt;
    if (agg.result !== undefined) tool.result = agg.result;
    if (agg.success !== undefined) tool.success = agg.success;
    if (agg.truncated === true) tool.truncated = true;
    if (agg.result === undefined) openStarts.set(agg.frameId, agg.firstRowid); // 在途工具
    frames.push({
      frameId: agg.frameId, seq: agg.lastRowid, at: agg.at,
      role: 'assistant', kind: 'tool', tool,
    });
  }
  // steer 帧单行自终态：不入 openStarts（终审 C2——入列会永久锚定 tick 重读窗口，
  // 窗口一旦超 TAIL_BATCH_MAX 即冻结实时流）
  for (const f of steers) {
    frames.push(f);
  }
  frames.sort((a, b) => a.seq - b.seq);
  return { frames, openStarts };
}

/** 事件行 → 帧序列（渲染投影用）。 */
export function aggregateFrames(rows: FrameEventRow[]): ViewFrame[] {
  return aggregate(rows).frames;
}

/** tick 伴生形态：帧序列 + 未终态帧重读下限（游标语义见 view-server tick 注释）。 */
export function aggregateTail(rows: FrameEventRow[]): TailAggregate {
  return aggregate(rows);
}
