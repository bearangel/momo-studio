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
