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
import { randomUUID } from 'node:crypto';

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
  applyRecentImageReplay,
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

/** 族事件时刻整体锚定（exact set 含 final 事件；族 endTs 断言确定性用——
 *  bump 只抬不压，final 事件真实时刻漂移会使 endTs 不可断言） */
function setStreamEventTs(ssi: string, ts: number): void {
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE message_id IN
       (SELECT id FROM messages WHERE stream_session_id = ? OR stream_session_id LIKE ? || '#%')`,
  ).run(ts, ssi, ssi);
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
    // I1 契约：族时间戳 = endTs（族末事件时刻 ≥ 全部族行 created_at）——压缩
    // coveredUntil 落在族上时下一轮 afterTs 整族出局。事件锚定用 exact set
    //（含 final 事件）保证 endTs 可精确断言
    setStreamEventTs('s1', T0 + 280);
    ownerRow('访问百度', T0 + 300);

    const ctx = rebuildSessionContext(SESSION_ID, { excludeTrailingOwnerRow: true });
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({ role: 'user', content: '帮我使用bash访问一下bing' });
    expect(ctx.messages[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'bash' }],
    });
    expect(ctx.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'HTTP状态码: 200' });
    expect(ctx.timestamps).toEqual([T0 + 100, T0 + 280, T0 + 280]);
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
    // 正向断言：cutoff 之后的工具结果不截断（最后一条 user「新任务」之后的 c7 原样保留）
    const c7 = ctx2.messages.find((m) => m.toolCallId === 'c7')!;
    expect(c7.content).toBe('hi');
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

  it('T8 单族降级：损坏族（payload 非法 JSON）跳过该族，正常族完整，整体不降级为空', () => {
    const T0 = Date.now();
    ownerRow('第一问', T0 + 100);
    startStream('s-broken', T0 + 200);
    toolCall('s-broken', 'c9', 'bash', { command: 'ls' });
    toolResult('s-broken', 'c9', 'bash', 'ok');
    bumpStreamEventTs('s-broken', T0 + 250);
    endStream('s-broken', 'stop');
    // 损坏族触发：裸 SQL 往流行手插一行 payload_json 非法 JSON 的事件（列形状照抄
    // events-repo.insertEvent）——events-repo rowToCamel 的 JSON.parse 抛 →
    // collectStreamEvents 抛 → 单族降级路径命中（真实运行时语义，非 monkeypatch）
    const brokenRowId = getDb()
      .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
      .get('s-broken') as { id: string };
    getDb().prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, 50, 'text_delta', ?, ?)`,
    ).run(randomUUID(), brokenRowId.id, '{这不是合法JSON', T0 + 260);
    ownerRow('第二问', T0 + 300);
    startStream('s-ok', T0 + 400);
    toolCall('s-ok', 'c10', 'bash', { command: 'pwd' });
    toolResult('s-ok', 'c10', 'bash', '/tmp');
    bumpStreamEventTs('s-ok', T0 + 450);
    endStream('s-ok', 'stop');

    const ctx = rebuildSessionContext(SESSION_ID);
    // 未触发整体降级（若整体 catch 命中则 messages=[]，下列正向断言全红）
    expect(ctx.messages.some((m) => m.role === 'user' && m.content === '第一问')).toBe(true);
    expect(ctx.messages.some((m) => m.role === 'user' && m.content === '第二问')).toBe(true);
    expect(ctx.messages.some((m) => m.toolCallId === 'c10')).toBe(true); // 正常族完整
    expect(ctx.messages.some((m) => m.toolCallId === 'c9')).toBe(false); // 损坏族缺席
  });

  it('T9a owner 行带 parentStreamSessionId（dispatch_followup 追问行）→ 保留为 user 单位', () => {
    const T0 = Date.now();
    ownerRow('原始指令', T0 + 100);
    startStream('s9', T0 + 200);
    toolCall('s9', 'c11', 'dispatch:coder', { task: '干活' });
    bumpStreamEventTs('s9', T0 + 250);
    endStream('s9', 'interrupted');
    // 追问行形态照抄 chain-writer.appendFollowupQuestionRow：sender='owner' +
    // parentStreamSessionId（PM 当前流 id），streamSessionId 缺省 null
    const followup = insertMessage({
      sessionId: SESSION_ID, sender: 'owner', eventType: 'm.room.message', body: '追问：进度如何',
      taskId: 'task-1', parentStreamSessionId: 's9',
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 300, followup.id);

    const ctx = rebuildSessionContext(SESSION_ID);
    expect(ctx.messages.some((m) => m.role === 'user' && m.content === '追问：进度如何')).toBe(true);
  });

  it('T9b 空会话（bogus id）→ 空上下文（fresh-session 形态）', () => {
    const ctx = rebuildSessionContext('sess-not-exist');
    expect(ctx.messages).toEqual([]);
    expect(ctx.timestamps).toEqual([]);
  });

  it('T9c limitTurns=0 退化防护：窗口下限 1，不退化为全量', () => {
    const T0 = Date.now();
    ownerRow('指令一', T0 + 100);
    startStream('s10', T0 + 200);
    toolCall('s10', 'c12', 'bash', { command: 'echo a' });
    toolResult('s10', 'c12', 'bash', 'a');
    bumpStreamEventTs('s10', T0 + 250);
    endStream('s10', 'stop');
    ownerRow('当前指令', T0 + 300);

    // 无防护时 slice(-0) === slice(0) 返回全部单位；下限 1 后只保留最后 1 个单位
    const ctx = rebuildSessionContext(SESSION_ID, { limitTurns: 0 });
    expect(ctx.messages).toEqual([{ role: 'user', content: '当前指令' }]);
  });

  it('C1 excludeFamilySsi：断点族不展开、#roll 行不复活、族窗内 steer 行仍去重、原指令行由 trailing 剔除', () => {
    const T0 = Date.now();
    ownerRow('原始指令', T0 + 100);
    startStream('sx', T0 + 200);
    toolCall('sx', 'cx1', 'bash', { command: 'ls' });
    toolResult('sx', 'cx1', 'bash', 'a.ts');
    bumpStreamEventTs('sx', T0 + 250);
    // 族窗内 steer 行（已 drain = 有 steer 事件）：内容应随 resumeTurn 呈现，
    // convCtx 的 owner 行不得再渲染（防 steer 双份）
    ownerRow('中途补充', T0 + 240);
    const streamRowId = getDb()
      .prepare('SELECT id FROM messages WHERE stream_session_id = ?')
      .get('sx') as { id: string };
    insertEvent({
      messageId: streamRowId.id, seq: 99, eventType: 'steer', payload: { body: '中途补充' },
    });
    bumpStreamEventTs('sx', T0 + 260);
    endStream('sx', 'interrupted');
    bumpStreamEventTs('sx', T0 + 280);

    // resume 路径形态：excludeTrailingOwnerRow + excludeFamilySsi（= 断点 base id）
    const ctx = rebuildSessionContext(SESSION_ID, {
      excludeTrailingOwnerRow: true,
      excludeFamilySsi: 'sx',
    });
    // 断点族整族缺席（零消息族单位经步骤② 剔除）
    expect(ctx.messages.some((m) => m.toolCallId === 'cx1')).toBe(false);
    expect(ctx.messages.some((m) => m.role === 'assistant')).toBe(false);
    // 原指令行被 excludeTrailingOwnerRow 剔除（其内容由 resumeTurn 首条 user 携带）
    expect(ctx.messages.some((m) => m.content === '原始指令')).toBe(false);
    // 族窗内 steer 行去重（内容已随 resumeTurn 的 drain 渲染 / steers[] 重放）
    expect(ctx.messages.some((m) => m.content === '中途补充')).toBe(false);
    expect(ctx.messages.some((m) => m.content.startsWith('[用户中途补充]'))).toBe(false);
    // 净效果：空上下文（本会话唯一回合即断点族）
    expect(ctx.messages).toEqual([]);
    expect(ctx.timestamps).toEqual([]);
  });

  it('I1 回归锁：带 #roll 的族被压缩后下一轮不再复活（族时间戳 = endTs，coveredUntil 按其派生）', () => {
    // session_compactions 有 FK → sessions（照 T5 前置 seed）
    getDb().prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-ctx', 'WS', '', '/tmp', 0, '@owner:s', 'x')`,
    ).run();
    getDb().prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, 'ws-ctx', 't', 'chat', 1000, 1000)`,
    ).run(SESSION_ID);

    const T0 = Date.now();
    ownerRow('跑多步任务', T0 + 100);
    startStream('sr', T0 + 200);
    toolCall('sr', 'cr1', 'bash', { command: 'step1' });
    toolResult('sr', 'cr1', 'bash', 'step1-ok');
    // #roll 换行：后续事件落新行（行时刻晚于 base 行——旧 bug 的复活载体：
    // afterTs 只排除 base 行时 roll 行幸存，walk 经其重建整族）
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'sr' });
    __flushEventBufferForTest();
    getDb().prepare(
      `UPDATE messages SET created_at = ? WHERE stream_session_id LIKE ? || '#%'`,
    ).run(T0 + 300, 'sr');
    toolCall('sr', 'cr2', 'bash', { command: 'step2' });
    toolResult('sr', 'cr2', 'bash', 'step2-ok');
    endStream('sr', 'stop');
    setStreamEventTs('sr', T0 + 320);

    // 第一轮（未压缩）：族完整可见。族消息 timestamps 是 runCompaction 经
    // convTimes 派生 coveredUntil 的生产数据源——旧代码取 startTs（T0+200，
    // 能排除 base 行但排除不了 roll 行），新代码取 endTs（≥ 全部族行时刻）
    const ctx1 = rebuildSessionContext(SESSION_ID);
    const cr1Idx = ctx1.messages.findIndex((m) => m.toolCallId === 'cr1');
    expect(cr1Idx).toBeGreaterThan(0);
    const familyTs = ctx1.timestamps[cr1Idx]!;
    expect(familyTs).toBeGreaterThanOrEqual(T0 + 300); // ≥ roll 行时刻（旧代码红）

    // 模拟压缩落库：covered_until = 族时间戳（生产链 runCompaction 的派生形状）
    getDb().prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, '多步任务已压缩', ?, ?)`,
    ).run(SESSION_ID, familyTs, familyTs);

    // 下一轮：族整族缺席、只剩摘要头（旧代码红：roll 行 created_at > startTs
    // 幸存 afterTs → walk 复活整族，与摘要头双内容）
    const ctx2 = rebuildSessionContext(SESSION_ID);
    expect(ctx2.messages).toHaveLength(1);
    expect(ctx2.messages[0]!.content).toContain('多步任务已压缩');
    expect(ctx2.messages.some((m) => m.toolCallId === 'cr1' || m.toolCallId === 'cr2')).toBe(false);
  });
});

// === 多模态近 2 轮重发（Task 9，spec 2026-09-26-image-input-multimodal §9）===
//
// rebuildSessionContext 产 imageReplayTargets（owner 轮定位元数据，同步零 IO），
// applyRecentImageReplay 按 {vision, budget} 异步读取并附图（expander 复用：
// WorkspaceFS + 8MB cap + 失败剔除）。保真度：真实 workspace 目录 + 真实文件，
// 不 mock fs（momo-test-rules）。
describe('applyRecentImageReplay（近 2 轮图片重发窗口）', () => {
  const WS_ID = 'ws-img-replay';
  let wsDir: string;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-img-replay-'));
    getDb().prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'WS', ?, '@o')`,
    ).run(WS_ID, wsDir);
  });

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  /** 写一张「图片」文件（expander 按扩展名映射 mime，内容不校验） */
  function writeImage(name: string, byte: number): void {
    fs.writeFileSync(path.join(wsDir, name), Buffer.from([byte]));
  }

  /** 带 images context_json 的 owner 行（字段对齐 sendUserMessage 落库形态） */
  function ownerRowWithImages(body: string, ts: number, images: string[]): void {
    const row = insertMessage({
      sessionId: SESSION_ID,
      sender: 'owner',
      eventType: 'm.room.message',
      body,
      workspaceId: WS_ID,
      contextJson: JSON.stringify({
        skills: [],
        files: [],
        images: images.map((p) => ({ path: p, w: 100, h: 80 })),
      }),
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, row.id);
  }

  it('近 2 轮带图 user 消息恢复 images，第 3 轮不恢复（窗口边界）', async () => {
    const T0 = Date.now();
    writeImage('old.png', 1);
    writeImage('mid.png', 2);
    writeImage('new.png', 3);
    ownerRowWithImages('第一轮', T0 + 100, ['old.png']);
    ownerRowWithImages('第二轮', T0 + 200, ['mid.png']);
    ownerRowWithImages('第三轮', T0 + 300, ['new.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    await applyRecentImageReplay(ctx, { vision: true, budget: 6 });

    const msgs = ctx.messages;
    expect(msgs).toHaveLength(3);
    // 最新两条 user 消息带图（新→旧：第三轮 / 第二轮）
    expect(msgs[2]!.images).toHaveLength(1);
    expect(msgs[2]!.images![0]).toMatchObject({ mime: 'image/png', w: 100, h: 80, path: 'new.png' });
    expect(msgs[2]!.images![0]!.base64).toBe(Buffer.from([3]).toString('base64'));
    expect(msgs[1]!.images).toHaveLength(1);
    expect(msgs[1]!.images![0]).toMatchObject({ path: 'mid.png' });
    // 第 3 轮（最旧）不恢复——正文锚点由 T7 序列化承载
    expect(msgs[0]!.images).toBeUndefined();
  });

  it('vision=false → 全部不恢复（非视觉模型不带图）', async () => {
    const T0 = Date.now();
    writeImage('a.png', 1);
    ownerRowWithImages('第一轮', T0 + 100, ['a.png']);
    ownerRowWithImages('第二轮', T0 + 200, ['a.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    await applyRecentImageReplay(ctx, { vision: false, budget: 6 });

    expect(ctx.messages.every((m) => m.images === undefined)).toBe(true);
  });

  it('预算上限：当前轮已占 2，窗口 3+2 → 只恢复 4 张，最旧的先丢', async () => {
    const T0 = Date.now();
    for (const [i, name] of ['w1.png', 'w2.png', 'n1.png', 'n2.png', 'n3.png'].entries()) {
      writeImage(name, i + 1);
    }
    ownerRowWithImages('上上轮', T0 + 100, ['w1.png', 'w2.png']);
    ownerRowWithImages('上一轮', T0 + 200, ['n1.png', 'n2.png', 'n3.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    // 当前轮（Task 8 注入）已带 2 张 → 重发窗口余量 6-2=4
    await applyRecentImageReplay(ctx, { vision: true, budget: 4 });

    // 最新窗口消息整份保留（3 张）
    expect(ctx.messages[1]!.images).toHaveLength(3);
    // 较旧窗口消息只余 1 张（其第 1 张），第 2 张被丢（oldest dropped）
    expect(ctx.messages[0]!.images).toHaveLength(1);
    expect(ctx.messages[0]!.images![0]).toMatchObject({ path: 'w1.png' });
    // 窗口累计恰为预算 4
    const total = ctx.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    expect(total).toBe(4);
  });

  it('budget=0（当前轮占满）→ 窗口不附图', async () => {
    const T0 = Date.now();
    writeImage('a.png', 1);
    ownerRowWithImages('第一轮', T0 + 100, ['a.png']);
    ownerRowWithImages('第二轮', T0 + 200, ['a.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    await applyRecentImageReplay(ctx, { vision: true, budget: 0 });

    expect(ctx.messages.every((m) => m.images === undefined)).toBe(true);
  });

  it('读取失败（文件被删）→ 该图剔除不阻塞，其余照常恢复', async () => {
    const T0 = Date.now();
    writeImage('ok.png', 1);
    // 'gone.png' 不写盘——rebuild 时读取失败 → 剔除 + warn
    ownerRowWithImages('第一轮', T0 + 100, ['gone.png']);
    ownerRowWithImages('第二轮', T0 + 200, ['ok.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    await applyRecentImageReplay(ctx, { vision: true, budget: 6 });

    // 失败轮：无 images 字段（不产空数组占位）
    expect(ctx.messages[0]!.images).toBeUndefined();
    // 健全轮：照常恢复
    expect(ctx.messages[1]!.images).toHaveLength(1);
    expect(ctx.messages[1]!.images![0]).toMatchObject({ path: 'ok.png' });
  });

  it('无图会话（imageReplayTargets 缺省 / 空）→ no-op 零变化', async () => {
    const T0 = Date.now();
    ownerRow('纯文本第一轮', T0 + 100);
    ownerRow('纯文本第二轮', T0 + 200);

    const ctx = rebuildSessionContext(SESSION_ID);
    const before = JSON.stringify(ctx.messages);
    await applyRecentImageReplay(ctx, { vision: true, budget: 6 });
    expect(JSON.stringify(ctx.messages)).toBe(before);
  });

  it('fix M1 组合：压缩摘要头在场 + 带图轮 → images 落 user 消息（unshift 下标修正不漂移）', async () => {
    // 摘要头 unshift 使 messages 整体 +1——若 msgIndex 修正缺失，图会错附到
    // 前一条 assistant 消息（部分平台 400）。组合锁：头 + 带图轮 + assistant 族。
    const T0 = Date.now();
    writeImage('h1.png', 1);
    writeImage('h2.png', 2);
    // 压缩摘要（生产形态：session_compactions 行 + sessions 前置）
    getDb().prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, 'ws-img-replay', 't', 'chat', 1000, 1000)`,
    ).run(SESSION_ID);
    getDb().prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, '更早轮已压缩', ?, ?)`,
    ).run(SESSION_ID, T0 - 1, T0 - 1);
    ownerRowWithImages('第一轮', T0 + 100, ['h1.png']);
    // 带图轮后跟一个 assistant 族（错位受害者：无修正时 h1 会附到它头上）
    startStream('sf', T0 + 150);
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'sf', delta: '答一' });
    __flushEventBufferForTest();
    bumpStreamEventTs('sf', T0 + 160);
    endStream('sf', 'stop');
    setStreamEventTs('sf', T0 + 170);
    ownerRowWithImages('第二轮', T0 + 200, ['h2.png']);

    const ctx = rebuildSessionContext(SESSION_ID);
    await applyRecentImageReplay(ctx, { vision: true, budget: 6 });

    // messages = [摘要头(user), 第一轮(user), assistant, 第二轮(user)]
    expect(ctx.messages).toHaveLength(4);
    expect(ctx.messages[0]!.content).toContain('更早轮已压缩');
    expect(ctx.messages[0]!.images).toBeUndefined();
    expect(ctx.messages[1]!.content).toBe('第一轮');
    expect(ctx.messages[1]!.images).toHaveLength(1);
    expect(ctx.messages[1]!.images![0]).toMatchObject({ path: 'h1.png' });
    expect(ctx.messages[2]).toMatchObject({ role: 'assistant', content: '答一' });
    expect(ctx.messages[2]!.images).toBeUndefined();
    expect(ctx.messages[3]!.content).toBe('第二轮');
    expect(ctx.messages[3]!.images).toHaveLength(1);
    expect(ctx.messages[3]!.images![0]).toMatchObject({ path: 'h2.png' });
  });
});
