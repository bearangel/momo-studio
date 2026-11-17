// view-frames 帧聚合纯函数测试（wire v2 投影单点，spec 2026-11-17 §4）。
// 锁什么：
//   text 聚合     delta 游程拼接 / final.body 定稿 / 无终态 streaming=true /
//                owner 消息 → user 帧
//   thinking 裁剪 thinking_delta / thinking 整族丢弃且不污染正文
//   工具配对     callId 配对回填 / 无 callId 栈序配对 / result 截断 truncated /
//                argsExcerpt 截 200
//   steer 帧     steer 事件 → kind='steer' role='user' content=body
//   健壮性       payload 非对象行跳过不断流 / 未知事件类型丢弃
//   tail 伴生    aggregateTail 输出 openStarts（未终态帧 → 帧首 rowid）
import { beforeEach, describe, expect, it } from 'vitest';
import { aggregateFrames, aggregateTail, type FrameEventRow } from '../../src/main/hub/view-frames';

let rowSeq = 0;
beforeEach(() => { rowSeq = 0; });
/** 顺序递增 rowid 的行构造器（seq 即 rowid 语义） */
function row(over: Partial<FrameEventRow> & Pick<FrameEventRow, 'eventType'>): FrameEventRow {
  rowSeq += 1;
  return {
    seq: rowSeq, at: 1_700_000_000_000 + rowSeq, messageId: 'm1', sender: 'agent',
    payload: {}, ...over,
  };
}

describe('text 帧聚合', () => {
  it('delta 游程拼接 + final.body 定稿 + 无 streaming', () => {
    const rows = [
      row({ eventType: 'text_delta', payload: { delta: '你' } }),
      row({ eventType: 'text_delta', payload: { delta: '好' } }),
      row({ eventType: 'final', payload: { body: '你好世界', status: 'done' } }),
    ];
    const frames = aggregateFrames(rows);
    expect(frames).toEqual([
      { frameId: 'm1', seq: 3, at: rows[2]!.at, role: 'assistant', kind: 'text', content: '你好世界' },
    ]);
  });

  it('无终态 → streaming=true；content 为已到增量', () => {
    const rows = [
      row({ eventType: 'text_delta', payload: { delta: '生' } }),
      row({ eventType: 'text_delta', payload: { delta: '成中' } }),
    ];
    expect(aggregateFrames(rows)).toEqual([
      { frameId: 'm1', seq: 2, at: rows[1]!.at, role: 'assistant', kind: 'text', content: '生成中', streaming: true },
    ]);
  });

  it('status_change 终态收敛 streaming', () => {
    const rows = [
      row({ eventType: 'text_delta', payload: { delta: 'x' } }),
      row({ eventType: 'status_change', payload: { status: 'done' } }),
    ];
    expect(aggregateFrames(rows)[0]?.streaming).toBeUndefined();
  });

  it('owner 消息 → kind=user 帧（body 承载事件）；owner 永不 streaming', () => {
    const rows = [row({ eventType: 'message', sender: 'owner', payload: { body: '任务书原文' } })];
    expect(aggregateFrames(rows)).toEqual([
      { frameId: 'm1', seq: 1, at: rows[0]!.at, role: 'user', kind: 'user', content: '任务书原文' },
    ]);
  });

  it('多消息各自成帧，帧序按末行 rowid', () => {
    const rows = [
      row({ eventType: 'text_delta', messageId: 'mA', payload: { delta: 'A' } }),
      row({ eventType: 'message', sender: 'owner', messageId: 'mU', payload: { body: '问' } }),
      row({ eventType: 'final', messageId: 'mA', payload: { body: 'A 全文' } }),
    ];
    const frames = aggregateFrames(rows);
    expect(frames.map((f) => [f.frameId, f.seq])).toEqual([['mU', 2], ['mA', 3]]);
  });
});

describe('thinking 裁剪', () => {
  it('thinking_delta / thinking 整族丢弃且不污染正文', () => {
    const rows = [
      row({ eventType: 'thinking_delta', payload: { delta: '思考碎片' } }),
      row({ eventType: 'text_delta', payload: { delta: '正文' } }),
      row({ eventType: 'thinking', payload: { delta: '旧类型' } }),
      row({ eventType: 'final', payload: { body: '正文' } }),
    ];
    const frames = aggregateFrames(rows);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'text', content: '正文' });
  });
});

describe('工具帧配对', () => {
  it('callId 配对：start 开帧 result 回填', () => {
    const rows = [
      row({ eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'bash', args: 'ls -la' } }),
      row({ eventType: 'tool_call_result', payload: { callId: 'c1', result: 'file1\nfile2', success: true } }),
    ];
    expect(aggregateFrames(rows)).toEqual([
      {
        frameId: 'c1', seq: 2, at: rows[1]!.at, role: 'assistant', kind: 'tool',
        tool: { name: 'bash', argsExcerpt: 'ls -la', result: 'file1\nfile2', success: true },
      },
    ]);
  });

  it('在途工具（无 result）→ 无 result 字段的工具帧', () => {
    const rows = [row({ eventType: 'tool_call_start', payload: { callId: 'c2', toolName: 'edit' } })];
    expect(aggregateFrames(rows)).toEqual([
      { frameId: 'c2', seq: 1, at: rows[0]!.at, role: 'assistant', kind: 'tool', tool: { name: 'edit' } },
    ]);
  });

  it('无 callId 栈序配对（FIFO——顺序调用形态；真实链路恒带 callId，此路纯防御）', () => {
    const rows = [
      row({ eventType: 'tool_call_start', payload: { toolName: 'a' } }),
      row({ eventType: 'tool_call_start', payload: { toolName: 'b' } }),
      row({ eventType: 'tool_call_result', payload: { result: 'rb', success: false } }),
      row({ eventType: 'tool_call_result', payload: { result: 'ra', success: true } }),
    ];
    const frames = aggregateFrames(rows);
    expect(frames.map((f) => [f.tool?.name, f.tool?.result])).toEqual([
      ['a', 'rb'],
      ['b', 'ra'],
    ]);
  });

  it('result 超 800 字符截断 + truncated；args 对象序列化截 200', () => {
    const long = 'x'.repeat(900);
    const argObj = { path: 'y'.repeat(300) };
    const rows = [
      row({ eventType: 'tool_call_start', payload: { callId: 'c3', toolName: 'bash', args: argObj } }),
      row({ eventType: 'tool_call_result', payload: { callId: 'c3', result: long, success: true } }),
    ];
    const f = aggregateFrames(rows)[0]!;
    expect(f.tool?.result).toHaveLength(800);
    expect(f.tool?.truncated).toBe(true);
    expect(f.tool?.result).toBe('x'.repeat(800));
    expect(f.tool?.argsExcerpt).toHaveLength(200);
  });

  it('孤 result（无 start）→ 丢弃不炸', () => {
    const rows = [row({ eventType: 'tool_call_result', payload: { callId: 'ghost', result: 'r', success: true } })];
    expect(aggregateFrames(rows)).toEqual([]);
  });
});

describe('steer 帧', () => {
  it('steer 事件 → kind=steer role=user content=body（独立 frameId）', () => {
    const rows = [
      row({ eventType: 'text_delta', payload: { delta: '工作中' } }),
      row({ eventType: 'steer', payload: { body: '补充指令内容' } }),
    ];
    const frames = aggregateFrames(rows);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      frameId: `m1:steer:${rows[1]!.seq}`, seq: rows[1]!.seq, at: rows[1]!.at,
      role: 'user', kind: 'steer', content: '补充指令内容',
    });
  });

  it('steer 事件带 context 不外泄（只投影 body）', () => {
    const rows = [row({ eventType: 'steer', payload: { body: 'b', context: { files: ['秘密'] } } })];
    expect(aggregateFrames(rows)[0]?.content).toBe('b');
  });
});

describe('健壮性', () => {
  it('payload 非对象行跳过不断流', () => {
    const rows = [
      row({ eventType: 'text_delta', payload: { delta: '前' } }),
      { ...row({ eventType: 'text_delta' }), payload: null },
      row({ eventType: 'text_delta', payload: { delta: '后' } }),
    ];
    const f = aggregateFrames(rows)[0]!;
    expect(f.content).toBe('前后');
  });

  it('未知事件类型丢弃（todo_update/dispatch 等）', () => {
    const rows = [
      row({ eventType: 'todo_update', payload: { items: [] } }),
      row({ eventType: 'dispatch_start', payload: {} }),
      row({ eventType: 'segment_boundary', payload: {} }),
    ];
    expect(aggregateFrames(rows)).toEqual([]);
  });

  it('空行集 → 空帧集', () => {
    expect(aggregateFrames([])).toEqual([]);
  });
});

describe('aggregateTail 伴生输出', () => {
  it('openStarts：未终态 text 帧与在途 tool 帧 → 帧首 rowid；终态帧不入', () => {
    const rows = [
      row({ eventType: 'text_delta', messageId: 'mA', payload: { delta: '流' } }),
      row({ eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'bash' } }),
      row({ eventType: 'text_delta', messageId: 'mB', payload: { delta: '完' } }),
      row({ eventType: 'final', messageId: 'mB', payload: { body: '完' } }),
    ];
    const { frames, openStarts } = aggregateTail(rows);
    expect(openStarts.get('mA')).toBe(rows[0]!.seq);
    expect(openStarts.get('c1')).toBe(rows[1]!.seq);
    expect(openStarts.has('mB')).toBe(false);
    expect(frames.filter((f) => f.streaming)).toHaveLength(1);
  });
});
