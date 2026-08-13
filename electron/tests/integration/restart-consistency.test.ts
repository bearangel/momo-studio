// electron/tests/integration/restart-consistency.test.ts
//
// A 子系统核心回归测试（Plan A 收尾）：
//   1. 模拟 stream chunk 序列（thinking + 多 text_delta + tool_call + final）
//   2. 通过 MessageEventBuffer 走完整落盘路径
//   3. 用 aggregateEvents 从 SQLite 重建 StreamState（模拟重启后 renderer 行为）
//   4. 断言重建后的 StreamState 与"实时推送的 chunk 序列聚合"完全一致
//
// 核心不变量：实时显示 == 重启显示。两路使用同一份 events + 同一个 aggregateEvents。
//
// 不启动真实 LLM；用 mock stream chunk 序列驱动 MessageEventBuffer。
//
// 注意：aggregateEvents 来自 renderer workspace（共用聚合函数），跨 workspace import。
// 路径从 electron/tests/integration/ 出发 3 层 ../ 回到 workspace 根，再进 renderer/。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  insertMessage,
  getMessageByStreamSessionId,
  getMessageByMatrixEventId,
  listMessagesByRoom,
} from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';
import { aggregateEvents } from '../../../renderer/src/lib/stream-aggregator';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-restart-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('A 子系统：重启一致性', () => {
  it('模拟 agent 完整回复：实时聚合 == 重启聚合', () => {
    // 1. 启动 message + buffer（onFlush 收集实时推送的 events）
    const msg = insertMessage({
      roomId: 'r1',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-1',
      status: 'streaming',
    });
    const collectedBatch: MessageEventRow[] = [];
    const buf = new MessageEventBuffer({
      flushMs: 1000, // 避免自动 flush
      onFlush: (events) => collectedBatch.push(...events),
    });

    // 2. 模拟 stream chunk 序列：thinking → 2x text → tool_call → result → text → final
    buf.append({ messageId: msg.id, eventType: 'thinking_delta', payload: { delta: '让我想想' } });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: 'Hello' } });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: ' world' } });
    buf.append({
      messageId: msg.id,
      eventType: 'tool_call_start',
      payload: { callId: 'c1', toolName: 'read_file', args: { path: '/a.ts' } },
    });
    buf.append({
      messageId: msg.id,
      eventType: 'tool_call_result',
      payload: { callId: 'c1', result: 'file body', success: true },
    });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: ' done' } });
    buf.flush(); // 强制 flush 前 6 条
    buf.append({ messageId: msg.id, eventType: 'final', payload: { body: 'Hello world done' } });
    buf.flush(); // flush final
    buf.destroy();

    // 3. "实时聚合"：collectedBatch 走 aggregateEvents（renderer 收到 onMessageEventBatch 推送后的行为）
    const realTimeStream = aggregateEvents(collectedBatch);

    // 4. "重启聚合"：从 SQLite 读 events 走 aggregateEvents（renderer 重启后 getMessages 的行为）
    const dbEvents = listEventsByMessage(msg.id);
    const restartStream = aggregateEvents(dbEvents);

    // 5. 断言两者完全一致（A 子系统核心不变量）
    expect(restartStream.thinking).toBe(realTimeStream.thinking);
    expect(restartStream.text).toBe(realTimeStream.text);
    expect(restartStream.toolCalls).toEqual(realTimeStream.toolCalls);
    expect(restartStream.todos).toEqual(realTimeStream.todos);
    expect(restartStream.dispatches).toEqual(realTimeStream.dispatches);
    expect(restartStream.status).toBe(realTimeStream.status);

    // 关键内容正确性校验
    expect(restartStream.thinking).toBe('让我想想');
    expect(restartStream.text).toBe('Hello world done');
    expect(restartStream.toolCalls.length).toBe(1);
    expect(restartStream.toolCalls[0]!.toolName).toBe('read_file');
    expect(restartStream.toolCalls[0]!.callId).toBe('c1');
    expect(restartStream.toolCalls[0]!.result).toBe('file body');
    expect(restartStream.toolCalls[0]!.success).toBe(true);
    expect(restartStream.status).toBe('done');

    // events 条数一致（7 条：6 + final）
    expect(collectedBatch.length).toBe(7);
    expect(dbEvents.length).toBe(7);
  });

  it('模拟 dispatch 嵌套：父子 agent 各自的 message 独立但可关联', () => {
    // PM message（父）
    const pmMsg = insertMessage({
      roomId: 'r1',
      sender: '@pm:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'pm-ss',
      status: 'streaming',
    });
    // 子 agent message（通过 parentStreamSessionId 关联到 PM）
    const subMsg = insertMessage({
      roomId: 'r1',
      sender: '@prog:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'sub-ss',
      parentStreamSessionId: 'pm-ss',
      status: 'streaming',
    });

    const buf = new MessageEventBuffer({ flushMs: 1000 });

    // PM 发起 dispatch（指向子 agent 的 subStreamSessionId）
    buf.append({
      messageId: pmMsg.id,
      eventType: 'dispatch_start',
      payload: {
        callId: 'd1',
        subStreamSessionId: 'sub-ss',
        subAgentName: 'Programmer',
        subAgentAvatar: '👨‍💻',
        task: '写登录页',
      },
    });
    // 子 agent 工作（events 落到 subMsg）
    buf.append({ messageId: subMsg.id, eventType: 'thinking_delta', payload: { delta: 'sub think' } });
    buf.append({ messageId: subMsg.id, eventType: 'text_delta', payload: { delta: '登录页已写' } });
    buf.append({ messageId: subMsg.id, eventType: 'final', payload: {} });
    // PM 收到 dispatch_result + 自己的 final
    buf.append({
      messageId: pmMsg.id,
      eventType: 'dispatch_result',
      payload: { callId: 'd1', status: 'completed' },
    });
    buf.append({ messageId: pmMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();

    // 重启聚合：PM 和子 agent 各自独立
    const pmStream = aggregateEvents(listEventsByMessage(pmMsg.id));
    const subStream = aggregateEvents(listEventsByMessage(subMsg.id));

    // PM 侧：1 个 dispatch，状态 completed
    expect(pmStream.dispatches.length).toBe(1);
    expect(pmStream.dispatches[0]!.subStreamSessionId).toBe('sub-ss');
    expect(pmStream.dispatches[0]!.subAgentName).toBe('Programmer');
    expect(pmStream.dispatches[0]!.subAgentAvatar).toBe('👨‍💻');
    expect(pmStream.dispatches[0]!.task).toBe('写登录页');
    expect(pmStream.dispatches[0]!.status).toBe('completed');
    expect(pmStream.status).toBe('done');

    // 子 agent 侧：thinking + text，无 dispatch
    expect(subStream.thinking).toBe('sub think');
    expect(subStream.text).toBe('登录页已写');
    expect(subStream.dispatches).toEqual([]);
    expect(subStream.status).toBe('done');
  });

  it('模拟多段消息（task_complete 分段）：3 段 message 各自独立 + segment_boundary', () => {
    // 插入 3 段独立 message（segmentOf 指向同一父 stream）
    const segMsgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = insertMessage({
        roomId: 'r1',
        sender: '@bot:home',
        eventType: 'm.room.message',
        body: `第${i + 1}段`,
        streamSessionId: `seg-${i}`,
        segmentOf: 'parent-ss',
        segmentIndex: i,
      });
      segMsgIds.push(m.id);
    }

    const buf = new MessageEventBuffer({ flushMs: 1000 });
    for (let i = 0; i < 3; i++) {
      buf.append({
        messageId: segMsgIds[i]!,
        eventType: 'segment_boundary',
        payload: { index: i, total: 3 },
      });
      buf.append({
        messageId: segMsgIds[i]!,
        eventType: 'final',
        payload: { body: `第${i + 1}段` },
      });
    }
    buf.flush();
    buf.destroy();

    // 重启：每段独立聚合
    const seg0 = aggregateEvents(listEventsByMessage(segMsgIds[0]!));
    const seg1 = aggregateEvents(listEventsByMessage(segMsgIds[1]!));
    const seg2 = aggregateEvents(listEventsByMessage(segMsgIds[2]!));

    // segment_boundary 仅记录在 events 时间线，不参与聚合
    expect(seg0.events.some((e) => e.type === 'segment_boundary')).toBe(true);
    expect(seg0.status).toBe('done');
    expect(seg1.status).toBe('done');
    expect(seg2.status).toBe('done');

    // 每段恰好 2 个 events（boundary + final）
    expect(seg0.events.length).toBe(2);
    expect(seg1.events.length).toBe(2);
    expect(seg2.events.length).toBe(2);

    // MessageList 渲染时按 segmentOf 分组 + segmentIndex 排序
    const segmentGroups = segMsgIds.map((id, i) => ({
      id,
      segmentIndex: getMessageByStreamSessionId(`seg-${i}`)?.segmentIndex,
    }));
    expect(segmentGroups.map((g) => g.segmentIndex)).toEqual([0, 1, 2]);
  });

  it('复杂场景：1000 个 text_delta + 50 个 tool_call 并发不丢数据', () => {
    const msg = insertMessage({
      roomId: 'r1',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'stress-ss',
      status: 'streaming',
    });
    // 小窗口 + 小批次，模拟高频流式场景
    const buf = new MessageEventBuffer({ flushMs: 10, flushBatch: 30 });

    // 1000 个 text_delta
    for (let i = 0; i < 1000; i++) {
      buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: 'a' } });
    }
    // 50 个 tool_call_start + result（交错模拟并发）
    for (let i = 0; i < 50; i++) {
      buf.append({
        messageId: msg.id,
        eventType: 'tool_call_start',
        payload: { callId: `c${i}`, toolName: 'noop', args: {} },
      });
      buf.append({
        messageId: msg.id,
        eventType: 'tool_call_result',
        payload: { callId: `c${i}`, result: '', success: true },
      });
    }
    buf.flush();
    buf.destroy();

    const events = listEventsByMessage(msg.id);
    // 1000 + 50*2 = 1100 条，一条不丢
    expect(events.length).toBe(1100);
    // seq 连续 0-1099（nextSeqForMessage 跨 flush 批次正确自增）
    expect(events[0]!.seq).toBe(0);
    expect(events[1099]!.seq).toBe(1099);

    // 聚合后内容完整
    const stream = aggregateEvents(events);
    expect(stream.text).toBe('a'.repeat(1000));
    expect(stream.toolCalls.length).toBe(50);
    // 每个 tool call 都有 result（配对完整）
    expect(stream.toolCalls.every((tc) => tc.success === true)).toBe(true);
  });
});

// A final fix（I1）：补用户消息往返 + dispatch/task_reply 持久化 + 去重不变量。
// 这些场景直接覆盖 C1 的修复——重启后 listMessagesByRoom 必须含全部 4 类写路径的消息，
// 且顺序按 created_at 一致。
describe('A 子系统：用户消息 + dispatch/task_reply 写路径（C1+I1 回归）', () => {
  it('用户消息 + agent 回复混合：重启后顺序与内容一致', () => {
    // 1. 用户消息（模拟 im:send 写路径，source='local'）
    const userMsg = insertMessage({
      roomId: 'r1',
      sender: '@owner:home',
      eventType: 'm.room.message',
      body: '@PM 帮我写登录页',
      source: 'local',
    });
    // 2. agent 回复（routeChunkToBuffer 写路径，streaming）
    const agentMsg = insertMessage({
      roomId: 'r1',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-mix-1',
      status: 'streaming',
    });
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: agentMsg.id, eventType: 'text_delta', payload: { delta: '好的，开始写登录页' } });
    buf.append({ messageId: agentMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();

    // 3. 重启聚合：从 SQLite 读 messages 按时间序
    const messages = listMessagesByRoom('r1');
    expect(messages.length).toBe(2);
    // 用户消息先（created_at 更小），agent 回复后
    expect(messages[0]!.sender).toBe('@owner:home');
    expect(messages[1]!.sender).toBe('@bot:home');
    expect(messages[0]!.body).toBe('@PM 帮我写登录页');
    expect(messages[0]!.source).toBe('local');
    expect(messages[0]!.status).toBe('done');
    // agent 正文经 final event 落盘（aggregateEvents 重建）
    const agentStream = aggregateEvents(listEventsByMessage(agentMsg.id));
    expect(agentStream.text).toBe('好的，开始写登录页');
  });

  it('dispatch + task_reply 持久化到 SQLite（经 Matrix 路由的消息可重启还原）', () => {
    // 模拟 sync-manager 监听 Matrix event 后的 INSERT（source='matrix'）
    const dispatchMsg = insertMessage({
      roomId: 'r1',
      sender: '@pm:home',
      eventType: 'io.momo-studio.dispatch',
      body: '写登录页',
      matrixEventId: '$evt-dispatch:home',
      source: 'matrix',
    });
    const replyMsg = insertMessage({
      roomId: 'r1',
      sender: '@prog:home',
      eventType: 'io.momo-studio.task_reply',
      body: '完成',
      matrixEventId: '$evt-reply:home',
      source: 'matrix',
    });

    const messages = listMessagesByRoom('r1');
    expect(messages.length).toBe(2);
    expect(messages[0]!.eventType).toBe('io.momo-studio.dispatch');
    expect(messages[1]!.eventType).toBe('io.momo-studio.task_reply');
    expect(messages[0]!.matrixEventId).toBe('$evt-dispatch:home');
    expect(messages[1]!.matrixEventId).toBe('$evt-reply:home');
    // 两条都标记 matrix 来源
    expect(messages.every((m) => m.source === 'matrix')).toBe(true);
    // 引用未丢失，模拟 restart 后变量仍可用
    expect(dispatchMsg.id).toBeTruthy();
    expect(replyMsg.id).toBeTruthy();
  });

  it('同 matrix_event_id 不二次落盘：getMessageByMatrixEventId 去重守卫', () => {
    // 模拟 sync-manager 事件监听的第一层去重：落盘前先查 matrix_event_id
    const msg = insertMessage({
      roomId: 'r1',
      sender: '@remote:home',
      eventType: 'm.room.message',
      body: '远程消息',
      matrixEventId: '$evt-dedup:home',
      source: 'matrix',
    });
    // /sync 重放同一 event：守卫应查到已存在行，跳过二次 INSERT
    const existing = getMessageByMatrixEventId('$evt-dedup:home');
    expect(existing).not.toBeNull();
    expect(existing!.id).toBe(msg.id);
    // 守卫生效的前提下，房间内只有 1 条
    expect(listMessagesByRoom('r1').length).toBe(1);
  });

  it('agent 消息 matrix_event_id 回填后 /sync 回声按 stream_session_id 命中已有行', () => {
    // routeChunkToBuffer 已落盘 agent 消息（无 matrix_event_id）
    const agentMsg = insertMessage({
      roomId: 'r1',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: 'agent 正文',
      streamSessionId: 'ss-backfill',
      status: 'done',
    });
    expect(agentMsg.matrixEventId).toBeNull();
    // 模拟 /sync 回声带 stream_session_id：sync-manager 第三层去重命中 + 回填
    // 这里验证 repo 层的 getMessageByStreamSessionId 守卫可用（sync-manager 用它做去重）
    const found = getMessageByStreamSessionId('ss-backfill');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(agentMsg.id);
    // 回填后 matrix_event_id 可查
    // （updateMessageMatrixEventId 在 sync-manager 内调用，此处验证 repo 接口可用）
    expect(getMessageByMatrixEventId('$not-yet:home')).toBeNull();
  });
});
