// electron/tests/agent/sub-history-reconstructor.test.ts
//
// sub-history-reconstructor 回归矩阵（v2.8.0 Orchestration 元语 Task 1 ·
// dispatch_followup 的链历史前缀源）。
//
// fixture 保真度（momo-test-rules）：
//   - 真实 db（global-defaults 模式：tmp 目录 + AP_USER_DATA_DIR + runMigrations）
//   - agent 流消息行 + 事件尽量经真实生产落库链写入（__routeChunkToBufferForTest：
//     chunk → MessageEventBuffer → message_events），锁 chunk→event 落库形态
//   - 链行写入契约（本测试是消费侧锁，生产者 T5 dispatch_followup 必须满足）：
//     链内全部消息行（agent 流行 + followup user 行）都带 (task_id, session_id =
//     executionSessionId) 双键。当前生产链 start chunk 不落 task_id（stream-relay
//     无该字段），fixture 在生产链写入后 UPDATE 打标；手插行则直接带 taskId。
//   - followup user 行照抄 session-service.sendUserMessage 的 insertMessage 形状
//     （sender='owner' / eventType='m.room.message'）+ taskId
//
// 场景矩阵（plan Task 1 Step 1 五场景 + 两条附加锁）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 turn-reconstructor.test.ts 模式；sub-history-reconstructor 本身不依赖 electron）。
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
import { nextSeqForMessage } from '../../src/main/storage/messages/events-repo';
import * as eventsRepo from '../../src/main/storage/messages/events-repo';
import {
  rebuildSubConversation,
} from '../../src/main/agent/sub-history-reconstructor';
import { INTERRUPTED_TOOL_RESULT } from '../../src/main/agent/turn-reconstructor';

// === DB 测试夹具（global-defaults 模式） ===

const tmpRoot = path.join(os.tmpdir(), `ap-sub-rebuild-${Date.now()}`);

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

/** 链的执行会话 id（值语义与 messages.session_id 一致） */
const EXEC_SESSION = 'sess-exec-1';
/** 子 agent 本地身份（生产值形态：config.agentUserId，如 'agent-coder-a1b2c3'） */
const SUB_AGENT_SENDER = 'agent-coder-a1b2c3';

/**
 * followup user 消息行——字段照抄 session-service.sendUserMessage 的
 * insertMessage 调用（sender='owner' / eventType='m.room.message'）+ 链契约
 * 的 taskId（T5 生产者侧写入；当前生产路径不带 task_id）。
 */
function insertFollowupUser(sessionId: string, taskId: string, body: string): void {
  insertMessage({ sessionId, sender: 'owner', eventType: 'm.room.message', body, taskId });
}

/** 经真实生产链（routeChunkToBuffer）发 start chunk：INSERT 流行 + status_change 事件 */
function startStream(streamSessionId: string): void {
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId,
    sessionId: EXEC_SESSION,
    senderAgentId: SUB_AGENT_SENDER,
  });
}

/** 给流族行打链标（写入契约：链行带 task_id；生产者 T5 落地前的 fixture 模拟） */
function tagStreamRow(streamSessionId: string, taskId: string): void {
  getDb()
    .prepare('UPDATE messages SET task_id = ? WHERE stream_session_id = ?')
    .run(taskId, streamSessionId);
}

/**
 * 手插事件行——列形状照抄 events-repo.insertEvent 的 SQL（生产落库列结构）。
 * 用于生产链尚不产出的事件类型（非法 JSON 等）与手插 roll 续行。
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

// === 场景矩阵 ===

describe('sub-history-reconstructor：链重建场景矩阵', () => {
  it('1. 两轮链 verbatim：首轮 assistant 开头（无合成 user）+ followup user + 第二轮，rounds=1', () => {
    const taskId = 'T-chain-two-rounds';
    // 首轮：dispatch 指令不落消息行（transient 桥）——链直接以 assistant 流行开头
    startStream('ss-sub-r1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-r1', delta: '分析中' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-sub-r1',
      callId: 'c1',
      toolName: 'read_file',
      args: { path: 'src/login.ts' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-sub-r1',
      callId: 'c1',
      toolName: 'read_file',
      result: '文件内容：export function LoginPage()',
      success: true,
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-r1', delta: '结论完成' });
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-r1', taskId);

    // 第二轮：followup user 消息（追问文本）+ 子 agent 新流回复
    insertFollowupUser(EXEC_SESSION, taskId, '把结论展开成表格');
    startStream('ss-sub-r2');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-r2', delta: '好的，展开如下' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-sub-r2',
      callId: 'c2',
      toolName: 'grep',
      args: { pattern: 'LoginPage' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-sub-r2',
      callId: 'c2',
      toolName: 'grep',
      result: '3 处命中',
      success: true,
    });
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-r2', taskId);

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    // 首轮指令不回溯：messages[0] 恒为 assistant（不造合成 user 消息）
    expect(sub.messages[0]?.role).toBe('assistant');
    expect(sub.messages).toEqual([
      {
        role: 'assistant',
        content: '分析中',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/login.ts' } }],
      },
      { role: 'tool', content: '文件内容：export function LoginPage()', toolCallId: 'c1' },
      { role: 'assistant', content: '结论完成' },
      { role: 'user', content: '把结论展开成表格' },
      {
        role: 'assistant',
        content: '好的，展开如下',
        toolCalls: [{ id: 'c2', name: 'grep', arguments: { pattern: 'LoginPage' } }],
      },
      { role: 'tool', content: '3 处命中', toolCallId: 'c2' },
    ]);
    // rounds = 链内 user 角色消息数（= followup 追问次数；首轮 dispatch 无 user 不计）
    expect(sub.rounds).toBe(1);
    expect(sub.degraded).toBe(false);
  });

  it('2. 孤儿 tool_call（中断轮，有 call 无 result）→ 合成 [执行中断] tool result', () => {
    const taskId = 'T-chain-orphan';
    startStream('ss-sub-orphan');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-orphan', delta: '开始检索' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-sub-orphan',
      callId: 'd1',
      toolName: 'grep',
      args: { pattern: 'TODO' },
    });
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-orphan', taskId);

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    expect(sub.messages).toEqual([
      {
        role: 'assistant',
        content: '开始检索',
        toolCalls: [{ id: 'd1', name: 'grep', arguments: { pattern: 'TODO' } }],
      },
      // 与 rebuildTurn 同语义：未配对的 call 合成中断文案（常量 import 共享）
      { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'd1' },
    ]);
    expect(sub.rounds).toBe(0);
    expect(sub.degraded).toBe(false);
  });

  it('3. 会话过滤：task_id 相同但 session 不同 / session 相同但 task_id 不同的伪造行不进重建', () => {
    const taskId = 'T-chain-filter';
    // 噪声 1：同 task_id、不同 session（他链会话的伪造行）
    startStream('ss-noise-other-session');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-noise-other-session', delta: '不该出现-他链会话' });
    __flushEventBufferForTest();
    tagStreamRow('ss-noise-other-session', taskId);
    getDb()
      .prepare('UPDATE messages SET session_id = ? WHERE stream_session_id = ?')
      .run('sess-other', 'ss-noise-other-session');
    // 噪声 2：同 task_id、不同 session 的伪造 followup user 行
    insertFollowupUser('sess-other', taskId, '不该出现-伪 followup');
    // 噪声 3：同 session、不同 task_id（同会话他链任务）
    startStream('ss-noise-other-task');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-noise-other-task', delta: '不该出现-他链任务' });
    __flushEventBufferForTest();
    tagStreamRow('ss-noise-other-task', 'T-other-task');
    // 目标链行
    startStream('ss-target');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-target', delta: '目标链内容' });
    __flushEventBufferForTest();
    tagStreamRow('ss-target', taskId);

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    expect(sub.messages).toEqual([{ role: 'assistant', content: '目标链内容' }]);
    expect(sub.rounds).toBe(0);
    expect(sub.degraded).toBe(false);
  });

  it('4. 空链（无任何消息行）→ {messages:[], rounds:0, degraded:true}', () => {
    const sub = rebuildSubConversation('T-chain-empty', EXEC_SESSION);

    expect(sub).toEqual({ messages: [], rounds: 0, degraded: true });
  });

  it('5. 重建抛错（monkeypatch 查询函数 throw）→ degraded 兜底不抛', () => {
    const taskId = 'T-chain-throw';
    startStream('ss-sub-throw');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-throw', delta: '会崩的链' });
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-throw', taskId);

    const spy = vi
      .spyOn(eventsRepo, 'listEventsByMessage')
      .mockImplementation(() => {
        throw new Error('repo 炸了');
      });
    try {
      const sub = rebuildSubConversation(taskId, EXEC_SESSION);
      expect(sub).toEqual({ messages: [], rounds: 0, degraded: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('6.（附加锁）重建抛错（事件 payload 非法 JSON → repo JSON.parse 抛）→ degraded 兜底', () => {
    const taskId = 'T-chain-badjson';
    startStream('ss-sub-badjson');
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-badjson', taskId);
    const row = getDb()
      .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
      .get('ss-sub-badjson') as { id: string };
    insertRawEvent(row.id, 'text_delta', '{这不是合法JSON');

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    expect(sub).toEqual({ messages: [], rounds: 0, degraded: true });
  });

  it('7.（附加锁）连续 agent 行（#roll 续行）合并为单条 assistant——跨行拼接同构 turn-reconstructor', () => {
    const taskId = 'T-chain-roll';
    // base 行：生产链写 'Hello'
    startStream('ss-sub-roll');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-roll', delta: 'Hello' });
    __flushEventBufferForTest();
    tagStreamRow('ss-sub-roll', taskId);
    // roll 续行：手插同族流行（stream_session_id = base#roll1，形状照抄
    // stream-relay message_roll 的 insertMessage）+ 手插续写事件 'World'
    const rollMsg = insertMessage({
      sessionId: EXEC_SESSION,
      sender: SUB_AGENT_SENDER,
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-sub-roll#roll1',
      status: 'streaming',
      taskId,
    });
    insertRawEvent(rollMsg.id, 'text_delta', JSON.stringify({ delta: ' World' }));

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    // 两行是同一条流的延续：合并为单条完整 assistant 消息，不拆成两条
    expect(sub.messages).toEqual([{ role: 'assistant', content: 'Hello World' }]);
    expect(sub.rounds).toBe(0);
    expect(sub.degraded).toBe(false);
  });
});
