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
    expect(useStreamStore.getState().streams.has('m2')).toBe(false);    useStreamStore.getState().hydrateFromEvents('m2', [ev(1, 'text_delta', { delta: 'x' })]);
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

// —— 工具链写拦截检测（v2.5 沙箱工具链授权，spec 2026-10-01 §7/§8）——
// electron 侧 shell-tools.ts 在 HOME 写拦截命中时把 WRITE_BLOCKED_HINT 固定提示段
// 追加到 bash 结果尾部（parts.join('\n\n')——置尾，LLM 最后看到的行动指引）。
// renderer 侧硬编码同一子串检测（跨进程无共享模块，两端测试各自逐字锁）。

// ====================================================================
// 事件裁剪水合回退（工作空间切换卡顿修复，2026-09-25）
// 新契约：getMessages 对非最近窗口消息只回结构事件（无 text/thinking delta），
// 终态正文以 messages.body 为单一真相源——水合层在 stream.text 为空且给了
// fallbackBody 时回填正文与末尾 text 段，保证带工具卡的历史消息正文可见。
describe('hydrateFromEvents 裁剪回退（fallbackBody）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('终态 + 结构事件 + fallbackBody → text 回填 body、segments 末尾补 text 段', () => {
    useStreamStore.getState().hydrateFromEvents(
      'pruned-1',
      [
        ev(1, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
        ev(2, 'tool_call_result', { callId: 'c1', result: 'ok', success: true }),
        ev(3, 'final', { status: 'done' }),
      ],
      '历史消息正文全文',
    );
    const s = useStreamStore.getState().streams.get('pruned-1');
    expect(s).toBeDefined();
    expect(s!.status).toBe('done');
    expect(s!.text).toBe('历史消息正文全文');
    expect(s!.toolCalls).toHaveLength(1);
    const last = s!.segments[s!.segments.length - 1];
    expect(last?.kind).toBe('text');
    if (last?.kind === 'text') expect(last.text).toBe('历史消息正文全文');
  });

  it('流式中的消息不回退（fallbackBody 仅终态生效——流式正文以 delta 为准）', () => {
    useStreamStore.getState().hydrateFromEvents(
      'live-1',
      [
        ev(1, 'status_change', { status: 'streaming' }),
        ev(2, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
      ],
      '不应出现的正文',
    );
    const s = useStreamStore.getState().streams.get('live-1');
    expect(s!.status).toBe('streaming');
    expect(s!.text).toBe('');
  });

  it('无 fallbackBody（旧调用方兼容）→ 行为与旧契约一致（text 空）', () => {
    useStreamStore.getState().hydrateFromEvents('legacy-1', [
      ev(1, 'final', { status: 'done' }),
    ]);
    expect(useStreamStore.getState().streams.get('legacy-1')!.text).toBe('');
  });

  it('已有 text_delta 聚合的非空正文 → fallbackBody 不覆盖（去重保护）', () => {
    useStreamStore.getState().hydrateFromEvents(
      'full-1',
      [
        ev(1, 'text_delta', { delta: '增量正文' }),
        ev(2, 'final', { status: 'done' }),
      ],
      '不应覆盖',
    );
    expect(useStreamStore.getState().streams.get('full-1')!.text).toBe('增量正文');
  });
});

describe('hydrateFromEvents 按 seq 归并（2026-09-26 P0：截断水合抹掉实时积累）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  const rev = (seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow => ({
    id: `h${seq}`, messageId: 'm-h', seq, eventType, payload, createdAt: seq * 1000,
  });

  it('实时积累 5 事件后 hydrate 子集（流中截断快照形态）→ 工具卡与文本不丢', () => {
    // 场景：流式回合进行中切走工作空间再切回——实时批次已积累完整事件，
    // getMessages 却只回了 2 条事件的截断快照
    useStreamStore.getState().applyEventBatch([
      rev(0, 'thinking_delta', { delta: '思考' }),
      rev(1, 'text_delta', { delta: '开头' }),
      rev(2, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
      rev(3, 'tool_call_result', { callId: 'c1', result: 'ok', success: true }),
      rev(4, 'text_delta', { delta: '结尾' }),
    ]);
    useStreamStore.getState().hydrateFromEvents('m-h', [
      rev(0, 'thinking_delta', { delta: '思考' }),
      rev(1, 'text_delta', { delta: '开头' }),
    ]);
    const s = useStreamStore.getState().streams.get('m-h');
    expect(s?.toolCalls).toHaveLength(1);
    expect(s?.text).toBe('开头结尾');
    expect(s?.segments.map((x) => x.kind)).toEqual(['thinking', 'text', 'tool_call', 'text']);
  });

  it('hydrate 全量后再 hydrate 子集 → 不缩水（归并幂等上界）', () => {
    useStreamStore.getState().hydrateFromEvents('m-h', [
      rev(0, 'text_delta', { delta: 'a' }),
      rev(1, 'text_delta', { delta: 'b' }),
    ]);
    useStreamStore.getState().hydrateFromEvents('m-h', [rev(0, 'text_delta', { delta: 'a' })]);
    expect(useStreamStore.getState().streams.get('m-h')?.text).toBe('ab');
  });

  it('归并后续流：水合后实时批次 seq 无缝追加', () => {
    useStreamStore.getState().hydrateFromEvents('m-h', [
      rev(0, 'text_delta', { delta: 'a' }),
      rev(1, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
    ]);
    useStreamStore.getState().applyEventBatch([
      rev(2, 'tool_call_result', { callId: 'c1', result: 'ok', success: true }),
      rev(3, 'text_delta', { delta: 'z' }),
    ]);
    const s = useStreamStore.getState().streams.get('m-h');
    expect(s?.text).toBe('az');
    expect(s?.toolCalls).toHaveLength(1);
  });
});


// ═══ 回归锁（spec 2026-10-03 §5.4）═══
describe('stream.store：写拦截子串扫描防复活', () => {
  it('源码不含任何写拦截提示子串扫描（事件驱动后旧链不得回归）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // jsdom 环境 import.meta.url 非 file 协议——用 cwd（renderer 根）拼贴源路径
    const src = fs.readFileSync(path.join(process.cwd(), 'src/stores/stream.store.ts'), 'utf-8');
    expect(src).not.toContain('非工作空间路径写入被沙箱拦截');
    expect(src).not.toContain('工作空间外路径写入被沙箱拦截');
    expect(src).not.toContain('toolchainWriteBlockedSeen');
  });
});

// === expandThinking：thinking wire 截断的全量展开归并（2026-10-14 P0-2）===
// 契约：截断版 wire（预览 + marker）hydrate 后，expandThinking 用全量 runs
// （seq 与截断版同源）按 seq 剔除替换重聚合——截断标志消失、thinking 全文在场、
// 交错顺序保真、startedAt 不因展开游程缺 createdAt 而回退。
describe('stream.store：expandThinking（P0-2 wire 截断展开）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  /** 构造一段截断形态的 wire events：预览 thinking + text + final + marker */
  function wireEvents(): MessageEventRow[] {
    return [
      mkEvent('m-trunc', 0, 'thinking_delta', { delta: '预'.repeat(2000) }),
      mkEvent('m-trunc', 1, 'text_delta', { delta: '正文' }),
      mkEvent('m-trunc', 2, 'final', { status: 'done' }),
      mkEvent('m-trunc', 1_000_000_000, 'thinking_truncated', { fullChars: 8000 }),
    ];
  }

  it('hydrate 截断版 → thinkingTruncated 置位；expandThinking 后全文在场 + 标志清除', () => {
    useStreamStore.getState().hydrateFromEvents('m-trunc', wireEvents());
    const before = useStreamStore.getState().streams.get('m-trunc')!;
    expect(before.thinkingTruncated).toBe(true);
    expect(before.thinking).toHaveLength(2000);
    const startedAtBefore = before.startedAt;

    const full = '全'.repeat(8000);
    useStreamStore.getState().expandThinking('m-trunc', [{ seq: 0, delta: full }]);

    const after = useStreamStore.getState().streams.get('m-trunc')!;
    expect(after.thinkingTruncated).toBeUndefined();
    expect(after.thinking).toBe(full);
    expect(after.text).toBe('正文');
    expect(after.status).toBe('done');
    // startedAt 用截断版保留的 createdAt 映射，不回退
    expect(after.startedAt).toBe(startedAtBefore);
  });

  it('多游程交错序保真：thinking(seq0) → tool(seq1) → thinking(seq2) 展开后 segments 顺序不变', () => {
    useStreamStore.getState().hydrateFromEvents('m-mix', [
      mkEvent('m-mix', 0, 'thinking_delta', { delta: '第一段预览' }),
      mkEvent('m-mix', 1, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
      mkEvent('m-mix', 2, 'thinking_delta', { delta: '第二段预览' }),
      mkEvent('m-mix', 3, 'text_delta', { delta: '正文' }),
      mkEvent('m-mix', 4, 'final', { status: 'done' }),
      mkEvent('m-mix', 1_000_000_000, 'thinking_truncated', { fullChars: 8 }),
    ]);
    useStreamStore.getState().expandThinking('m-mix', [
      { seq: 0, delta: '第一段全文' },
      { seq: 2, delta: '第二段全文' },
    ]);
    const after = useStreamStore.getState().streams.get('m-mix')!;
    expect(after.segments.map((s) => s.kind)).toEqual(['thinking', 'tool_call', 'thinking', 'text']);
    expect(after.segments[0]).toEqual({ kind: 'thinking', text: '第一段全文' });
    expect(after.segments[2]).toEqual({ kind: 'thinking', text: '第二段全文' });
    // marker 从 segments/timeline 语义中不残留副作用
    expect(after.thinkingTruncated).toBeUndefined();
  });

  it('零 text_delta 终态消息：fallbackBody 回退在展开后仍生效（防静态正文被洗掉）', () => {
    useStreamStore.getState().hydrateFromEvents(
      'm-fb',
      [
        mkEvent('m-fb', 0, 'thinking_delta', { delta: '预览' }),
        mkEvent('m-fb', 1, 'final', { status: 'done' }),
        mkEvent('m-fb', 1_000_000_000, 'thinking_truncated', { fullChars: 4000 }),
      ],
      '正文真相源',
    );
    expect(useStreamStore.getState().streams.get('m-fb')?.text).toBe('正文真相源');
    useStreamStore.getState().expandThinking('m-fb', [{ seq: 0, delta: '全'.repeat(4000) }], '正文真相源');
    const after = useStreamStore.getState().streams.get('m-fb')!;
    expect(after.text).toBe('正文真相源');
    expect(after.segments.at(-1)).toEqual({ kind: 'text', text: '正文真相源' });
  });

  it('未知 messageId 或空 runs → no-op（错误路径）', () => {
    useStreamStore.getState().hydrateFromEvents('m-trunc', wireEvents());
    const before = useStreamStore.getState().streams.get('m-trunc')!;
    useStreamStore.getState().expandThinking('m-not-exist', [{ seq: 0, delta: 'x' }]);
    useStreamStore.getState().expandThinking('m-trunc', []);
    const after = useStreamStore.getState().streams.get('m-trunc')!;
    expect(after.thinking).toBe(before.thinking);
    expect(after.thinkingTruncated).toBe(true);
  });
});

// === expandToolResults：tool 结果 wire 截断的全量展开（第二刀）===
describe('stream.store：expandToolResults（wire 截断展开）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  function hydrateTruncated(): void {
    useStreamStore.getState().hydrateFromEvents('m-tools', [
      mkEvent('m-tools', 0, 'tool_call_start', { callId: 'ca', toolName: 'bash', args: {} }),
      mkEvent('m-tools', 1, 'tool_call_result', { callId: 'ca', result: '预'.repeat(800), success: true, truncated: true, fullLength: 5000 }),
      mkEvent('m-tools', 2, 'text_delta', { delta: '正文' }),
      mkEvent('m-tools', 3, 'final', { status: 'done' }),
    ]);
  }

  it('hydrate 截断版 → 标志置位；expand 后全量在场 + 标志消失 + success 保留', () => {
    hydrateTruncated();
    const before = useStreamStore.getState().streams.get('m-tools')!;
    expect(before.toolCalls[0]!.resultTruncated).toBe(true);

    useStreamStore.getState().expandToolResults('m-tools', [
      { seq: 1, callId: 'ca', result: 'A'.repeat(5000) },
    ]);
    const after = useStreamStore.getState().streams.get('m-tools')!;
    expect(after.toolCalls[0]!.result).toHaveLength(5000);
    expect(after.toolCalls[0]!.resultTruncated).toBeUndefined();
    expect(after.toolCalls[0]!.success).toBe(true);
    expect(after.text).toBe('正文');
  });

  it('零 text_delta 终态消息：正文回退从上次聚合继承（防洗白）', () => {
    // 先造带回退的终态流（hydrate fallbackBody 路径）+ 截断工具结果
    useStreamStore.getState().hydrateFromEvents(
      'm-fb2',
      [
        mkEvent('m-fb2', 0, 'tool_call_start', { callId: 'c', toolName: 'bash', args: {} }),
        mkEvent('m-fb2', 1, 'tool_call_result', { callId: 'c', result: 'x'.repeat(900), success: true, truncated: true, fullLength: 900 }),
        mkEvent('m-fb2', 2, 'final', { status: 'done' }),
      ],
      '正文真相源',
    );
    expect(useStreamStore.getState().streams.get('m-fb2')?.text).toBe('正文真相源');
    useStreamStore.getState().expandToolResults('m-fb2', [{ seq: 1, callId: 'c', result: 'full'.repeat(300) }]);
    const after = useStreamStore.getState().streams.get('m-fb2')!;
    expect(after.text).toBe('正文真相源');
    expect(after.segments.at(-1)).toEqual({ kind: 'text', text: '正文真相源' });
  });

  it('未知 messageId / 空 results → no-op；未触及的其它事件保持原引用语义', () => {
    hydrateTruncated();
    useStreamStore.getState().expandToolResults('m-none', [{ seq: 1, callId: 'z', result: 'r' }]);
    useStreamStore.getState().expandToolResults('m-tools', []);
    const s = useStreamStore.getState().streams.get('m-tools')!;
    expect(s.toolCalls[0]!.resultTruncated).toBe(true);
  });
});
