// renderer/src/stores/stream.store.test.ts
//
// stream.store 聚合行为单测。
// 回归锁（2.0.0 主机验收 P0-4）：hydrateFromEvents 对空 events 数组必须 no-op——
// 此前空数组也写入 streams（aggregateEvents([]) 默认 status='streaming'），
// 重启后所有零事件消息（用户消息）被灌入幽灵流式状态，MessageBubble 把它们
// 渲染成空的"流式中"气泡，用户消息文本完全不显示。
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamStore } from './stream.store';
import type { MessageEventRow } from '../ipc/types';

function ev(seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq * 1000 };
}

describe('hydrateFromEvents 空 events 防御（P0-4）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('空 events 数组 → 不创建 streams 条目（用户消息保持静态气泡渲染）', () => {
    useStreamStore.getState().hydrateFromEvents('owner-msg-1', []);
    expect(useStreamStore.getState().streams.has('owner-msg-1')).toBe(false);
  });

  it('非空 events → 正常聚合（agent 消息富气泡不受影响）', () => {
    useStreamStore.getState().hydrateFromEvents('agent-msg-1', [
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'text_delta', { delta: '你好' }),
      ev(3, 'final', { status: 'done' }),
    ]);
    const s = useStreamStore.getState().streams.get('agent-msg-1');
    expect(s).toBeDefined();
    expect(s!.text).toBe('你好');
    expect(s!.status).toBe('done');
  });

  it('先空后实（同 messageId 二次 hydrate）→ 实数据正常生效', () => {
    useStreamStore.getState().hydrateFromEvents('m2', []);
    expect(useStreamStore.getState().streams.has('m2')).toBe(false);
    useStreamStore.getState().hydrateFromEvents('m2', [ev(1, 'text_delta', { delta: 'x' })]);
    const s = useStreamStore.getState().streams.get('m2');
    expect(s?.text).toBe('x');
  });
});

describe('applyEventBatch 去重键（P0-5：占位 id 不得误杀后续批次）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('不同批次、同占位 id、不同 seq → 两条都累积（修复前第二批被去重吞掉）', () => {
    // 仿真修复前的主进程行为：两批事件 id 同为 'buffered' 占位
    useStreamStore.getState().applyEventBatch([
      { id: 'buffered', messageId: 'm9', seq: 1, eventType: 'status_change', payload: { status: 'streaming' }, createdAt: 1 },
    ]);
    useStreamStore.getState().applyEventBatch([
      { id: 'buffered', messageId: 'm9', seq: 2, eventType: 'text_delta', payload: { delta: '第一' }, createdAt: 2 },
      { id: 'buffered', messageId: 'm9', seq: 3, eventType: 'text_delta', payload: { delta: '批' }, createdAt: 3 },
    ]);
    const s = useStreamStore.getState().streams.get('m9');
    expect(s).toBeDefined();
    expect(s!.text).toBe('第一批');
  });

  it('真重复（同 messageId 同 seq 重放）→ 仍被去重', () => {
    useStreamStore.getState().applyEventBatch([
      { id: 'real-1', messageId: 'm10', seq: 1, eventType: 'text_delta', payload: { delta: 'a' }, createdAt: 1 },
    ]);
    useStreamStore.getState().applyEventBatch([
      { id: 'real-1-dup', messageId: 'm10', seq: 1, eventType: 'text_delta', payload: { delta: 'a' }, createdAt: 1 },
    ]);
    const s = useStreamStore.getState().streams.get('m10');
    expect(s!.text).toBe('a');
    expect(s!.events.length).toBe(1);
  });
});

// —— 以下自 renderer/tests/stores/stream.store.test.ts 迁入（2026-08 目录规范统一：renderer 单测贴源存放）——
// 基础行为锁：applyEventBatch 累积 / final 转 done / 增量 append / hydrate 重启场景 / reset，
// 与上方 P0-4（空 events 防御）、P0-5（去重键）回归锁互补。
/** 构造一条 MessageEventRow（seq 同时作为 createdAt，便于断言） */
function mkEvent(
  messageId: string,
  seq: number,
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
): MessageEventRow {
  return {
    id: `e${messageId}-${seq}`,
    messageId,
    seq,
    eventType,
    payload,
    createdAt: seq,
  };
}

describe('stream.store：基础行为', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  // 注：zustand 的 getState() 返回 state 快照，set 后旧快照不会同步更新。
  // 因此每个断言点都重新 getState() 拿最新 state，而不是复用 store 变量读 streams。
  it('applyEventBatch 累积 events，按 messageId 聚合为 StreamState', () => {
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 0, 'thinking_delta', { delta: 'think' }),
      mkEvent('m1', 1, 'text_delta', { delta: 'hi' }),
    ]);
    const stream = useStreamStore.getState().streams.get('m1');
    expect(stream).toBeDefined();
    expect(stream!.thinking).toBe('think');
    expect(stream!.text).toBe('hi');
    expect(stream!.status).toBe('streaming');
  });

  it('final 事件后 status=done', () => {
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 0, 'text_delta', { delta: 'a' }),
      mkEvent('m1', 1, 'final', {}),
    ]);
    expect(useStreamStore.getState().streams.get('m1')?.status).toBe('done');
  });

  it('增量 append（先 1 条，再 2 条），text 拼接正确', () => {
    useStreamStore.getState().applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 1, 'text_delta', { delta: 'b' }),
      mkEvent('m1', 2, 'text_delta', { delta: 'c' }),
    ]);
    expect(useStreamStore.getState().streams.get('m1')?.text).toBe('abc');
  });

  it('从 ImStore eventsByMessage 初始化（重启场景）', () => {
    const events = [
      mkEvent('m2', 0, 'thinking_delta', { delta: 'past' }),
      mkEvent('m2', 1, 'final', {}),
    ];
    useStreamStore.getState().hydrateFromEvents('m2', events);
    expect(useStreamStore.getState().streams.get('m2')?.thinking).toBe('past');
    expect(useStreamStore.getState().streams.get('m2')?.status).toBe('done');
  });

  it('reset 清空所有 streams', () => {
    useStreamStore.getState().applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    useStreamStore.getState().reset();
    expect(useStreamStore.getState().streams.size).toBe(0);
  });
});

// —— net-off 沙箱网络拦截检测（v2.4.x net-off 通知卡）——
// 双条件：① sandbox tag 为 net-off（bwrap/seatbelt，tag 由主进程 resolveShellSpawn 生成、
// 紧跟 exit_code 行——tag 在场=网络态权威）② 命中网络拒绝签名任一。
// 结果文本仿真 shell-tools.ts 真实输出形态（parts 以 '\n\n' join：exit_code / sandbox / stderr 段）。
describe('stream.store：net-off 网络拦截检测', () => {
  /** bash tool_call_result 事件（payload 形状对齐 stream-aggregator 消费的 p.result/p.callId） */
  function bashResult(seq: number, result: string): MessageEventRow {
    return {
      id: `e${seq}`,
      messageId: 'mb',
      seq,
      eventType: 'tool_call_result',
      payload: { callId: 'c1', result, success: false },
      createdAt: seq * 1000,
    };
  }

  /** 仿真 bash 结果文本：exit_code 段 + 可选 sandbox tag 段 + stderr 段 */
  function bashOutput(tagLine: string | null, stderrLine: string): string {
    const parts: string[] = ['exit_code: 1'];
    if (tagLine) parts.push(tagLine);
    parts.push(`stderr:\n${stderrLine}`);
    return parts.join('\n\n');
  }

  const TAG_BWRAP = 'sandbox: bwrap/net-off';
  const TAG_SEATBELT = 'sandbox: seatbelt/net-off';

  /** 四类网络拒绝签名 × 真实工具输出样例（node 监听 / node connect / curl DNS / curl 连接失败） */
  const SIGNATURE_CASES: ReadonlyArray<readonly [string, string]> = [
    ['listen EPERM', 'Error: listen EPERM 0.0.0.0:3000'],
    ['connect EPERM', 'Error: connect EPERM 93.184.216.34:443'],
    ['Could not resolve host', 'curl: (6) Could not resolve host: example.com'],
    ['curl: (7)', "curl: (7) Failed to connect to example.com port 443 after 10 ms: Couldn't connect to server"],
  ];

  beforeEach(() => {
    useStreamStore.getState().reset();
    // reset 刻意不清一次性标志（生产语义）——测试隔离在此手动归位
    useStreamStore.setState({ netBlockedSeen: false });
  });

  // 矩阵：四签名 × tag 有无
  for (const [name, stderrLine] of SIGNATURE_CASES) {
    it(`bwrap/net-off tag + ${name} 签名 → 置 netBlockedSeen`, () => {
      useStreamStore.getState().applyEventBatch([bashResult(1, bashOutput(TAG_BWRAP, stderrLine))]);
      expect(useStreamStore.getState().netBlockedSeen).toBe(true);
    });

    it(`无 tag + ${name} 签名 → 不置（非沙箱所致的网络错误）`, () => {
      useStreamStore.getState().applyEventBatch([bashResult(1, bashOutput(null, stderrLine))]);
      expect(useStreamStore.getState().netBlockedSeen).toBe(false);
    });
  }

  it('seatbelt/net-off tag + listen EPERM → 置位（macOS 主机实测形态）', () => {
    useStreamStore.getState().applyEventBatch([
      bashResult(1, bashOutput(TAG_SEATBELT, 'Error: listen EPERM 0.0.0.0:5173')),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(true);
  });

  it('bwrap/net-on tag + 签名 → 不置（网络开关已开，非 net-off tag）', () => {
    useStreamStore.getState().applyEventBatch([
      bashResult(1, bashOutput('sandbox: bwrap/net-on', 'Error: listen EPERM 0.0.0.0:3000')),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(false);
  });

  it('tag 在场但未碰网络（无签名）→ 不置（未产生网络错误的命令不打扰）', () => {
    useStreamStore.getState().applyEventBatch([
      bashResult(1, bashOutput(TAG_BWRAP, 'src/index.ts: syntax error')),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(false);
  });

  it('text_delta 正文含 tag + 签名文本 → 不置（仅 bash tool_call_result 参与检测）', () => {
    useStreamStore.getState().applyEventBatch([
      mkEvent('m3', 1, 'text_delta', {
        delta: `sandbox: bwrap/net-off\nError: listen EPERM 0.0.0.0:3000`,
      }),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(false);
  });

  it('一次性标志：置位后的后续批次不复位（不自动清）', () => {
    useStreamStore.getState().applyEventBatch([
      bashResult(1, bashOutput(TAG_BWRAP, 'Error: listen EPERM 0.0.0.0:3000')),
    ]);
    useStreamStore.getState().applyEventBatch([
      bashResult(2, bashOutput(TAG_BWRAP, 'build ok')),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(true);
  });

  it('reset() 不清 netBlockedSeen（每 app 运行至多置一次——workspace 切换不重置）', () => {
    useStreamStore.getState().applyEventBatch([
      bashResult(1, bashOutput(TAG_BWRAP, 'Error: listen EPERM 0.0.0.0:3000')),
    ]);
    useStreamStore.getState().reset();
    expect(useStreamStore.getState().netBlockedSeen).toBe(true);
  });

  it('hydrateFromEvents 回放含拦截结果的历史 → 不置（重启自然消失：仅实时路径检测）', () => {
    useStreamStore.getState().hydrateFromEvents('m-replay', [
      bashResult(1, bashOutput(TAG_BWRAP, 'Error: listen EPERM 0.0.0.0:3000')),
      mkEvent('m-replay', 2, 'final', { status: 'done' }),
    ]);
    expect(useStreamStore.getState().netBlockedSeen).toBe(false);
  });
});
