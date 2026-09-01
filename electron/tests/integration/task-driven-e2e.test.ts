// electron/tests/integration/task-driven-e2e.test.ts
//
// task-driven runtime 切换的核心回归测试。
// 4 个场景端到端验证：普通消息 / #task mention / dispatch / abort。
//
// 不启动真实 LLM / runtime fork；用 mock stream chunk 序列驱动 MessageEventBuffer
// 落盘，再用 aggregateEvents 从 SQLite 重建 StreamState，验证"数据流端到端正确"。
// 真实 runtime spawn 留 manual 测试（需真实 LLM API key + GUI）。
//
// 场景 1：用户普通消息 → agent ephemeral task → chat loop → 完成 → runtime 销毁
// 场景 2：用户 @agent #T-001 → task 启动 → 完成（验证 task 状态机 + 流聚合）
// 场景 3：PM dispatch → 子 agent ephemeral task → task_reply（全链路消息）
// 场景 4：abort → runtime AbortController 触发 → status=aborted
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertMessage,
  updateMessageStatus,
  getMessageByStreamSessionId,
} from '../../src/main/storage/messages/repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { insertTask, transitionTaskStatus, getTask } from '../../src/main/storage/tasks/repo';
import { aggregateEvents } from '../../../renderer/src/lib/stream-aggregator';

const tmpRoot = path.join(os.tmpdir(), `ap-task-driven-e2e-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // tasks 表对 workspace_id 有外键约束（ON DELETE CASCADE），需先建 workspace 行
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task-driven runtime e2e', () => {
  it('场景 1：用户普通消息 → ephemeral task → chat loop → 完成 → runtime 销毁', () => {
    // 1. INSERT user message
    insertMessage({
      sessionId: '!room:home',
      sender: '@owner:home',
      eventType: 'm.room.message',
      body: '@PM 你好',
      source: 'local',
    });

    // 2. 模拟 runtime 接收 task-config + 跑 chat loop（mock）
    const agentMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-1',
      status: 'streaming',
      parentStreamSessionId: undefined,
    });

    // 3. stream chunk 落盘
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({
      messageId: agentMsg.id,
      eventType: 'text_delta',
      payload: { delta: '你好！有什么可以帮你的？' },
    });
    buf.append({ messageId: agentMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();

    // 4. 验证 message 状态——buf 不改 status，由 main 在 final 后改
    const updated = getMessageByStreamSessionId('ss-1');
    expect(updated?.status).toBe('streaming');

    // 5. 重启聚合验证一致性（模拟 renderer 重启后从 SQLite 重建 StreamState）
    const events = listEventsByMessage(agentMsg.id);
    const stream = aggregateEvents(events);
    expect(stream.text).toBe('你好！有什么可以帮你的？');
    expect(stream.status).toBe('done');
  });

  it('场景 2：用户 @agent #T-001 → task 启动 → 完成', () => {
    // 1. INSERT task（用 repo 函数，自动填 created_at/updated_at 时间戳）
    insertTask({
      id: 'T-001',
      workspaceId: 'ws1',
      title: '实现登录',
      status: 'assigned',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });

    // 2. INSERT user message（含 #T-001 mention）
    insertMessage({
      sessionId: '!room:home',
      sender: '@owner:home',
      eventType: 'm.room.message',
      body: '@PM #T-001 开始吧',
      source: 'local',
    });

    // 3. 模拟 RouterService 检测 #mention → startTask（走状态机：assigned → in_progress）
    transitionTaskStatus('T-001', 'in_progress', {
      executionSessionId: '!room:home',
      startedAt: Date.now(),
    });

    // 4. 模拟 runtime 跑 chat loop
    const agentMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-2',
      status: 'streaming',
      taskId: 'T-001',
    });
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({
      messageId: agentMsg.id,
      eventType: 'text_delta',
      payload: { delta: '开始实现登录页' },
    });
    buf.append({
      messageId: agentMsg.id,
      eventType: 'tool_call_start',
      payload: { callId: 'c1', toolName: 'write_file', args: { path: '/login.tsx' } },
    });
    buf.append({
      messageId: agentMsg.id,
      eventType: 'tool_call_result',
      payload: { callId: 'c1', result: 'ok', success: true },
    });
    buf.append({ messageId: agentMsg.id, eventType: 'final', payload: {} });
    buf.flush();
    buf.destroy();

    // 5. complete_task → task 状态机（in_progress → completed）
    transitionTaskStatus('T-001', 'completed', { completedAt: Date.now() });

    // 6. 验证 task 终态 + 流聚合（工具调用配对）
    const task = getTask('T-001');
    expect(task?.status).toBe('completed');
    expect(task?.executionSessionId).toBe('!room:home');

    const stream = aggregateEvents(listEventsByMessage(agentMsg.id));
    expect(stream.toolCalls.length).toBe(1);
    expect(stream.toolCalls[0].toolName).toBe('write_file');
    expect(stream.toolCalls[0].result).toBe('ok');
    expect(stream.toolCalls[0].success).toBe(true);
  });

  it('场景 3：PM dispatch → 子 agent ephemeral task → task_reply', () => {
    // 1. PM 流式消息
    const pmMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@pm:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-pm',
      status: 'streaming',
    });

    // 2. PM 调 dispatch:programmer → 主进程发 dispatch event → INSERT dispatch message
    const dispatchMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@pm:home',
      eventType: 'io.momo-studio.dispatch',
      body: '写登录页',
      source: 'matrix',
    });

    // 3. RouterService 检测 dispatch → 创建子 agent ephemeral task（子 agent 流式消息）
    const subMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@prog:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-sub',
      status: 'streaming',
      parentStreamSessionId: 'ss-pm#dispatch-1',
    });

    // 4. 子 agent 处理
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({
      messageId: subMsg.id,
      eventType: 'text_delta',
      payload: { delta: '登录页已写完' },
    });
    buf.append({ messageId: subMsg.id, eventType: 'final', payload: {} });
    buf.flush();

    // 5. 子 agent 完成 → task_reply 消息（回传给 PM）
    const replyMsg = insertMessage({
      sessionId: '!room:home',
      sender: '@prog:home',
      eventType: 'io.momo-studio.task_reply',
      body: '登录页已写完',
      source: 'matrix',
    });
    buf.destroy();

    // 6. 验证全链路消息：PM 流式 / dispatch / 子 agent 流式 / task_reply 都在
    const messages = getDb()
      .prepare('SELECT event_type FROM messages WHERE session_id = ? ORDER BY created_at')
      .all('!room:home') as Array<{ event_type: string }>;
    const types = messages.map((m) => m.event_type);
    expect(types).toContain('m.room.message'); // PM + 子 agent 流式
    expect(types).toContain('io.momo-studio.dispatch');
    expect(types).toContain('io.momo-studio.task_reply');

    // 7. 验证子 agent 消息挂在 PM 的 dispatch parent 下（嵌套关系）
    expect(subMsg.parentStreamSessionId).toBe('ss-pm#dispatch-1');

    // 避免 unused 警告
    expect(pmMsg.streamSessionId).toBe('ss-pm');
  });

  it('场景 4：abort → runtime AbortController 触发 → 退出', () => {
    const msg = insertMessage({
      sessionId: '!room:home',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-abort',
      status: 'streaming',
    });

    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: msg.id, eventType: 'text_delta', payload: { delta: '正在' } });
    buf.flush();

    // abort 触发（主进程发 abort IPC）
    // runtime 内 AbortController.abort() → chat loop 抛错 → 只发 status_change:aborted
    // 注意：abort 不发 final（final 语义是正常完成，会把聚合 status 覆盖为 'done'）
    buf.append({
      messageId: msg.id,
      eventType: 'status_change',
      payload: { status: 'aborted' },
    });
    buf.flush();
    buf.destroy();

    // 主进程把 message 状态改为 aborted
    updateMessageStatus(msg.id, 'aborted');

    // 验证 message 表状态（renderer 显示的真相源）
    const updated = getMessageByStreamSessionId('ss-abort');
    expect(updated?.status).toBe('aborted');

    // 验证聚合后的 StreamState 也反映 aborted（status_change 没被 final 覆盖）
    const stream = aggregateEvents(listEventsByMessage(msg.id));
    expect(stream.text).toBe('正在');
    expect(stream.status).toBe('aborted');
  });
});
