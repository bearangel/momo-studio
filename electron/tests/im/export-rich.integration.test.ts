// electron/tests/im/export-rich.integration.test.ts
//
// 导出富信息端到端集成（v2.3.2 spec §7）：真 DB + 真 handler 链——
// listRecentMessagesBySession → alignVisibleEntries → exportAggregateEvents
// → renderSubMessage 嵌套 → formatRoomToMarkdown。锁：时间线交错顺序、
// thinking 排除、截断标注、子 agent 嵌套、无事件消息回退。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { ipcHandlers } = vi.hoisted(() => ({ ipcHandlers: new Map<string, (...a: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { ipcHandlers.set(ch, fn); } },
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
  TRIGGER_TURN_INTERVAL: 20,
}));
// session-ops / session-service 触达 p2p / 任务执行链，进程外副作用——打桩
vi.mock('../../src/main/im/session-ops', () => ({
  getSessionsForWorkspace: vi.fn(() => []),
  createQuickSession: vi.fn(() => undefined),
  createCollabSession: vi.fn(() => undefined),
  renameSession: vi.fn(() => undefined),
  deleteSessionOp: vi.fn(() => undefined),
  getSessionMembersInfo: vi.fn(() => []),
}));
vi.mock('../../src/main/im/session-service', () => ({
  sendUserMessage: vi.fn(async () => undefined),
}));
// workspace/agent 模块仅供 botNameMap 反查——空表回退 shortName()，对断言无影响
vi.mock('../../src/main/workspace/crud', () => ({
  listWorkspaces: vi.fn(() => []),
  getWorkspace: vi.fn(() => undefined),
}));
vi.mock('../../src/main/agent/crud', () => ({
  listMembers: vi.fn(() => []),
  getAgentDefinition: vi.fn(() => undefined),
}));

import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEvent, nextSeqForMessage } from '../../src/main/storage/messages/events-repo';
import { registerSessionIpcHandlers } from '../../src/main/im/session.ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-export-rich-${Date.now()}`);
const SESSION = 'sess-rich';

function pushEvent(messageId: string, eventType: Parameters<typeof insertEvent>[0]['eventType'], payload: Record<string, unknown>): void {
  insertEvent({ messageId, seq: nextSeqForMessage(messageId), eventType, payload });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  registerSessionIpcHandlers();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('session:exportMessages 富信息', () => {
  it('时间线交错 + thinking 排除 + 工具截断 + 子 agent 嵌套 + 无事件回退', async () => {
    // 用户消息（无 events → 纯 body）
    const mu = insertMessage({ sessionId: SESSION, sender: 'owner', eventType: 'm.room.message', body: '帮我检查' });

    // PM agent 消息（含 thinking/工具/委派/todo/final）
    const mp = insertMessage({ sessionId: SESSION, sender: '@coder.x', eventType: 'm.room.message', body: '已检查', streamSessionId: 'ss-pm', status: 'done' });
    pushEvent(mp.id, 'thinking_delta', { delta: '内心策略不外泄' });
    pushEvent(mp.id, 'text_delta', { delta: '先看文件' });
    pushEvent(mp.id, 'tool_call_start', { callId: 'c1', toolName: 'read_file', args: { path: 'a.ts' } });
    pushEvent(mp.id, 'tool_call_result', { callId: 'c1', result: 'y'.repeat(2500), success: true });
    pushEvent(mp.id, 'tool_call_start', { callId: 'd1', toolName: 'dispatch', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'tester', args: { task: '验证构建' } });
    pushEvent(mp.id, 'todo_update', { todos: [{ id: 't1', subject: '检查', status: 'completed' }] });
    pushEvent(mp.id, 'tool_call_result', { callId: 'd1', subStatus: 'completed' });
    pushEvent(mp.id, 'text_delta', { delta: '完成' });
    pushEvent(mp.id, 'final', { status: 'done' });

    // 子 agent 消息（parentStreamSessionId 指向 PM 流；顶层对齐应剔除、嵌套展开应呈现）
    const ms = insertMessage({ sessionId: SESSION, sender: '@tester.x', eventType: 'm.room.message', body: '子回复', streamSessionId: 'ss-sub', parentStreamSessionId: 'ss-pm', status: 'done' });
    pushEvent(ms.id, 'text_delta', { delta: '构建验证通过' });
    pushEvent(ms.id, 'final', { status: 'done' });

    const handler = ipcHandlers.get('session:exportMessages') as (evt: unknown, sid: string, limit: number) => Promise<{ filename: string; content: string }>;
    const { content } = await handler(null, SESSION, 100);

    // thinking 排除（spec §7-3）
    expect(content).not.toContain('内心策略不外泄');
    // 无事件消息回退（spec §7-5）
    expect(content).toContain('帮我检查');
    // 时间线顺序（spec §7-1）：text → 工具 → 委派 → todo → text
    const order = ['先看文件', '🔧 **工具** `read_file`', '（已截断，原文 2500 字符）', '📤 **委派** tester：验证构建 —— ✅ completed', '- ✓ 检查', '完成']
      .map((s) => content.indexOf(s));
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 子 agent 嵌套（spec §7-2）：引块内出现子回复，且顶层不重复出现
    expect(content).toContain('> **tester**');
    expect(content).toContain('> 构建验证通过');
    // 子行不作为顶层 ## 条目重复（sender 原文只出现在嵌套引块内）
    const firstTester = content.indexOf('@tester.x');
    expect(content.lastIndexOf('@tester.x')).toBe(firstTester);
    // 用户消息 id 也参与断言（编译期验证 mu 已被使用——避免 unused 警告）
    expect(mu.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('长流压缩产生分段快照行后，父消息仍是唯一导出主体（2026-09-08 主机实测 P0 回归锁）', async () => {
    // 复现用户真机场景：agent 长任务中途 compact 压缩 → segment_boundary →
    // stream-relay 落一条分段快照行（body=压缩摘要、无 events、createdAt=压缩时刻）。
    // 旧「分段替换父」对齐语义会让导出只剩摘要、丢全文丢工具块（copy 按钮都比它全）。
    insertMessage({ sessionId: SESSION, sender: 'owner', eventType: 'm.room.message', body: '执行任务' });

    // 父消息（流主体）：全部 events 挂父 messageId，含压缩边界
    const mp = insertMessage({ sessionId: SESSION, sender: '@coder.x', eventType: 'm.room.message', body: '先做A再做B最后总结。', streamSessionId: 'ss-long', status: 'done' });
    pushEvent(mp.id, 'text_delta', { delta: '先做A' });
    pushEvent(mp.id, 'tool_call_start', { callId: 'c9', toolName: 'bash', args: { command: 'ls' } });
    pushEvent(mp.id, 'tool_call_result', { callId: 'c9', result: 'file1', success: true });
    pushEvent(mp.id, 'text_delta', { delta: '再做B' });
    pushEvent(mp.id, 'segment_boundary', {}); // 压缩边界（compact 触发）
    pushEvent(mp.id, 'final', { status: 'done' });

    // 分段快照行（生产链路形态：segmentOf=父流、自身无 events、更晚的 createdAt）
    insertMessage({ sessionId: SESSION, sender: '@coder.x', eventType: 'm.room.message', body: '压缩摘要快照', streamSessionId: 'ss-long#seg1', segmentOf: 'ss-long', segmentIndex: 1, status: 'done' });

    const handler = ipcHandlers.get('session:exportMessages') as (evt: unknown, sid: string, limit: number) => Promise<{ filename: string; content: string }>;
    const { content } = await handler(null, SESSION, 100);

    // 父行全文与工具块在（富信息从父行 events 重建）
    expect(content).toContain('先做A');
    expect(content).toContain('再做B');
    expect(content).toContain('🔧 **工具** `bash`');
    // 压缩摘要快照不出现（分段行剔除）
    expect(content).not.toContain('压缩摘要快照');
    // 消息头只有两条（用户 + 父行直出；分段行不再拆成第三条）
    expect(content.match(/## /g)?.length).toBe(2);
  });
});