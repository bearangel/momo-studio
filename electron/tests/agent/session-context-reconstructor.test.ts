// electron/tests/agent/session-context-reconstructor.test.ts
//
// rebuildSessionContext 回归矩阵（spec 2026-09-14 §4.5）。
// fixture 保真度：真实 db（tmp + AP_USER_DATA_DIR + runMigrations）+ 生产落库链
// __routeChunkToBufferForTest（start/tool_call/tool_result/end chunk）；行时序用
// 显式 UPDATE created_at 保证确定性（同毫秒插入会使时间窗判定不稳定）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
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
import { insertEvent } from '../../src/main/storage/messages/events-repo';
import {
  rebuildSessionContext,
  INTERRUPTED_TOOL_RESULT,
} from '../../src/main/agent/turn-reconstructor';
import { TOOL_RESULT_MAX_LEN, TRUNCATED_MARKER } from '../../src/main/compaction/serialize';

const tmpRoot = path.join(os.tmpdir(), `ap-session-ctx-${Date.now()}`);

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

const SESSION_ID = 'sess-ctx-1';
const AGENT_SENDER = 'agent-coder-a1b2c3';

/** owner 行（字段照抄 session-service.sendUserMessage）+ 显式时序 */
function ownerRow(body: string, ts: number): void {
  const row = insertMessage({ sessionId: SESSION_ID, sender: 'owner', eventType: 'm.room.message', body });
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, row.id);
}

/** start chunk 落库后改写流行 created_at（族首行时序锚点） */
function startStream(ssi: string, ts: number): void {
  __routeChunkToBufferForTest({
    type: 'start', streamSessionId: ssi, sessionId: SESSION_ID, senderAgentId: AGENT_SENDER,
  });
  __flushEventBufferForTest();
  getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(ts, ssi);
}

function toolCall(ssi: string, callId: string, name: string, args: Record<string, unknown>): void {
  __routeChunkToBufferForTest({
    type: 'tool_call', streamSessionId: ssi, callId, toolName: name, args,
  });
  __flushEventBufferForTest();
}

function toolResult(ssi: string, callId: string, name: string, result: string): void {
  __routeChunkToBufferForTest({
    type: 'tool_result', streamSessionId: ssi, callId, toolName: name, result, success: true,
  });
  __flushEventBufferForTest();
}

function endStream(ssi: string, finishReason: 'stop' | 'interrupted' | 'error' | 'budget_exhausted'): void {
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: ssi, finishReason });
  __flushEventBufferForTest();
}

/** 事件时刻整体平移（窗口测试需要事件晚于指定行时刻） */
function bumpStreamEventTs(ssi: string, floorTs: number): void {
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE created_at < ? AND message_id IN
       (SELECT id FROM messages WHERE stream_session_id = ? OR stream_session_id LIKE ? || '#%')`,
  ).run(floorTs, floorTs, ssi, ssi);
}

describe('rebuildSessionContext（spec 2026-09-14 §4.5 回归矩阵）', () => {
  it('T1 案例回归锁：中断轮的工具对完整进入下一轮上下文，当前指令行被剔除', () => {
    const T0 = Date.now();
    ownerRow('帮我使用bash访问一下bing', T0 + 100);
    startStream('s1', T0 + 200);
    toolCall('s1', 'c1', 'bash', { command: 'curl https://www.bing.com' });
    toolResult('s1', 'c1', 'bash', 'HTTP状态码: 200');
    bumpStreamEventTs('s1', T0 + 250);
    endStream('s1', 'interrupted');
    bumpStreamEventTs('s1', T0 + 280);
    ownerRow('访问百度', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({ role: 'user', content: '帮我使用bash访问一下bing' });
    expect(ctx.messages[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'bash' }],
    });
    expect(ctx.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'HTTP状态码: 200' });
    expect(ctx.timestamps).toEqual([T0 + 100, T0 + 200, T0 + 200]);
  });

  it('T2 孤儿 tool_call：中断无 result 时合成 INTERRUPTED_TOOL_RESULT', () => {
    const T0 = Date.now();
    ownerRow('跑个任务', T0 + 100);
    startStream('s2', T0 + 200);
    toolCall('s2', 'c2', 'bash', { command: 'sleep 100' });
    bumpStreamEventTs('s2', T0 + 250);
    endStream('s2', 'interrupted');
    ownerRow('继续', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    const tool = ctx.messages.find((m) => m.role === 'tool')!;
    expect(tool.content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(tool.toolCallId).toBe('c2');
  });

  it('T3a 已 drain steer：族时间窗内 owner 行去重，事件渲染为 [用户中途补充]', () => {
    const T0 = Date.now();
    ownerRow('查点资料', T0 + 100);
    startStream('s3', T0 + 200);
    // 输出一段文本（事件时刻抬到 T0+220）
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 's3', delta: '正在查询' });
    __flushEventBufferForTest();
    bumpStreamEventTs('s3', T0 + 220);
    // steer：owner 行先落（T0+240），子进程 drain 后 steer 事件（抬到 T0+260）
    ownerRow('顺便也看看百度', T0 + 240);
    const streamRowId = getDb()
      .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
      .get('s3') as { id: string };
    insertEvent({
      messageId: streamRowId.id, seq: 99, eventType: 'steer', payload: { body: '顺便也看看百度' },
    });
    bumpStreamEventTs('s3', T0 + 260);
    endStream('s3', 'stop');

    const ctx = rebuildSessionContext(SESSION_ID);
    const bodies = ctx.messages.map((m) => m.content);
    // owner steer 行被跳过，只有事件渲染的那一条补充消息
    expect(bodies.filter((b) => b === '顺便也看看百度')).toHaveLength(0);
    expect(bodies.filter((b) => b === '[用户中途补充] 顺便也看看百度')).toHaveLength(1);
  });

  it('T3b 未 drain steer（无事件）：owner 行是唯一记录，渲染为 user 消息', () => {
    const T0 = Date.now();
    ownerRow('查点资料', T0 + 100);
    startStream('s3b', T0 + 200);
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 's3b', delta: '正在查询' });
    __flushEventBufferForTest();
    bumpStreamEventTs('s3b', T0 + 220);
    endStream('s3b', 'interrupted');
    // 进程死前未 drain：只有 owner 行（时刻在全部事件之后 → 族窗外）
    ownerRow('怎么不理我了', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID);
    const bodies = ctx.messages.map((m) => m.content);
    expect(bodies).toContain('怎么不理我了');
    expect(bodies.some((b) => b.startsWith('[用户中途补充]'))).toBe(false);
  });

  it('T4 子流行 / #seg 快照 / #roll 换行：前两者跳过，roll 并族', () => {
    const T0 = Date.now();
    ownerRow('多步任务', T0 + 100);
    startStream('s4', T0 + 200);
    toolCall('s4', 'c4', 'bash', { command: 'ls' });
    toolResult('s4', 'c4', 'bash', 'a.ts b.ts');
    bumpStreamEventTs('s4', T0 + 250);
    // 分段快照行（#seg）
    __routeChunkToBufferForTest({
      type: 'segment_boundary', streamSessionId: 's4', segmentStreamSessionId: 's4#seg0',
      segmentBody: '第一段完成', segmentIndex: 0,
    });
    __flushEventBufferForTest();
    // 换行（#roll1）：事件落新行
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 's4' });
    __flushEventBufferForTest();
    // #seg/#roll 行真实落库时刻（≈T0+ε）早于 base 行锚点（T0+200），族内行序被
    // created_at ASC 颠倒（collectStreamEvents 先取 roll 行事件 → c5 反超 c4）。
    // 生产不可能出现（roll 行必晚于 base 行）——按本文件确定性时序原则显式归位。
    getDb().prepare(
      `UPDATE messages SET created_at = ? WHERE stream_session_id LIKE ? || '#%'`,
    ).run(T0 + 250, 's4');
    toolCall('s4', 'c5', 'read_file', { path: '/tmp/a.ts' });
    toolResult('s4', 'c5', 'read_file', 'file-content');
    bumpStreamEventTs('s4', T0 + 300);
    endStream('s4', 'stop');
    // 子 agent 流行（parent 指向 s4）
    const sub = insertMessage({
      sessionId: SESSION_ID, sender: 'agent-pm-x1', eventType: 'm.room.message', body: '子agent回复',
      streamSessionId: 'sub-1', parentStreamSessionId: 's4', status: 'done',
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 280, sub.id);

    const ctx = rebuildSessionContext(SESSION_ID);
    const toolIds = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(toolIds).toEqual(['c4', 'c5']); // roll 后事件并进同一族
    expect(ctx.messages.some((m) => m.content === '子agent回复')).toBe(false); // 子流行跳过
    expect(ctx.messages.some((m) => m.content === '第一段完成')).toBe(false); // seg 快照跳过
  });

  it('T5 compaction 游标 + 摘要头 + 旧轮超长工具结果截断', () => {
    const T0 = Date.now();
    getDb().prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-ctx', 'WS', '', '/tmp', 0, '@owner:s', 'x')`,
    ).run();
    getDb().prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, 'ws-ctx', 't', 'chat', 1000, 1000)`,
    ).run(SESSION_ID);
    // 旧轮：超长工具结果
    ownerRow('旧任务', T0 + 100);
    startStream('s5', T0 + 200);
    toolCall('s5', 'c6', 'bash', { command: 'cat big.log' });
    toolResult('s5', 'c6', 'bash', 'x'.repeat(TOOL_RESULT_MAX_LEN + 100));
    bumpStreamEventTs('s5', T0 + 250);
    endStream('s5', 'stop');
    // 游标落在旧轮之后
    getDb().prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, '旧对话已压缩', ?, ?)`,
    ).run(SESSION_ID, T0 + 260, T0 + 260);
    // 新轮（游标后）
    ownerRow('新任务', T0 + 300);
    startStream('s6', T0 + 400);
    toolCall('s6', 'c7', 'bash', { command: 'echo hi' });
    toolResult('s6', 'c7', 'bash', 'hi');
    bumpStreamEventTs('s6', T0 + 450);
    endStream('s6', 'stop');
    ownerRow('当前指令', T0 + 500);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    // 摘要头条
    expect(ctx.messages[0]!.role).toBe('user');
    expect(ctx.messages[0]!.content).toContain('旧对话已压缩');
    // 游标前旧轮不出现（c6 不在）
    expect(ctx.messages.some((m) => m.toolCallId === 'c6')).toBe(false);
    // 游标后新轮完整
    expect(ctx.messages.some((m) => m.toolCallId === 'c7')).toBe(true);
    // 旧轮若未被游标覆盖时也应截断——单独验证：无 compaction 时超长结果被截断
    getDb().prepare('DELETE FROM session_compactions WHERE session_id = ?').run(SESSION_ID);
    const ctx2 = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    const big = ctx2.messages.find((m) => m.toolCallId === 'c6')!;
    expect(big.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_LEN + TRUNCATED_MARKER.length + 1);
    expect(big.content).toContain(TRUNCATED_MARKER);
  });

  it('T6 空轮流：零输出事件的族不产生空 assistant 消息', () => {
    const T0 = Date.now();
    ownerRow('指令一', T0 + 100);
    startStream('s7', T0 + 200); // 直接中断，零输出事件
    endStream('s7', 'interrupted');
    ownerRow('指令二', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    expect(ctx.messages).toEqual([{ role: 'user', content: '指令一' }]);
    expect(ctx.messages.some((m) => m.role === 'assistant' && m.content === '')).toBe(false);
  });

  it('T7 默认不剔除末尾 owner 行（excludeTrailingOwnerRow 缺省）', () => {
    const T0 = Date.now();
    ownerRow('指令一', T0 + 100);
    startStream('s8', T0 + 200);
    toolCall('s8', 'c8', 'bash', { command: 'pwd' });
    toolResult('s8', 'c8', 'bash', '/tmp');
    bumpStreamEventTs('s8', T0 + 250);
    endStream('s8', 'stop');
    ownerRow('当前指令', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID);
    expect(ctx.messages[ctx.messages.length - 1]).toEqual({ role: 'user', content: '当前指令' });
  });
});
