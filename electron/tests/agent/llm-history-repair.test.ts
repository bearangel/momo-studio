// electron/tests/agent/llm-history-repair.test.ts
//
// 悬空 tool_call 修复门回归矩阵（2026-11-04 生产 HTTP-400 P0）。
//
// 背景：agent 任务中断后续跑（用户发「继续」/恢复卡），重建的 LLMMessage[]
// 若含「assistant 带 toolCalls 但紧随消息未覆盖每个 tool_call_id 的 tool
// 响应」，OpenAI 兼容供应商整请求 400 拒收（生产两次事故：a07252ba /
// cec28988）。修复 = 组装出口的配对修复门 repairDanglingToolCalls：
// 扫描每个 assistant.toolCalls，缺失响应的 callId 就地补合成 tool 消息
// （content='[运行中断，未取得结果]'，插在 assistant 与其后消息之间）。
//
// 两层测试（momo-test-rules）：
//   1. 纯函数单测——修复语义四场景 + 边界（空输入 / 无 toolCalls / 连续悬空）；
//   2. 集成测试——真实组装链（真实 db + 生产 chunk 落库链 + rebuildTurn /
//      rebuildSessionContext / rebuildSubConversation），锁「组装出口产物
//      恒满足配对不变量」的端到端契约：聚合器未来任何回归（或 DB 事件
//      残缺形态）引入悬空对，此测试第一时间红。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 turn-reconstructor.test.ts 模式；被测模块本身不依赖 electron）。
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
import {
  repairDanglingToolCalls,
  DANGLING_TOOL_RESULT_TEXT,
} from '../../src/main/agent/llm-history-repair';
import {
  rebuildTurn,
  rebuildSessionContext,
} from '../../src/main/agent/turn-reconstructor';
import { rebuildSubConversation } from '../../src/main/agent/sub-history-reconstructor';
import type { LLMMessage, LLMToolCall } from '../../src/main/agent/llm-provider';

// === DB 测试夹具（global-defaults 模式，同 turn-reconstructor.test.ts） ===

const tmpRoot = path.join(os.tmpdir(), `ap-llm-history-repair-${Date.now()}`);

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

// === 纯函数测试辅助 ===

function call(id: string, name = 'read_file'): LLMToolCall {
  return { id, name, arguments: { path: 'src/a.ts' } };
}

function assistant(toolCalls?: LLMToolCall[], content = ''): LLMMessage {
  return toolCalls === undefined
    ? { role: 'assistant', content }
    : { role: 'assistant', content, toolCalls };
}

function user(content: string): LLMMessage {
  return { role: 'user', content };
}

function toolMsg(toolCallId: string, content: string): LLMMessage {
  return { role: 'tool', content, toolCallId };
}

// === 集成测试辅助 ===

/** 会话内执行房间 id（值语义与 messages.session_id 一致） */
const SESSION_ID = 'sess-exec-1';
/** agent 本地身份（生产值形态：config.agentUserId） */
const AGENT_SENDER = 'agent-coder-a1b2c3';

/** 回合起始 user 消息行——字段照抄 session-service.sendUserMessage 的 insertMessage 调用 */
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

/**
 * 配对不变量断言（修复门保证的协议契约）：每个带 toolCalls 的 assistant，
 * 其后紧邻的连续 tool 消息必须覆盖每个 toolCallId——OpenAI 兼容供应商的
 * 整请求校验口径（"must be followed by tool messages responding to each
 * tool_call_id"）。
 */
function expectFullyPaired(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const tid = messages[j]!.toolCallId;
      if (tid !== undefined) answered.add(tid);
      j++;
    }
    for (const tc of m.toolCalls) {
      expect(
        answered.has(tc.id),
        `messages[${i}] 的 assistant.toolCalls 含 ${tc.id}，但其后紧邻 tool 消息未响应（HTTP-400 形态）`,
      ).toBe(true);
    }
  }
}

// ═══ 第一层：repairDanglingToolCalls 纯函数单测 ═══

describe('repairDanglingToolCalls：悬空 tool_call 修复纯函数', () => {
  it('a. 悬空配对：assistant 带 2 个 toolCalls 且无任何 tool 响应 → 紧随其后补 2 条合成 tool 消息', () => {
    const input: LLMMessage[] = [
      user('继续'),
      assistant([call('call_a'), call('call_b')], '我先读两个文件'),
      user('还有吗'),
    ];
    const out = repairDanglingToolCalls(input);
    // 长度 = 原 3 + 补 2
    expect(out).toHaveLength(5);
    // 顺序：assistant 之后、原 user('还有吗') 之前插入两条合成 tool 消息
    expect(out[1]).toEqual(assistant([call('call_a'), call('call_b')], '我先读两个文件'));
    expect(out[2]).toEqual({
      role: 'tool',
      content: DANGLING_TOOL_RESULT_TEXT,
      toolCallId: 'call_a',
    });
    expect(out[3]).toEqual({
      role: 'tool',
      content: DANGLING_TOOL_RESULT_TEXT,
      toolCallId: 'call_b',
    });
    expect(out[4]).toEqual(user('还有吗'));
    // 合成文案逐字节锁定（生产行为锚点）
    expect(DANGLING_TOOL_RESULT_TEXT).toBe('[运行中断，未取得结果]');
  });

  it('b. 部分配对：2 个 toolCalls 已有 1 个真实响应 → 仅补缺失的一个，已有响应不重复', () => {
    const input: LLMMessage[] = [
      assistant([call('call_a'), call('call_b')]),
      toolMsg('call_a', '真实结果'),
      user('下一步'),
    ];
    const out = repairDanglingToolCalls(input);
    expect(out).toHaveLength(4);
    // call_a 的真实响应原样保留且仅一条
    const aResults = out.filter((m) => m.role === 'tool' && m.toolCallId === 'call_a');
    expect(aResults).toHaveLength(1);
    expect(aResults[0]).toEqual(toolMsg('call_a', '真实结果'));
    // call_b 补一条合成响应
    const bResults = out.filter((m) => m.role === 'tool' && m.toolCallId === 'call_b');
    expect(bResults).toHaveLength(1);
    expect(bResults[0]).toEqual({
      role: 'tool',
      content: DANGLING_TOOL_RESULT_TEXT,
      toolCallId: 'call_b',
    });
    // 原有消息全部保留、顺序不变（除插入项外逐位相等）
    expect(out[0]).toEqual(input[0]);
    expect(out[out.length - 1]).toEqual(user('下一步'));
  });

  it('c. 完整配对：no-op——原数组原引用返回，逐字节不变', () => {
    const input: LLMMessage[] = [
      user('继续'),
      assistant([call('call_a'), call('call_b')]),
      toolMsg('call_a', '结果A'),
      toolMsg('call_b', '结果B'),
      user('很好'),
    ];
    const out = repairDanglingToolCalls(input);
    // 零修复路径返回原引用（不复制、不新建——真实 no-op）
    expect(out).toBe(input);
    expect(out).toEqual(input);
  });

  it('d. assistant(toolCalls) 后紧跟 user 消息 → 合成 tool 消息插入 assistant 与 user 之间', () => {
    const input: LLMMessage[] = [
      user('跑起来'),
      assistant([call('call_x')], '开始执行'),
      user('继续'),
    ];
    const out = repairDanglingToolCalls(input);
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual(assistant([call('call_x')], '开始执行'));
    expect(out[2]).toEqual({
      role: 'tool',
      content: DANGLING_TOOL_RESULT_TEXT,
      toolCallId: 'call_x',
    });
    expect(out[3]).toEqual(user('继续'));
  });

  it('e. 边界：空数组与无 toolCalls 历史原引用返回；连续两段悬空 assistant 全部修复', () => {
    // 空数组
    const empty: LLMMessage[] = [];
    expect(repairDanglingToolCalls(empty)).toBe(empty);
    // 纯文本历史（无 toolCalls）
    const plain = [user('你好'), assistant(undefined, '在的'), user('继续')];
    expect(repairDanglingToolCalls(plain)).toBe(plain);
    // 连续两段悬空（中间隔 user），各补各的
    const multi: LLMMessage[] = [
      user('第一轮'),
      assistant([call('c1')]),
      user('第二轮'),
      assistant([call('c2'), call('c3')]),
      toolMsg('c3', '已回'),
      user('结束'),
    ];
    const out = repairDanglingToolCalls(multi);
    expect(out).toHaveLength(8);
    expectFullyPaired(out);
    // 原 user 消息全部保留
    expect(out.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '第一轮',
      '第二轮',
      '结束',
    ]);
    // 原 c3 真实响应仍在
    expect(out.filter((m) => m.role === 'tool' && m.toolCallId === 'c3')).toHaveLength(1);
  });
});

// ═══ 第二层：组装出口集成（真实 db + 生产 chunk 落库链） ═══

describe('组装出口集成：真实组装链产物恒满足配对不变量', () => {
  it('rebuildTurn：中断流（2 个 tool_call 仅 1 个 result + 畸形载荷）重建段配对完整', async () => {
    const ssId = 'ss-interrupted-1';
    insertOwnerMessage(SESSION_ID, '帮我读两个文件');
    startStream(ssId);
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: ssId, delta: '开始分析' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: ssId,
      callId: 'call_a',
      toolName: 'read_file',
      args: { path: 'src/a.ts' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: ssId,
      callId: 'call_b',
      toolName: 'read_file',
      args: { path: 'src/b.ts' },
    });
    // call_a 拿到结果；call_b 中断（无 result）——生产中断形态
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: ssId,
      callId: 'call_a',
      toolName: 'read_file',
      result: '文件 A 内容',
      success: true,
    });
    __flushEventBufferForTest();

    const rebuilt = await rebuildTurn(ssId);
    expect(rebuilt.degenerate).toBe(false);
    // 修复门后的组装出口契约：每个 toolCallId 都有紧随 tool 响应
    expectFullyPaired(rebuilt.messages);
    // call_b 由聚合器合成中断结果（既有语义保持），非新修复文案
    const bResult = rebuilt.messages.find(
      (m) => m.role === 'tool' && m.toolCallId === 'call_b',
    );
    expect(bResult).toBeDefined();
  });

  it('rebuildSessionContext：跨轮会话重建（含中断族 + steer 行）产物配对完整', async () => {
    // 轮 1：完整工具对族
    insertOwnerMessage(SESSION_ID, '第一轮指令');
    startStream('ss-round-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-round-1', delta: '处理中' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-round-1',
      callId: 'c1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-round-1',
      callId: 'c1',
      toolName: 'bash',
      result: 'a.ts b.ts',
      success: true,
    });
    __flushEventBufferForTest();
    // 轮 2：中断族（tool_call 落库后进程被杀，无 result）
    insertOwnerMessage(SESSION_ID, '第二轮指令');
    startStream('ss-round-2');
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-round-2',
      callId: 'c2',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    __flushEventBufferForTest();

    const ctx = rebuildSessionContext(SESSION_ID, { limitTurns: 20, excludeTrailingOwnerRow: false });
    expect(ctx.messages.length).toBeGreaterThan(0);
    expectFullyPaired(ctx.messages);
    // timestamps 与 messages 平行（修复门插入不破坏平行性）
    expect(ctx.timestamps).toHaveLength(ctx.messages.length);
  });

  it('rebuildSubConversation：子链重建（首轮工具对 + followup 轮中断）产物配对完整', () => {
    const taskId = 'T-chain-repair-1';
    // 首轮：子 agent 流（工具对完整）
    startStream('ss-sub-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-sub-1', delta: '分析中' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-sub-1',
      callId: 'sc1',
      toolName: 'read_file',
      args: { path: 'src/login.ts' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-sub-1',
      callId: 'sc1',
      toolName: 'read_file',
      result: '文件内容',
      success: true,
    });
    __flushEventBufferForTest();
    getDb()
      .prepare('UPDATE messages SET task_id = ? WHERE stream_session_id = ?')
      .run(taskId, 'ss-sub-1');

    // followup 轮：user 追问 + 子 agent 中断流（call 无 result）
    insertMessage({
      sessionId: SESSION_ID,
      sender: 'owner',
      eventType: 'm.room.message',
      body: '展开成表格',
      taskId,
    });
    startStream('ss-sub-2');
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-sub-2',
      callId: 'sc2',
      toolName: 'read_file',
      args: { path: 'src/table.ts' },
    });
    __flushEventBufferForTest();
    getDb()
      .prepare('UPDATE messages SET task_id = ? WHERE stream_session_id = ?')
      .run(taskId, 'ss-sub-2');

    const rebuilt = rebuildSubConversation(taskId, SESSION_ID);
    expect(rebuilt.degraded).toBe(false);
    expectFullyPaired(rebuilt.messages);
  });
});
