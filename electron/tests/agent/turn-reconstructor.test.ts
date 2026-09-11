// electron/tests/agent/turn-reconstructor.test.ts
//
// turn-reconstructor 回归矩阵（v2.6.0 Task 1 · 断点续跑核心纯函数）。
//
// fixture 保真度（momo-test-rules / v2.5 C1 教训）：
//   - 真实 db（global-defaults 模式：tmp 目录 + AP_USER_DATA_DIR + runMigrations）
//   - 事件行尽量经真实生产落库链写入：__routeChunkToBufferForTest（stream-relay 的
//     chunk → MessageEventBuffer → message_events 路径），锁 chunk→event 落库形态
//   - 生产链尚无法产出的事件（steer 是 T2 才接线 / 未知 kind / 非法 JSON）用
//     手插行，列形状照抄 events-repo.insertEvent 的 SQL（id uuid / seq / event_type /
//     payload_json / created_at）
//   - 回合起始 user 消息行照抄 session-service.sendUserMessage 的 insertMessage
//     字段（sender='owner' / eventType='m.room.message' / body=正文）
//
// 九场景矩阵 + seq 乱序（plan Task 1 Step 1 全清单）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 stream-relay.test.ts 模式；turn-reconstructor 本身不依赖 electron）。
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEvent, nextSeqForMessage } from '../../src/main/storage/messages/events-repo';
import * as eventsRepo from '../../src/main/storage/messages/events-repo';
import {
  rebuildTurn,
  INTERRUPTED_TOOL_RESULT,
} from '../../src/main/agent/turn-reconstructor';

// === DB 测试夹具（global-defaults 模式） ===

const tmpRoot = path.join(os.tmpdir(), `ap-turn-rebuild-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetEventBufferForTest();
});

afterEach(() => {
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// === fixture 辅助：生产形状的消息行 / 事件行 ===

/** 会话内执行房间 id（值语义与 messages.session_id 一致） */
const SESSION_ID = 'sess-exec-1';
/** agent 本地身份（生产值形态：config.agentUserId，如 'agent-coder-a1b2c3'） */
const AGENT_SENDER = 'agent-coder-a1b2c3';

/**
 * 插入回合起始 user 消息行——字段照抄 session-service.sendUserMessage 的
 * insertMessage 调用（sender='owner' / eventType='m.room.message' / status 默认 done）。
 */
function insertOwnerMessage(sessionId: string, body: string): void {
  insertMessage({ sessionId, sender: 'owner', eventType: 'm.room.message', body });
}

/** 经真实生产链（routeChunkToBuffer）发 start chunk：INSERT 流行 + status_change 事件 */
function startStream(streamSessionId: string): void {
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId,
    sessionId: SESSION_ID,
    senderAgentId: AGENT_SENDER,
  });
}

/** 取流行 id（start 落库后的 messages 行）——手插事件需要 message_id 关联 */
function streamMessageId(streamSessionId: string): string {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
    .get(streamSessionId) as { id: string } | undefined;
  if (!row) throw new Error(`fixture：流行不存在 ${streamSessionId}`);
  return row.id;
}

/**
 * 手插事件行——列形状照抄 events-repo.insertEvent 的 SQL（生产落库列结构）。
 * 用于生产链尚不产出的事件类型（steer 是 T2 接线 / 未知 kind / 非法 JSON）。
 */
function insertRawEvent(
  messageId: string,
  eventType: string,
  payloadJson: string,
  seq?: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), messageId, seq ?? nextSeqForMessage(messageId), eventType, payloadJson, Date.now());
}

// === 九场景矩阵 ===

describe('turn-reconstructor：九场景矩阵', () => {
  it('1. 完整回合：user 起始 + assistant 文本 + 1 对 tool_call/tool_result + 后续文本', () => {
    insertOwnerMessage(SESSION_ID, '帮我实现登录页');
    startStream('ss-full-1');
    const mid = streamMessageId('ss-full-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-full-1', delta: '正在分析需求' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-full-1',
      callId: 'c1',
      toolName: 'read_file',
      args: { path: 'src/login.ts' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-full-1',
      callId: 'c1',
      toolName: 'read_file',
      result: '文件内容：export function LoginPage()',
      success: true,
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-full-1', delta: '已完成' });
    __flushEventBufferForTest();
    insertOwnerMessage(SESSION_ID, '不该被误取的后续消息'); // 流行之后的 owner 行不得污染起始消息
    void mid;

    const turn = rebuildTurn('ss-full-1');

    // 对齐 runChatLoop 自身组装形状（runtime-entry:841 单条 assistant 携带全轮 toolCalls，
    // tool 消息按 call 顺序逐条紧随）
    expect(turn.messages).toEqual([
      { role: 'user', content: '帮我实现登录页' },
      {
        role: 'assistant',
        content: '正在分析需求',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/login.ts' } }],
      },
      { role: 'tool', content: '文件内容：export function LoginPage()', toolCallId: 'c1' },
      { role: 'assistant', content: '已完成' },
    ]);
    expect(turn.toolCallsUsed).toBe(1);
    expect(turn.steers).toEqual([]);
    expect(turn.degenerate).toBe(false);
  });

  it('2. 孤儿 tool_call（有 call 无 result，dispatch 形态 toolName 前缀）→ tool 消息 = 合成中断文案', () => {
    insertOwnerMessage(SESSION_ID, '派个帮手去写登录页');
    startStream('ss-orphan-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-orphan-1', delta: '开始委派' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-orphan-1',
      callId: 'd1',
      toolName: 'dispatch:coder',
      args: { task: '写登录页' },
      isDispatch: true,
      subStreamSessionId: 'sub-ss-orphan-1',
      subAgentName: 'Coder',
    });
    __flushEventBufferForTest();

    const turn = rebuildTurn('ss-orphan-1');

    expect(turn.messages).toEqual([
      { role: 'user', content: '派个帮手去写登录页' },
      {
        role: 'assistant',
        content: '开始委派',
        toolCalls: [{ id: 'd1', name: 'dispatch:coder', arguments: { task: '写登录页' } }],
      },
      { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'd1' },
    ]);
    expect(turn.toolCallsUsed).toBe(1); // 已发出的 tool_call 即计入预算消耗
    expect(turn.degenerate).toBe(false);
  });

  it('3. 半截 assistant 文本（text_delta 无 end）→ 收尾为完整 assistant 消息', () => {
    insertOwnerMessage(SESSION_ID, '写个说明文档');
    startStream('ss-halftext-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-halftext-1', delta: '登录页已' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-halftext-1', delta: '完成' });
    __flushEventBufferForTest();

    const turn = rebuildTurn('ss-halftext-1');

    expect(turn.messages).toEqual([
      { role: 'user', content: '写个说明文档' },
      { role: 'assistant', content: '登录页已完成' },
    ]);
    expect(turn.degenerate).toBe(false);
  });

  it('4. degenerate：仅 start + user，无任何 assistant 输出事件 → messages 仅 [user]', () => {
    insertOwnerMessage(SESSION_ID, '开始分析');
    startStream('ss-degen-1');
    __flushEventBufferForTest(); // start 的 status_change 已落盘

    const turn = rebuildTurn('ss-degen-1');

    expect(turn.messages).toEqual([{ role: 'user', content: '开始分析' }]);
    expect(turn.degenerate).toBe(true);
    expect(turn.toolCallsUsed).toBe(0);
    expect(turn.steers).toEqual([]);
  });

  it('5. assigned 无事件：查无流行 → 纯重派降级（messages=[]）', () => {
    const turn = rebuildTurn('ss-never-started');

    expect(turn.messages).toEqual([]);
    expect(turn.toolCallsUsed).toBe(0);
    expect(turn.steers).toEqual([]);
    expect(turn.degenerate).toBe(true);
  });

  it('6. steer 已 drain（steer 事件后有输出）→ 随 [用户中途补充] user 消息按位重建', () => {
    insertOwnerMessage(SESSION_ID, '重构登录模块');
    startStream('ss-steer-drained');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-steer-drained', delta: '开始' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-steer-drained',
      callId: 'c1',
      toolName: 'grep',
      args: { pattern: 'LoginPage' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-steer-drained',
      callId: 'c1',
      toolName: 'grep',
      result: '3 处命中',
      success: true,
    });
    __flushEventBufferForTest();
    // steer 事件行（T2 才接生产落库链，此处手插锁语义；形态对齐 T2 计划的
    // { type:'steer' } chunk → eventType 'steer' / payload { body }）
    insertRawEvent(streamMessageId('ss-steer-drained'), 'steer', JSON.stringify({ body: '优先处理样式问题' }));
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-steer-drained', delta: '收到，先处理样式' });
    __flushEventBufferForTest();

    const turn = rebuildTurn('ss-steer-drained');

    expect(turn.messages).toEqual([
      { role: 'user', content: '重构登录模块' },
      {
        role: 'assistant',
        content: '开始',
        toolCalls: [{ id: 'c1', name: 'grep', arguments: { pattern: 'LoginPage' } }],
      },
      { role: 'tool', content: '3 处命中', toolCallId: 'c1' },
      // 对齐 runtime-entry drain 形态（:706）：[用户中途补充] 前缀的 user 消息
      { role: 'user', content: '[用户中途补充] 优先处理样式问题' },
      { role: 'assistant', content: '收到，先处理样式' },
    ]);
    expect(turn.steers).toEqual([]);
    expect(turn.degenerate).toBe(false);
  });

  it('7. steer 未 drain（steer 事件在末尾之后无输出）→ 进 steers[] 数组', () => {
    insertOwnerMessage(SESSION_ID, '继续优化');
    startStream('ss-steer-pending');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-steer-pending', delta: '工作中' });
    __flushEventBufferForTest();
    insertRawEvent(streamMessageId('ss-steer-pending'), 'steer', JSON.stringify({ body: '记得补测试' }));

    const turn = rebuildTurn('ss-steer-pending');

    // steer 未消费：不重建 user 消息，进 steers[]（T4 随载荷重放进 pendingSteers）
    expect(turn.messages).toEqual([
      { role: 'user', content: '继续优化' },
      { role: 'assistant', content: '工作中' },
    ]);
    expect(turn.steers).toEqual(['记得补测试']);
    expect(turn.degenerate).toBe(false);
  });

  it('8. 未知事件类型（future_thing）→ 跳过不炸，其余事件正常聚合', () => {
    insertOwnerMessage(SESSION_ID, '分析一下');
    startStream('ss-unknown-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-unknown-1', delta: 'A' });
    __flushEventBufferForTest();
    insertRawEvent(streamMessageId('ss-unknown-1'), 'future_thing', JSON.stringify({ whatever: 1 }));
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-unknown-1', delta: 'B' });
    __flushEventBufferForTest();

    const turn = rebuildTurn('ss-unknown-1');

    expect(turn.messages).toEqual([
      { role: 'user', content: '分析一下' },
      { role: 'assistant', content: 'AB' },
    ]);
    expect(turn.degenerate).toBe(false);
  });

  it('9a. 重建抛错（payload 非法 JSON → repo JSON.parse 抛）→ 降级 degenerate 全空', () => {
    insertOwnerMessage(SESSION_ID, '会崩的流');
    startStream('ss-broken-1');
    __flushEventBufferForTest();
    insertRawEvent(streamMessageId('ss-broken-1'), 'text_delta', '{这不是合法JSON');

    const turn = rebuildTurn('ss-broken-1');

    expect(turn).toEqual({ messages: [], toolCallsUsed: 0, steers: [], degenerate: true });
  });

  it('9b. 重建抛错（repo 查询异常 monkeypatch）→ 降级 degenerate 全空', () => {
    insertOwnerMessage(SESSION_ID, '查询会炸');
    startStream('ss-broken-2');
    __flushEventBufferForTest();

    const spy = vi
      .spyOn(eventsRepo, 'listEventsByMessage')
      .mockImplementation(() => {
        throw new Error('repo 炸了');
      });
    try {
      const turn = rebuildTurn('ss-broken-2');
      expect(turn).toEqual({ messages: [], toolCallsUsed: 0, steers: [], degenerate: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('附. seq 乱序插入（先插 seq 大再插小）→ 按 seq 排序聚合', () => {
    insertOwnerMessage(SESSION_ID, '乱序流');
    startStream('ss-unsorted-1');
    __flushEventBufferForTest(); // status_change 占 seq=0
    const mid = streamMessageId('ss-unsorted-1');
    // 插入顺序刻意乱序：seq=5 → seq=1 → seq=3；聚合必须按 seq 得 'Hello World'
    insertRawEvent(mid, 'text_delta', JSON.stringify({ delta: 'World' }), 5);
    insertRawEvent(mid, 'text_delta', JSON.stringify({ delta: 'Hello' }), 1);
    insertRawEvent(mid, 'text_delta', JSON.stringify({ delta: ' ' }), 3);

    const turn = rebuildTurn('ss-unsorted-1');

    expect(turn.messages).toEqual([
      { role: 'user', content: '乱序流' },
      { role: 'assistant', content: 'Hello World' },
    ]);
  });
});
